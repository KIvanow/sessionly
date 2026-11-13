//! Human-readable terminal output.

use std::fmt::Write;

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
                "{} (latest run recorded by Claude Code, earlier runs estimated)",
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
    if cost.untracked_usd >= 0.005 {
        field(
            &mut out,
            "",
            format!(
                "includes {} not visible in the transcript (background calls)",
                usd(cost.untracked_usd)
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
    &id[..id.len().min(8)]
}
