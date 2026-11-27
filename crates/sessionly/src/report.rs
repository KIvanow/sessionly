//! Human-readable terminal output.

use std::fmt::Write;

use crate::ledger::OutcomeEvent;
use crate::ledger::{Group, GroupBy, Listed, Rewrite, RewriteRow};
use crate::rewrite::{CHECKPOINTS, REWRITTEN_BELOW};
use crate::session::{
    Outcome, OutcomeCheckpoint, ReviewRan, ReviewVia, RewriteCheckpoint, Session, ToolStatus,
};
use crate::transcript::{CostSource, TranscriptSummary, Usage, UsageByModel};

pub fn transcript(s: &TranscriptSummary) -> String {
    let mut out = String::new();
    let cost = s.cost();
    let field = |out: &mut String, name: &str, value: String| {
        let _ = writeln!(out, "{name:<10} {value}");
    };

    field(
        &mut out,
        "Session",
        s.session_id.clone().unwrap_or_else(|| "?".into()),
    );
    field(&mut out, "Transcript", s.path.display().to_string());
    if let (Some(first), Some(last)) = (s.first_at, s.last_at) {
        field(
            &mut out,
            "Time",
            format!(
                "{} → {} ({})",
                first.format("%Y-%m-%d %H:%M:%SZ"),
                last.format("%H:%M:%SZ"),
                duration(s.duration_ms().unwrap_or(0))
            ),
        );
    }
    let mut context = Vec::new();
    if let Some(b) = &s.git_branch {
        context.push(format!("branch {b}"));
    }
    if let Some(v) = &s.version {
        context.push(format!("Claude Code {v}"));
    }
    if let Some(e) = &s.entrypoint {
        context.push(format!("via {e}"));
    }
    if !context.is_empty() {
        field(&mut out, "Context", context.join(", "));
    }
    field(
        &mut out,
        "Cost",
        match cost.source {
            CostSource::Unknown => usd(cost.total_usd),
            CostSource::Recorded => format!("{} (recorded by Claude Code)", usd(cost.total_usd)),
            CostSource::RecordedAndEstimated => format!(
                "{} (one run recorded by Claude Code, the rest estimated)",
                usd(cost.total_usd)
            ),
            CostSource::Estimated => format!(
                "{} (estimated from the transcript; background calls not included)",
                usd(cost.total_usd)
            ),
            CostSource::PartialEstimate => format!(
                "{} (partial estimate: {} requests to models without a known price)",
                usd(cost.total_usd),
                s.total_usage().unpriced_requests
            ),
        },
    );
    if cost.unpriced_requests > 0 && cost.source != CostSource::PartialEstimate {
        field(
            &mut out,
            "",
            format!(
                "leaves out {} requests to models without a known price",
                cost.unpriced_requests
            ),
        );
    }
    if let Some(untracked) = cost.untracked_usd.filter(|u| *u >= 0.005) {
        field(
            &mut out,
            "",
            format!(
                "includes {} not visible in the transcript (background calls)",
                usd(untracked)
            ),
        );
    }
    if let Some(rec) = &s.recorded {
        if let (Some(added), Some(removed)) = (rec.lines_added, rec.lines_removed) {
            field(&mut out, "Lines", format!("+{added} -{removed}"));
        }
    }

    out.push('\n');
    table(&mut out, "Main thread", &s.main);
    for sub in &s.subagents {
        let mut title = format!("Subagent {}", short(&sub.agent_id));
        if let Some(t) = &sub.agent_type {
            let _ = write!(title, " ({t})");
        }
        if let Some(d) = &sub.description {
            let _ = write!(title, ": {d}");
        }
        table(&mut out, &title, &sub.usage);
    }
    if !s.subagents.is_empty() {
        table(&mut out, "Total", &s.usage_by_model());
    }
    if s.skipped_lines > 0 {
        let _ = writeln!(
            out,
            "({} unreadable transcript lines skipped)",
            s.skipped_lines
        );
    }
    out
}

fn table(out: &mut String, title: &str, usage: &UsageByModel) {
    let rows: Vec<(&String, &Usage)> = usage.iter().filter(|(_, u)| u.requests > 0).collect();
    if rows.is_empty() {
        return;
    }
    let _ = writeln!(out, "{title}");
    let _ = writeln!(
        out,
        "  {:<22} {:>5} {:>9} {:>9} {:>11} {:>11} {:>10}",
        "model", "reqs", "input", "output", "cache read", "cache write", "est. cost"
    );
    for (model, u) in rows {
        let _ = writeln!(
            out,
            "  {:<22} {:>5} {:>9} {:>9} {:>11} {:>11} {:>10}",
            model,
            u.requests,
            tokens(u.input),
            tokens(u.output),
            tokens(u.cache_read),
            tokens(u.cache_write_5m + u.cache_write_1h),
            if u.unpriced_requests == u.requests {
                "-".to_string()
            } else {
                usd(u.cost_usd)
            }
        );
    }
    out.push('\n');
}

fn usd(v: f64) -> String {
    if v < 0.01 && v > 0.0 {
        format!("${v:.4}")
    } else {
        format!("${v:.2}")
    }
}

fn tokens(n: u64) -> String {
    match n {
        0..1_000 => n.to_string(),
        1_000..1_000_000 => format!("{:.1}K", n as f64 / 1e3),
        _ => format!("{:.2}M", n as f64 / 1e6),
    }
}

/// A time span in words, for "… ago".
pub fn age(span: std::time::Duration) -> String {
    duration(span.as_millis() as i64)
}

fn duration(ms: i64) -> String {
    let s = ms / 1000;
    match s {
        0..60 => format!("{s}s"),
        60..3600 => format!("{}m {}s", s / 60, s % 60),
        _ => format!("{}h {}m", s / 3600, (s % 3600) / 60),
    }
}

fn short(id: &str) -> &str {
    match id.char_indices().nth(8) {
        Some((end, _)) => &id[..end],
        None => id,
    }
}

/// What was still there at each fixed age after the session ended:
/// `1d 96%, 7d 91% (taken on day 9), 30d -`. An age not reached, or not
/// measured, is a dash; one measured a day or more late says when.
fn kept_at(checkpoints: &[RewriteCheckpoint]) -> String {
    CHECKPOINTS
        .iter()
        .map(|(name, seconds)| {
            let Some(c) = checkpoints.iter().find(|c| c.checkpoint == *name) else {
                return format!("{name} -");
            };
            let share = (c.added > 0).then(|| c.surviving as f64 / c.added as f64);
            let late = c.age_seconds as i64 >= seconds + 86_400;
            if late {
                let day = c.age_seconds / 86_400;
                format!("{name} {} (taken on day {day})", percent(share))
            } else {
                format!("{name} {}", percent(share))
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// What later commits did to the session's lines at each fixed age:
/// `1d nothing, 7d changed by 2 fixes (1 likely), 30d -`. An age not reached,
/// or not counted yet, is a dash; one counted a day or more late says when.
fn later_at(outcomes: &[OutcomeCheckpoint]) -> String {
    CHECKPOINTS
        .iter()
        .map(|(name, _)| {
            let Some(o) = outcomes.iter().find(|o| o.checkpoint == *name) else {
                return format!("{name} -");
            };
            let mut parts: Vec<String> = Vec::new();
            if o.revert_commits > 0 {
                parts.push(if o.relanded {
                    "reverted and relanded".into()
                } else {
                    "reverted".into()
                });
            }
            if o.fix_commits > 0 {
                let likely = if o.likely_fix_commits > 0 {
                    format!(" ({} likely)", o.likely_fix_commits)
                } else {
                    String::new()
                };
                parts.push(format!(
                    "changed by {} fix{}{likely}",
                    o.fix_commits,
                    if o.fix_commits == 1 { "" } else { "es" }
                ));
            }
            if o.rework_commits > 0 {
                parts.push(format!("reworked {}x", o.rework_commits));
            }
            let what = if parts.is_empty() {
                "nothing".to_string()
            } else {
                parts.join(", ")
            };
            if o.late {
                format!("{name} {what} (taken on day {})", o.age_seconds / 86_400)
            } else {
                format!("{name} {what}")
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `sessionly show`: one normalized session, with the latest rewrite
/// measurement of its changed files, what it was at fixed ages, and what
/// later commits did to it.
pub fn session(
    s: &Session,
    rewrite: &[RewriteRow],
    measured_at: Option<&str>,
    checkpoints: &[RewriteCheckpoint],
    outcomes: &[OutcomeCheckpoint],
) -> String {
    let mut out = String::new();
    let field = |out: &mut String, name: &str, value: String| {
        let _ = writeln!(out, "{name:<10} {value}");
    };
    field(&mut out, "Session", s.session_id.clone());
    field(&mut out, "Tool", tool_name(&s.source).to_string());
    if let Some(title) = &s.title {
        field(&mut out, "Title", title.clone());
    }
    if let Some(user) = &s.user {
        let who = [user.name.as_deref(), user.email.as_deref()];
        field(
            &mut out,
            "User",
            who.iter().flatten().copied().collect::<Vec<_>>().join(", "),
        );
    }
    if let Some(runtime) = &s.runtime {
        let mut text = "the cloud".to_string();
        if let Some(id) = &runtime.id {
            let _ = write!(text, " ({id})");
        }
        if let Some(from) = &s.entrypoint {
            let _ = write!(text, ", started from {from}");
        }
        field(&mut out, "Ran in", text);
    }
    let root = s.repo.as_ref().map(|r| r.root.as_str());
    match &s.repo {
        Some(repo) => {
            let mut text = repo.remote.clone().unwrap_or_else(|| repo.root.clone());
            if let Some(branch) = &repo.branch {
                let _ = write!(text, " ({branch})");
            }
            field(&mut out, "Repo", text);
        }
        None => field(&mut out, "Directory", s.cwd.clone().unwrap_or_default()),
    }
    if let (Some(start), Some(end)) = (s.started_at, s.ended_at) {
        let mut text = format!(
            "{} → {} ({} elapsed, {} active)",
            start.format("%Y-%m-%d %H:%M:%SZ"),
            end.format("%H:%M:%SZ"),
            duration(s.duration_ms.unwrap_or(0)),
            duration(s.active_ms)
        );
        if s.end_reason.is_none() {
            text.push_str(", not ended");
        }
        field(&mut out, "Time", text);
    }
    if !s.models.is_empty() {
        field(&mut out, "Models", s.models.join(", "));
    }
    match &s.cost {
        Some(cost) => {
            let mut text = format!(
                "{} ({})",
                usd(cost.total_usd),
                cost.source.as_str().replace('_', " ")
            );
            if let Some(untracked) = cost.untracked_usd.filter(|u| *u >= 0.005) {
                let _ = write!(text, ", {} not visible in the transcript", usd(untracked));
            }
            field(&mut out, "Cost", text);
        }
        None if s.source == crate::paths::CURSOR && s.runtime.is_some() => field(
            &mut out,
            "Cost",
            "unknown (Cursor's cloud agents do not report usage to hooks)".into(),
        ),
        None if s.source == crate::paths::CURSOR => field(
            &mut out,
            "Cost",
            "unknown (Cursor reports usage to hooks when a turn ends, and they saw no turn of this session end)"
                .into(),
        ),
        None if s.source == crate::paths::CODEX || s.source == crate::paths::OPENCODE => field(
            &mut out,
            "Cost",
            "unknown (no tokens on a model with a known price)".into(),
        ),
        None => field(&mut out, "Cost", "unknown (no transcript found)".into()),
    }
    if let Some(n) = s
        .cost
        .as_ref()
        .map(|c| c.unpriced_requests)
        .filter(|n| *n > 0)
    {
        field(
            &mut out,
            "",
            format!("leaves out {n} requests to models without a known price"),
        );
    }
    if let Some(n) = s.cost.as_ref().and_then(|c| c.prompts_covered) {
        field(
            &mut out,
            "",
            format!(
                "covers {n} of {} prompts: the ones the hooks saw",
                s.prompts.len()
            ),
        );
    }
    if s.cost.is_some() && s.source == crate::paths::CURSOR {
        field(
            &mut out,
            "",
            "tokens at API list prices, not what Cursor bills".into(),
        );
    }
    if !s.captured_from_start {
        field(
            &mut out,
            "Note",
            "capture began partway through; prompts, tools and files cover the captured part only"
                .into(),
        );
    }
    let c = &s.counts;
    field(
        &mut out,
        "Activity",
        format!(
            "{} prompts, {} tool calls ({} failed), {} subagents, {} permission requests",
            c.prompts, c.tool_calls, c.tool_failures, c.subagents, c.permission_requests
        ),
    );
    field(
        &mut out,
        "Files",
        format!(
            "{} changed (+{} -{}), {} read",
            c.files_changed, c.lines_added, c.lines_removed, c.files_read
        ),
    );

    if !rewrite.is_empty() {
        let total = Rewrite {
            files_measured: rewrite.len() as u64,
            files_rewritten: rewrite.iter().filter(|r| is_rewritten(r)).count() as u64,
            lines_added: rewrite.iter().map(|r| r.added).sum(),
            lines_surviving: rewrite.iter().map(|r| r.surviving).sum(),
        };
        let mut text = format!(
            "{} of {} changed files rewritten since; {} of {} added lines still there",
            total.files_rewritten,
            total.files_measured,
            percent(total.line_survival()),
            total.lines_added
        );
        let checkout = rewrite.iter().find_map(|r| r.branch.as_deref());
        let mut details: Vec<String> = Vec::new();
        details.extend(measured_at.map(|t| format!("measured {}", minute(t))));
        details.extend(checkout.map(|b| format!("on {b}")));
        if !details.is_empty() {
            let _ = write!(text, " ({})", details.join(" "));
        }
        field(&mut out, "Rewrite", text);
        let session_branch = s.repo.as_ref().and_then(|r| r.branch.as_deref());
        if let (Some(then), Some(now)) = (session_branch, checkout) {
            if then != now && then != "HEAD" {
                field(
                    &mut out,
                    "",
                    format!(
                        "the session ran on {then}; files were compared as checked out on {now}"
                    ),
                );
            }
        }
    }

    // Kept through a rebuild of the ledger, and when the files are gone: said
    // whether or not there is a latest measurement above.
    if !checkpoints.is_empty() {
        field(
            &mut out,
            if rewrite.is_empty() { "Rewrite" } else { "" },
            format!("still there after it ended: {}", kept_at(checkpoints)),
        );
    }
    if !outcomes.is_empty() {
        field(
            &mut out,
            "Later",
            format!(
                "{} (sessionly outcomes {})",
                later_at(outcomes),
                short(&s.session_id)
            ),
        );
    }

    if !s.prompts.is_empty() {
        out.push_str("\nPrompts\n");
        for p in &s.prompts {
            let time = p.at.map(|t| t.format("%H:%M:%S").to_string());
            let outcome = match p.outcome {
                Some(Outcome::Completed) => String::new(),
                Some(_) => format!("  [{}]", p.error.as_deref().unwrap_or("api error")),
                // Cursor records the end of only some turns: its absence says nothing.
                None if s.source == crate::paths::CURSOR => String::new(),
                None => "  [no end recorded]".into(),
            };
            let preview: String = p
                .text
                .preview
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            // A cloud agent's first prompt may never reach a hook.
            let preview = if preview.is_empty() && !s.captured_from_start {
                "(prompt not captured)".to_string()
            } else {
                preview
            };
            let _ = writeln!(
                out,
                "  {}  {}{}",
                time.as_deref().unwrap_or("        "),
                clip(&preview, 96),
                outcome
            );
        }
    }

    let changed: Vec<_> = s.files.iter().filter(|f| f.writes > 0).collect();
    if !changed.is_empty() {
        out.push_str("\nFiles changed\n");
        for f in changed {
            let kept = match rewrite.iter().find(|r| r.path == f.path) {
                Some(r) if !r.file_exists => "deleted".to_string(),
                Some(r) => format!(
                    "kept {}",
                    percent(Some(r.surviving as f64 / r.added as f64))
                ),
                None => String::new(),
            };
            let _ = writeln!(
                out,
                "  {:>6} {:>6}  {:<9}  {}{}",
                format!("+{}", f.lines_added),
                format!("-{}", f.lines_removed),
                kept,
                relative(&f.path, root),
                if f.created { "  (new)" } else { "" }
            );
        }
    }

    if !s.tool_calls.is_empty() {
        let mut tools: Vec<(&str, u64, u64)> = Vec::new();
        for call in &s.tool_calls {
            let i = match tools.iter().position(|t| t.0 == call.tool) {
                Some(i) => i,
                None => {
                    tools.push((&call.tool, 0, 0));
                    tools.len() - 1
                }
            };
            tools[i].1 += 1;
            tools[i].2 += u64::from(call.status != ToolStatus::Ok);
        }
        tools.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        out.push_str("\nTools\n");
        for (tool, calls, not_ok) in tools {
            let note = if not_ok > 0 {
                format!("  ({not_ok} without a successful result)")
            } else {
                String::new()
            };
            let _ = writeln!(out, "  {calls:>5}  {tool}{note}");
        }
    }

    if !s.reviews.is_empty() {
        out.push_str("\nReviews\n");
        for run in &s.reviews {
            let mut command = format!("/{}", run.command);
            if let Some(effort) = &run.effort {
                let _ = write!(command, " {effort}");
            }
            if let Some(n) = run.pull_number {
                let _ = write!(command, " #{n}");
            }
            let mut notes: Vec<String> = Vec::new();
            if run.ran == ReviewRan::Cloud {
                notes.push("in the cloud".into());
            }
            if run.via == ReviewVia::Skill {
                notes.push("as a skill".into());
            }
            if let Some(target) = &run.target {
                notes.push(format!("of {}", target.replace('_', " ")));
            }
            if let Some(agent) = &run.agent_id {
                notes.push(format!("by subagent {}", short(agent)));
            }
            if let Some(n) = run.findings {
                notes.push(format!("{n} findings"));
            }
            if !matches!(run.status, ToolStatus::Ok) {
                notes.push(format!("{:?}", run.status).to_lowercase());
            }
            let cost = match (run.estimated_cost_usd, run.ran) {
                (Some(cost), _) => usd(cost),
                (None, ReviewRan::Cloud) => "not known".into(),
                (None, _) => "-".into(),
            };
            let _ = writeln!(
                out,
                "  {}  {:<28} {:>2} subagents  {:>9}  {:>8}  {}",
                run.at
                    .map(|t| t.format("%m-%d %H:%M").to_string())
                    .unwrap_or_else(|| "           ".into()),
                clip(&command, 28),
                run.subagents,
                cost,
                run.duration_ms
                    .map(|ms| duration(ms as i64))
                    .unwrap_or_else(|| "-".into()),
                notes.join(", ")
            );
        }
        if s.reviews.iter().any(|r| r.estimated_cost_usd.is_some()) {
            out.push_str("  (cost: the review's subagents only, part of the session's cost)\n");
        }
    }

    if !s.subagents.is_empty() {
        out.push_str("\nSubagents\n");
        for sub in &s.subagents {
            let _ = writeln!(
                out,
                "  {}  {:<16} {:>3} tool calls  {:>8}  {}",
                short(&sub.agent_id),
                sub.agent_type.as_deref().unwrap_or("-"),
                sub.tool_calls,
                sub.estimated_cost_usd
                    .map(usd)
                    .unwrap_or_else(|| "-".into()),
                clip(sub.description.as_deref().unwrap_or(""), 50)
            );
        }
    }
    out
}

/// `text` in at most `width` characters, shortened with an ellipsis if needed.
fn fit(text: &str, width: usize) -> String {
    if text.chars().count() <= width {
        text.to_string()
    } else {
        clip(text, width.saturating_sub(1))
    }
}

fn clip(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

fn relative<'a>(path: &'a str, root: Option<&str>) -> &'a str {
    root.and_then(|r| path.strip_prefix(r))
        .map(|p| p.trim_start_matches('/'))
        .filter(|p| !p.is_empty())
        .unwrap_or(path)
}

fn is_rewritten(r: &RewriteRow) -> bool {
    r.added > 0 && (r.surviving as f64 / r.added as f64) < REWRITTEN_BELOW
}

fn percent(share: Option<f64>) -> String {
    match share {
        Some(share) => format!("{:.0}%", share * 100.0),
        None => "-".into(),
    }
}

/// `2026-11-13T17:39:42+00:00` as `2026-11-13 17:39`.
fn minute(timestamp: &str) -> String {
    timestamp
        .chars()
        .take(16)
        .collect::<String>()
        .replace('T', " ")
}

/// The short name of a repository: `owner/name` of a remote, or the last
/// two directories of a path (one is too often the same for two projects).
fn repo_name(repo: &str) -> String {
    let parts: Vec<&str> = repo.split('/').filter(|p| !p.is_empty()).collect();
    match parts.as_slice() {
        [] => repo.to_string(),
        [.., owner, name] => format!("{owner}/{name}"),
        [name] => name.to_string(),
    }
}

/// Active time, or a dash where none was recorded (Cursor records no times
/// a turn's length could be taken from).
fn active(ms: i64) -> String {
    if ms <= 0 {
        "-".into()
    } else {
        duration(ms)
    }
}

/// An agent's name as people write it.
pub fn tool_name(source: &str) -> &str {
    match source {
        "claude-code" => "Claude Code",
        "cursor" => "Cursor",
        "grok" => "Grok",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        other => other,
    }
}

/// `sessionly list`.
pub fn list(rows: &[Listed], limit: u64) -> String {
    if rows.is_empty() {
        return "No sessions match.\n".into();
    }
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{:<8}  {:<11}  {:<16}  {:>7}  {:>8}  {:>5}  {:>12}  {:>9}  {:<22}  PROMPT",
        "ID", "TOOL", "STARTED (UTC)", "ACTIVE", "COST", "FILES", "LINES", "REWRITTEN", "REPO"
    );
    for r in rows {
        let cost = match (r.cost_usd, r.cost_source.as_deref()) {
            (Some(cost), Some("recorded")) => usd(cost),
            // anything not fully recorded is an estimate, or part of one
            (Some(cost), _) => format!("~{}", usd(cost)),
            (None, _) => "-".into(),
        };
        let rewritten = if r.rewrite.files_measured > 0 {
            format!("{}/{}", r.rewrite.files_rewritten, r.rewrite.files_measured)
        } else {
            "-".into()
        };
        let prompt = r
            .title
            .as_deref()
            .or(r.first_prompt.as_deref())
            .unwrap_or("");
        let prompt: String = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
        let _ = writeln!(
            out,
            "{:<8}  {:<11}  {:<16}  {:>7}  {:>8}  {:>5}  {:>12}  {:>9}  {:<22}  {}",
            short(&r.session_id),
            tool_name(&r.source),
            r.started_at.as_deref().map(minute).unwrap_or_default(),
            active(r.active_ms),
            cost,
            r.files_changed,
            format!("+{} -{}", r.lines_added, r.lines_removed),
            rewritten,
            fit(&r.repo.as_deref().map(repo_name).unwrap_or_default(), 22),
            clip(&prompt, 60)
        );
    }
    if rows.len() as u64 == limit {
        let _ = writeln!(out, "(showing the newest {limit}; use --limit for more)");
    }
    out
}

/// `sessionly summary`.
pub fn summary(groups: &[Group], by: GroupBy) -> String {
    if groups.is_empty() {
        return "No sessions match.\n".into();
    }
    let heading = match by {
        GroupBy::Tool => "TOOL",
        GroupBy::User => "USER",
        GroupBy::Repo => "REPO",
        GroupBy::Model => "MODEL",
        GroupBy::Day => "DAY (UTC)",
    };
    let label = |g: &Group| match by {
        GroupBy::Repo if g.key != "total" => repo_name(&g.key),
        GroupBy::Tool => tool_name(&g.key).to_string(),
        _ => g.key.clone(),
    };
    let width = groups
        .iter()
        .map(|g| label(g).chars().count())
        .max()
        .unwrap_or(0)
        .clamp(heading.len(), 40);
    // Shown only where a session in the filter has a review run.
    let reviews = groups.iter().any(|g| g.reviews > 0);
    let reviews_column = |text: String| {
        if reviews {
            format!("  {text:>7}")
        } else {
            String::new()
        }
    };
    // Shown only where a session in the filter has an age counted.
    let outcomes = groups.iter().any(|g| g.outcomes.reached_7d > 0);
    let of = |n: u64, total: u64| {
        if total == 0 {
            "-".to_string()
        } else {
            format!("{n}/{total}")
        }
    };
    let outcomes_columns = |fixed: String, reverted: String| {
        if outcomes {
            format!("  {fixed:>9}  {reverted:>12}")
        } else {
            String::new()
        }
    };
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{:<width$}  {:>8}  {:>9}  {:>8}  {:>7}  {:>14}  {:>5}  {:>14}  {:>13}  {:>10}{}{}",
        heading,
        "SESSIONS",
        "COST",
        "ACTIVE",
        "PROMPTS",
        "TOOLS (FAILED)",
        "FILES",
        "LINES",
        "REWRITTEN",
        "LINES KEPT",
        reviews_column("REVIEWS".into()),
        outcomes_columns("FIX@7D".into(), "REVERTED@30D".into())
    );
    let mut without_cost = 0;
    for g in groups {
        if g.key == "total" {
            let _ = writeln!(
                out,
                "{}",
                "-".repeat(
                    width + 106 + if reviews { 9 } else { 0 } + if outcomes { 25 } else { 0 }
                )
            );
            without_cost = g.sessions_without_cost;
        }
        let rewritten = match g.rewrite.rate() {
            Some(rate) => format!(
                "{}/{} ({:.0}%)",
                g.rewrite.files_rewritten,
                g.rewrite.files_measured,
                rate * 100.0
            ),
            None => "-".into(),
        };
        let _ = writeln!(
            out,
            "{:<width$}  {:>8}  {:>9}  {:>8}  {:>7}  {:>14}  {:>5}  {:>14}  {:>13}  {:>10}{}{}",
            fit(&label(g), width),
            g.sessions,
            if g.sessions_without_cost == g.sessions && g.sessions > 0 {
                "-".into()
            } else {
                usd(g.cost_usd)
            },
            active(g.active_ms),
            g.prompts,
            format!("{} ({})", g.tool_calls, g.tool_failures),
            g.files_changed,
            format!("+{} -{}", g.lines_added, g.lines_removed),
            rewritten,
            percent(g.rewrite.line_survival()),
            reviews_column(g.reviews.to_string()),
            outcomes_columns(
                of(g.outcomes.fixed_7d, g.outcomes.reached_7d),
                of(g.outcomes.reverted_30d, g.outcomes.reached_30d)
            )
        );
    }
    if without_cost > 0 {
        let _ = writeln!(
            out,
            "({without_cost} sessions have no cost figure and add nothing to COST)"
        );
    }
    if outcomes {
        let _ = writeln!(
            out,
            "(FIX@7D: sessions whose lines a later fix commit changed within 7 days, of those 7 days old; \
             mostly the fix was of something else. REVERTED@30D: reverted within 30 days and not relanded.)"
        );
    }
    out
}

/// `sessionly outcomes`: the later commits that touched a session's lines,
/// and the counts at fixed ages.
pub fn outcomes(s: &Session, events: &[OutcomeEvent], kept: &[OutcomeCheckpoint]) -> String {
    let mut out = String::new();
    let _ = writeln!(out, "Session    {}", s.session_id);
    if let Some(ended) = s.ended_at {
        let _ = writeln!(out, "Ended      {}", minute(&ended.to_rfc3339()));
    }
    let _ = writeln!(out, "Later      {}", later_at(kept));
    if events.is_empty() {
        let _ = writeln!(
            out,
            "\nNo later commit has changed two or more of its lines{}.",
            if kept.is_empty() { " yet" } else { "" }
        );
        return out;
    }
    let _ = writeln!(
        out,
        "\n{:<9}  {:<16}  {:<6}  {:>7}  {:<26}  {:<20}  SUBJECT",
        "COMMIT", "DATE", "KIND", "LINES", "SIGNALS", "BY"
    );
    for e in events {
        let kind = match e.kind.as_str() {
            "fix" if e.strength >= crate::outcomes::LIKELY_FIX => "fix*",
            kind => kind,
        };
        let lines = if e.lines.fract() == 0.0 {
            format!("{}", e.lines)
        } else {
            format!("{:.1}", e.lines)
        };
        let mut subject = e.subject.clone();
        if let Some(at) = e.relanded_at {
            let _ = write!(subject, " (relanded {})", at.format("%Y-%m-%d"));
        }
        // Another agent session's own commit: its agent, and which session.
        let by = match (&e.by_source, &e.by_session) {
            (Some(source), Some(id)) => {
                format!("{source} {}", id.chars().take(8).collect::<String>())
            }
            _ => "-".to_string(),
        };
        let _ = writeln!(
            out,
            "{:<9}  {:<16}  {:<6}  {:>7}  {:<26}  {:<20}  {}",
            e.sha.chars().take(9).collect::<String>(),
            e.at.format("%Y-%m-%d %H:%M"),
            kind,
            lines,
            fit(&e.signals.join(","), 26),
            fit(&by, 20),
            fit(&subject, 72)
        );
    }
    let _ = writeln!(
        out,
        "\nA fix here changed the session's lines; mostly it fixed something else. \
         fix* is a likely fix: at least half of what it removed was the session's. \
         BY is the agent session on this machine whose own commit it was."
    );
    out
}

/// `sessionly license status`: the server's answer in words.
pub fn license(server: &str, state: &serde_json::Value) -> String {
    let mut out = String::new();
    let field = |out: &mut String, name: &str, value: String| {
        let _ = writeln!(out, "{name:<10} {value}");
    };
    let day = |v: &serde_json::Value| {
        v.as_str()
            .map_or("?".to_string(), |t| t.chars().take(10).collect())
    };
    field(&mut out, "Server", server.to_string());
    field(
        &mut out,
        "Org",
        state["org"]
            .as_str()
            .map_or("not set (SESSIONLY_ORG)".into(), String::from),
    );
    let l = &state["license"];
    let status = state["status"].as_str().unwrap_or("missing");
    let text = match status {
        "active" => format!("active until {}", day(&l["expiresAt"])),
        "grace" => format!(
            "expired on {}; its features turn read-only on {}",
            day(&l["expiresAt"]),
            day(&state["readOnlyAt"])
        ),
        "expired" => format!(
            "expired on {}; its features have been read-only since {}",
            day(&l["expiresAt"]),
            day(&state["readOnlyAt"])
        ),
        _ => "none installed (core features only)".to_string(),
    };
    field(&mut out, "License", text);
    if l.is_object() {
        field(
            &mut out,
            "Edition",
            format!(
                "{}, {} seats ({} people have access now)",
                l["edition"].as_str().unwrap_or("?"),
                l["seats"].as_u64().unwrap_or(0),
                state["people"].as_u64().unwrap_or(0)
            ),
        );
        let features: Vec<&str> = l["features"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| f.as_str())
            .collect();
        field(
            &mut out,
            "Features",
            if features.is_empty() {
                "none".into()
            } else {
                features.join(", ")
            },
        );
        field(&mut out, "Id", l["id"].as_str().unwrap_or("?").to_string());
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn checkpoints_are_shown_with_or_without_a_latest_measurement() {
        use super::{session, RewriteCheckpoint, RewriteRow, Session};
        let day = 86_400;
        let at = |name: &str, surviving, age_seconds| RewriteCheckpoint {
            checkpoint: name.into(),
            added: 16,
            surviving,
            measured_at: None,
            age_seconds,
            ended_at: None,
        };
        let kept = [at("1d", 14, day + 60), at("7d", 5, 9 * day)];
        let line = "still there after it ended: 1d 88%, 7d 31% (taken on day 9), 30d -";
        // The ledger was rebuilt and the files are gone: the checkpoints are what is left.
        let alone = session(&Session::default(), &[], None, &kept, &[]);
        assert!(alone.contains(&format!("Rewrite    {line}")), "{alone}");
        assert!(!session(&Session::default(), &[], None, &[], &[]).contains("still there"));
        let row = RewriteRow {
            session_id: "s".into(),
            path: "a.rs".into(),
            added: 16,
            surviving: 3,
            file_exists: true,
            branch: None,
            head: None,
        };
        let both = session(&Session::default(), &[row], None, &kept, &[]);
        assert!(both.contains("added lines still there"), "{both}");
        assert!(both.contains(&format!("           {line}")), "{both}");
    }

    #[test]
    fn describes_license_states() {
        let state = |status: &str| {
            serde_json::json!({
                "status": status, "org": "acme", "people": 3,
                "readOnlyAt": "2027-01-15T00:00:00.000Z",
                "license": { "id": "lic_1", "edition": "business", "seats": 25,
                             "features": ["content_policy"], "expiresAt": "2027-01-01T00:00:00.000Z" }
            })
        };
        let active = license("https://s.example", &state("active"));
        assert!(active.contains("active until 2027-01-01"), "{active}");
        assert!(active.contains("business, 25 seats (3 people have access now)"));
        assert!(active.contains("content_policy"));
        assert!(license("s", &state("grace")).contains("turn read-only on 2027-01-15"));
        assert!(license("s", &state("expired")).contains("read-only since 2027-01-15"));
        let none = license(
            "s",
            &serde_json::json!({ "status": "missing", "license": null, "org": null }),
        );
        assert!(none.contains("none installed") && none.contains("not set (SESSIONLY_ORG)"));
        assert!(!none.contains("Edition"));
    }

    use super::*;

    #[test]
    fn fits_text_into_a_column() {
        assert_eq!(fit("exactly-10", 10), "exactly-10");
        assert_eq!(fit("eleven-char", 10), "eleven-ch…");
        assert_eq!(fit("ünïcödé-text", 8).chars().count(), 8);
    }

    #[test]
    fn names_repositories_briefly() {
        assert_eq!(
            repo_name("github.com/KIvanow/sessionly"),
            "KIvanow/sessionly"
        );
        assert_eq!(repo_name("/home/me/code/thing"), "code/thing");
        assert_eq!(repo_name("/thing"), "thing");
        assert_eq!(repo_name("solo"), "solo");
        assert_eq!(repo_name(""), "");
    }

    #[test]
    fn formats_small_values() {
        assert_eq!(percent(Some(0.126)), "13%");
        assert_eq!(percent(None), "-");
        assert_eq!(minute("2026-11-13T17:39:42+00:00"), "2026-11-13 17:39");
        assert_eq!(short("abcdefghij"), "abcdefgh");
        assert_eq!(short("abc"), "abc");
    }
}
