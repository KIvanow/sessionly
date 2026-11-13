use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use clap::{Args, Parser, Subcommand};

mod capture;
mod config;
mod git;
mod hooks;
mod jsonl;
mod ledger;
mod normalize;
mod paths;
mod pricing;
mod report;
mod rewrite;
mod session;
mod sync;
mod transcript;
mod upload;
mod watch;

#[derive(Parser)]
#[command(
    name = "sessionly",
    version,
    about = "Ledger of AI coding agent sessions"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Add the capture hooks to Claude Code settings
    Install(Target),
    /// Remove the capture hooks from Claude Code settings
    Uninstall(Target),
    /// Show whether the hooks are installed and how much has been captured
    Status(Target),
    /// Pretty-print hook events as they arrive
    Watch,
    /// Normalize captured sessions into the local ledger
    Sync {
        /// Rebuild every session, not only the ones that changed
        #[arg(long)]
        force: bool,
    },
    /// List sessions, newest first
    List {
        #[command(flatten)]
        filter: FilterArgs,
        /// Show at most this many sessions
        #[arg(long, short = 'n', default_value_t = 30)]
        limit: u64,
        /// Print JSON instead of a table
        #[arg(long)]
        json: bool,
    },
    /// Totals per user, repository, model or day
    Summary {
        #[command(flatten)]
        filter: FilterArgs,
        /// What to group sessions by
        #[arg(long, value_enum, default_value = "user")]
        by: ledger::GroupBy,
        /// Print JSON instead of a table
        #[arg(long)]
        json: bool,
    },
    /// Show one session from the ledger
    Show {
        /// Session id or a unique prefix of one
        session: String,
        /// Print the full session record as JSON
        #[arg(long)]
        json: bool,
    },
    /// Show tokens, cost, models and timing from a session transcript
    Transcript {
        /// Session id, or a path to a transcript .jsonl file
        session: String,
        /// Print JSON instead of a table
        #[arg(long)]
        json: bool,
    },
    /// Print exactly what would be uploaded for a session
    Export {
        /// Session id or a unique prefix of one
        session: String,
        /// How much content to include [default: the configured level, normally metadata]
        #[arg(long, value_enum)]
        content: Option<session::Content>,
    },
    /// Print the JSON Schema of the session record, or of the upload payload
    Schema {
        #[arg(value_enum, default_value = "session")]
        which: SchemaKind,
    },
    /// Hook entry point: read one payload on stdin and store it (used by Claude Code)
    Capture,
}

#[derive(Clone, Copy, clap::ValueEnum)]
enum SchemaKind {
    Session,
    Upload,
}

#[derive(Args)]
struct Target {
    /// Use <DIR>/.claude/settings.json instead of ~/.claude/settings.json
    #[arg(long, value_name = "DIR")]
    project: Option<PathBuf>,
}

/// Which sessions to include. Text filters match substrings, ignoring case.
#[derive(Args)]
struct FilterArgs {
    /// Repository: part of its remote (owner/name) or its path
    #[arg(long)]
    repo: Option<String>,
    /// User: part of the git name or email
    #[arg(long)]
    user: Option<String>,
    /// Model: part of a model name, e.g. "opus"
    #[arg(long)]
    model: Option<String>,
    /// File: part of the path of a file the session read or changed
    #[arg(long)]
    file: Option<String>,
    /// Text in prompts, titles, shell commands, search patterns or file paths
    #[arg(long, short = 's')]
    search: Option<String>,
    /// Started at or after: a date (2026-11-01), a time (RFC 3339) or an age (7d, 12h, 2w)
    #[arg(long, value_parser = parse_time)]
    since: Option<DateTime<Utc>>,
    /// Started before: same forms as --since
    #[arg(long, value_parser = parse_time)]
    until: Option<DateTime<Utc>>,
    /// Cost of at least this many dollars
    #[arg(long, value_name = "USD")]
    min_cost: Option<f64>,
}

impl From<FilterArgs> for ledger::Filter {
    fn from(a: FilterArgs) -> Self {
        ledger::Filter {
            repo: a.repo,
            user: a.user,
            model: a.model,
            file: a.file,
            text: a.search,
            since: a.since,
            until: a.until,
            min_cost: a.min_cost,
        }
    }
}

/// A date, an RFC 3339 time, or an age such as `7d` counted back from now.
fn parse_time(text: &str) -> Result<DateTime<Utc>> {
    let text = text.trim();
    if let Ok(time) = DateTime::parse_from_rfc3339(text) {
        return Ok(time.with_timezone(&Utc));
    }
    if let Ok(date) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Ok(date.and_hms_opt(0, 0, 0).unwrap().and_utc());
    }
    let age = text.char_indices().last().and_then(|(i, unit)| {
        let n: i64 = text[..i].parse().ok().filter(|n| *n >= 0)?;
        match unit {
            'h' => Duration::try_hours(n),
            'd' => Duration::try_days(n),
            'w' => Duration::try_weeks(n),
            _ => None,
        }
    });
    match age {
        Some(age) => Ok(Utc::now() - age),
        None => {
            bail!("expected a date (2026-11-01), an RFC 3339 time, or an age like 7d, 12h or 2w")
        }
    }
}

impl Target {
    fn settings_path(&self) -> Result<PathBuf> {
        let project = self
            .project
            .as_deref()
            .map(|p| std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf()));
        hooks::settings_path(project.as_deref())
    }
}

fn main() -> ExitCode {
    // The hook path is handled before any argument parsing: whatever follows
    // `capture`, it must stay silent and exit 0.
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "capture")
    {
        return ExitCode::from(capture::run() as u8);
    }
    let cli = Cli::parse();
    // Exit quietly when output is piped into something that stops reading
    // (`sessionly show … | head`), instead of panicking on a closed pipe.
    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    match run(cli.command) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(command: Command) -> Result<()> {
    match command {
        Command::Install(target) => {
            let path = target.settings_path()?;
            let exe = std::env::current_exe().context("locating the sessionly binary")?;
            let changed = hooks::install(&path, &hooks::capture_command(&exe))?;
            println!(
                "{} for {} events in {}",
                if changed {
                    "Installed Sessionly hooks"
                } else {
                    "Sessionly hooks already installed"
                },
                hooks::all_events().count(),
                path.display()
            );
            println!(
                "Raw payloads will be written to {}",
                paths::claude_raw_dir()?.display()
            );
            println!("The hooks run {}", exe.display());
            if target.project.is_some() {
                println!(
                    "Note: that path is specific to this machine. If this settings file is \
                     committed, use .claude/settings.local.json for the hooks instead."
                );
            }
        }
        Command::Uninstall(target) => {
            let path = target.settings_path()?;
            if hooks::uninstall(&path)? {
                println!("Removed Sessionly hooks from {}", path.display());
            } else {
                println!("No Sessionly hooks in {}", path.display());
            }
        }
        Command::Status(target) => status(&target)?,
        Command::Watch => watch::run(&paths::claude_raw_dir()?)?,
        Command::Sync { force } => {
            let mut ledger = ledger::Ledger::open(&paths::ledger_path()?)?;
            let (report, rewrite) = sync_ledger(&mut ledger, force)?;
            println!(
                "Synced: {} updated, {} unchanged, {} without usable events",
                report.synced, report.unchanged, report.empty
            );
            if report.removed > 0 {
                println!(
                    "Removed: {} sessions whose capture no longer exists",
                    report.removed
                );
            }
            println!(
                "Rewrite: {} changed files measured, {} in directories that no longer exist",
                rewrite.measured, rewrite.unavailable
            );
            println!(
                "Ledger: {} sessions in {}",
                ledger.count()?,
                paths::ledger_path()?.display()
            );
        }
        Command::Show { session, json } => {
            // Always show current data: pick up anything captured since the last sync.
            let mut ledger = ledger::Ledger::open(&paths::ledger_path()?)?;
            sync_ledger(&mut ledger, false)?;
            let record = ledger.get(&session)?.with_context(|| {
                format!(
                    "no session matching \"{session}\" in the ledger \
                     (only sessions captured by the hooks are stored)"
                )
            })?;
            if json {
                println!("{}", serde_json::to_string_pretty(&record)?);
            } else {
                let (files, measured_at) = ledger.rewrite_of(&record.session_id)?;
                print!(
                    "{}",
                    report::session(&record, &files, measured_at.as_deref())
                );
            }
        }
        Command::List {
            filter,
            limit,
            json,
        } => {
            let mut ledger = ledger::Ledger::open(&paths::ledger_path()?)?;
            sync_ledger(&mut ledger, false)?;
            let rows = ledger.list(&filter.into(), Some(limit))?;
            if json {
                println!("{}", serde_json::to_string_pretty(&rows)?);
            } else {
                print!("{}", report::list(&rows, limit));
            }
        }
        Command::Summary { filter, by, json } => {
            let mut ledger = ledger::Ledger::open(&paths::ledger_path()?)?;
            sync_ledger(&mut ledger, false)?;
            let groups = ledger.summary(&filter.into(), by)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&groups)?);
            } else {
                print!("{}", report::summary(&groups, by));
            }
        }
        Command::Transcript { session, json } => {
            let path = PathBuf::from(&session);
            let path = if path.is_file() {
                path
            } else {
                transcript::find(&session, paths::claude_raw_dir().ok().as_deref())
                    .with_context(|| format!("no transcript found for session {session}"))?
            };
            let summary = transcript::parse(&path)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&summary.to_json())?);
            } else {
                print!("{}", report::transcript(&summary));
            }
        }
        Command::Export { session, content } => {
            let config = config::Config::load(&paths::config_path()?)?;
            let mut ledger = ledger::Ledger::open(&paths::ledger_path()?)?;
            sync_ledger(&mut ledger, false)?;
            let record = ledger
                .get(&session)?
                .with_context(|| format!("no session matching \"{session}\" in the ledger"))?;
            let payload =
                upload::build(&ledger, &record, content.unwrap_or(config.upload_content))?;
            println!("{}", serde_json::to_string_pretty(&payload)?);
        }
        Command::Schema { which } => print!(
            "{}",
            match which {
                SchemaKind::Session => session::json_schema(),
                SchemaKind::Upload => session::upload_json_schema(),
            }
        ),
        Command::Capture => unreachable!("handled in main"),
    }
    Ok(())
}

/// Bring the ledger up to date with the capture, then re-measure how much of
/// each session's changes is still in the files.
fn sync_ledger(
    ledger: &mut ledger::Ledger,
    force: bool,
) -> Result<(sync::Report, rewrite::Report)> {
    let config = config::Config::load(&paths::config_path()?)?;
    let report = sync::run(
        &paths::claude_raw_dir()?,
        &paths::claude_facts_dir()?,
        ledger,
        &config.machine_id,
        force,
    )?;
    for (path, err) in &report.failed {
        eprintln!("warning: could not sync {}: {err}", path.display());
    }
    let rewrite = rewrite::measure(ledger, Utc::now())?;
    Ok((report, rewrite))
}

fn status(target: &Target) -> Result<()> {
    let path = target.settings_path()?;
    let installed = hooks::installed_events(&path)?;
    let total = hooks::all_events().count();
    println!("Settings:   {}", path.display());
    println!("Hooks:      {}/{} events", installed.len(), total);
    let missing: Vec<_> = hooks::all_events()
        .filter(|e| !installed.iter().any(|i| i == e))
        .collect();
    if !installed.is_empty() && !missing.is_empty() {
        println!("Missing:    {}", missing.join(", "));
    }
    let raw = paths::claude_raw_dir()?;
    let (sessions, bytes) = match std::fs::read_dir(&raw) {
        Ok(entries) => entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
            .fold((0, 0), |(n, b), e| {
                (n + 1, b + e.metadata().map(|m| m.len()).unwrap_or(0))
            }),
        Err(_) => (0, 0),
    };
    println!(
        "Raw data:   {} ({} sessions, {:.1} MB)",
        raw.display(),
        sessions,
        bytes as f64 / 1e6
    );
    Ok(())
}
