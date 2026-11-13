use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand};

mod capture;
mod hooks;
mod paths;
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
        Command::Capture => unreachable!(),
    }
    Ok(())
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
