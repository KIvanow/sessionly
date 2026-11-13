//! Human-readable terminal output.

use std::fmt::Write;

use crate::session::Session;
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
            CostSource::Recorded => format!("{} (recorded by Claude Code)", usd(cost.total_usd)),
            CostSource::RecordedAndEstimated => format!(
                "{} (one run recorded by Claude Code, the rest estimated)",
                usd(cost.total_usd)
            ),
            CostSource::Estimated => format!(
                "{} (estimated from the transcript; background calls not included)",
                usd(cost.total_usd)
            ),
            CostSource::Partial => format!(
                "{} (partial estimate: {} requests to models without a known price)",
                usd(cost.total_usd),
                s.total_usage().unpriced_requests
            ),
        },
    );
    if cost.unpriced_requests > 0 && cost.source != CostSource::Partial {
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

/// `sessionly show`: one normalized session.
pub fn session(s: &Session) -> String {
    let mut out = String::new();
    let field = |out: &mut String, name: &str, value: String| {
        let _ = writeln!(out, "{name:<10} {value}");
    };
    field(&mut out, "Session", s.session_id.clone());
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
                cost.source.replace('_', " ")
            );
            if let Some(untracked) = cost.untracked_usd.filter(|u| *u >= 0.005) {
                let _ = write!(text, ", {} not visible in the transcript", usd(untracked));
            }
            field(&mut out, "Cost", text);
        }
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

    if !s.prompts.is_empty() {
        out.push_str("\nPrompts\n");
        for p in &s.prompts {
            let time = p.at.map(|t| t.format("%H:%M:%S").to_string());
            let outcome = match p.outcome.as_deref() {
                Some("completed") => String::new(),
                Some(other) => format!("  [{}]", p.error.as_deref().unwrap_or(other)),
                None => "  [no end recorded]".into(),
            };
            let preview: String = p
                .text
                .preview
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
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
            let _ = writeln!(
                out,
                "  {:>6} {:>6}  {}{}",
                format!("+{}", f.lines_added),
                format!("-{}", f.lines_removed),
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
            tools[i].2 += u64::from(call.status != "ok");
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
