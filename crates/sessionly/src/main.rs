use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};

mod capture;
mod git;
mod hooks;
mod ledger;
mod normalize;
mod paths;
mod pricing;
mod report;
mod session;
mod sync;
mod transcript;
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
    /// Show tokens, cost, models and timing from a session transcript
    Transcript {
        /// Session id, or a path to a transcript .jsonl file
        session: String,
        /// Print JSON instead of a table
        #[arg(long)]
        json: bool,
    },
    /// Normalize captured sessions into the local ledger
    Sync {
        /// Rebuild every session, not only the ones that changed
        #[arg(long)]
        force: bool,
    },
    /// Show one session from the ledger
    Show {
        /// Session id or a unique prefix of one
        session: String,
        /// Print the full session record as JSON
        #[arg(long)]
        json: bool,
    },
    /// Print the JSON Schema of the session record
    Schema,
    /// Hook entry point: read one payload on stdin and store it (used by Claude Code)
    Capture,
}

#[derive(Args)]
struct Target {
    /// Use <DIR>/.claude/settings.json instead of ~/.claude/settings.json
    #[arg(long, value_name = "DIR")]
    project: Option<PathBuf>,
}

impl Target {
    fn settings_path(&self) -> PathBuf {
        let project = self
            .project
            .as_deref()
            .map(|p| std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf()));
        hooks::settings_path(project.as_deref())
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    if let Command::Capture = cli.command {
        // Kept separate: the hook path must stay silent and always exit 0.
        return ExitCode::from(capture::run() as u8);
    }
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
            let path = target.settings_path();
            let exe = std::env::current_exe().context("locating the sessionly binary")?;
            hooks::install(&path, &hooks::capture_command(&exe))?;
            println!(
                "Installed Sessionly hooks for {} events in {}",
                hooks::all_events().count(),
                path.display()
            );
            println!(
                "Raw payloads will be written to {}",
                paths::claude_raw_dir().display()
            );
        }
        Command::Uninstall(target) => {
            let path = target.settings_path();
            hooks::uninstall(&path)?;
            println!("Removed Sessionly hooks from {}", path.display());
        }
        Command::Status(target) => status(&target)?,
        Command::Watch => watch::run(&paths::claude_raw_dir())?,
        Command::Transcript { session, json } => {
            let path = PathBuf::from(&session);
            let path = if path.is_file() {
                path
            } else {
                transcript::find(&session, &paths::claude_raw_dir())
                    .with_context(|| format!("no transcript found for session {session}"))?
            };
            let summary = transcript::parse(&path)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&summary.to_json())?);
            } else {
                print!("{}", report::transcript(&summary));
            }
        }
        Command::Sync { force } => {
            let mut ledger = ledger::Ledger::open(&paths::ledger_path())?;
            print_sync(&sync::run(&paths::claude_raw_dir(), &mut ledger, force)?);
            println!(
                "Ledger: {} sessions in {}",
                ledger.count()?,
                paths::ledger_path().display()
            );
        }
        Command::Show { session, json } => {
            // Always show current data: pick up anything captured since the last sync.
            let mut ledger = ledger::Ledger::open(&paths::ledger_path())?;
            let report = sync::run(&paths::claude_raw_dir(), &mut ledger, false)?;
            for (path, err) in &report.failed {
                eprintln!("warning: could not sync {}: {err}", path.display());
            }
            let record = ledger.get(&session)?.with_context(|| {
                format!("no session matching \"{session}\" in the ledger (only sessions captured by the hooks are stored)")
            })?;
            if json {
                println!("{}", serde_json::to_string_pretty(&record)?);
            } else {
                print!("{}", report::session(&record));
            }
        }
        Command::Schema => print!("{}", session::json_schema()),
        Command::Capture => unreachable!(),
    }
    Ok(())
}

fn print_sync(report: &sync::Report) {
    println!(
        "Synced: {} updated, {} unchanged, {} without usable events",
        report.synced, report.unchanged, report.empty
    );
    for (path, err) in &report.failed {
        eprintln!("warning: could not sync {}: {err}", path.display());
    }
}

fn status(target: &Target) -> Result<()> {
    let path = target.settings_path();
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
    let raw = paths::claude_raw_dir();
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
