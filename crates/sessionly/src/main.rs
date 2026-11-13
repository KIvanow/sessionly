use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use clap::{Args, Parser, Subcommand};

mod auto;
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
    /// Set the server that sessions are uploaded to
    Connect {
        /// Server address, e.g. https://sessionly.example.com
        url: String,
        /// Access token. Without this option it is read from standard input.
        #[arg(long, env = "SESSIONLY_TOKEN", hide_env_values = true)]
        token: Option<String>,
        /// How much content uploads carry [default: keep the current setting, initially metadata]
        #[arg(long, value_enum)]
        content: Option<session::Content>,
        /// Save the settings without contacting the server first
        #[arg(long)]
        no_check: bool,
    },
    /// Stop uploading and forget the server and its token
    Disconnect,
    /// Send new and changed sessions to the server
    Upload {
        /// Only report how many sessions would be sent
        #[arg(long)]
        dry_run: bool,
    },
    /// Show or change local settings
    Settings {
        /// Sync (and upload, if connected) in the background when a session ends
        #[arg(long, value_name = "on|off", value_parser = parse_on_off)]
        auto_sync: Option<bool>,
        /// How much content uploads carry
        #[arg(long, value_enum)]
        content: Option<session::Content>,
    },
    /// One background sync and upload (started by the capture hook)
    #[command(hide = true)]
    Auto {
        #[arg(long, default_value_t = 0)]
        after_ms: u64,
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

fn parse_on_off(text: &str) -> Result<bool> {
    match text {
        "on" | "true" => Ok(true),
        "off" | "false" => Ok(false),
        _ => bail!("expected on or off"),
    }
}

/// A token sent over plain http can be read by anyone on the network, so
/// http is accepted only for a server on this machine.
fn check_server_url(url: &str) -> Result<()> {
    let local = ["http://localhost", "http://127.0.0.1", "http://[::1]"]
        .iter()
        .any(|prefix| {
            url.strip_prefix(prefix)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with([':', '/']))
        });
    if url.starts_with("https://") || local {
        Ok(())
    } else {
        bail!(
            "the server address must start with https:// (http:// is accepted only for localhost)"
        )
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
        Command::Connect {
            url,
            token,
            content,
            no_check,
        } => {
            let url = url.trim().trim_end_matches('/').to_string();
            check_server_url(&url)?;
            let token = match token {
                Some(token) => token,
                None => {
                    eprint!("Token: ");
                    let mut line = String::new();
                    std::io::stdin().read_line(&mut line)?;
                    line
                }
            };
            let token = token.trim().to_string();
            if token.is_empty() {
                bail!("a token is required");
            }
            let path = paths::config_path()?;
            let mut config = config::Config::load(&path)?;
            let server = config::Server { url, token };
            if !no_check {
                if let Err(err) = upload::Client::new(&server).ping() {
                    bail!("{err}. Nothing was saved; use --no-check to save the settings anyway.");
                }
            }
            println!("Connected to {}", server.url);
            config.server = Some(server);
            if let Some(content) = content {
                config.upload_content = content;
            }
            config.save(&path)?;
            print_settings(&config);
        }
        Command::Disconnect => {
            let path = paths::config_path()?;
            let mut config = config::Config::load(&path)?;
            match config.server.take() {
                Some(server) => {
                    config.save(&path)?;
                    println!(
                        "Disconnected from {}. Nothing more will be uploaded.",
                        server.url
                    );
                }
                None => println!("Not connected to a server."),
            }
        }
        Command::Upload { dry_run } => {
            let config = config::Config::load(&paths::config_path()?)?;
            let mut ledger = ledger::Ledger::open(&paths::ledger_path()?)?;
            sync_ledger(&mut ledger, false)?;
            let report = upload::run(&mut ledger, &config, dry_run)?;
            let server = config.server.as_ref().map_or("", |s| s.url.as_str());
            if dry_run {
                println!(
                    "Would upload {} sessions to {server} ({} already up to date)",
                    report.sent, report.unchanged
                );
            } else {
                println!(
                    "Uploaded {} sessions to {server} ({} already up to date)",
                    report.sent, report.unchanged
                );
            }
            for (id, reason) in &report.failed {
                eprintln!("warning: {id} was not uploaded: {reason}");
            }
            if let Some(reason) = report.stopped {
                bail!("upload stopped early: {reason}");
            }
            if !report.failed.is_empty() {
                bail!("{} sessions were not uploaded", report.failed.len());
            }
        }
        Command::Settings { auto_sync, content } => {
            let path = paths::config_path()?;
            let mut config = config::Config::load(&path)?;
            if auto_sync.is_some() || content.is_some() {
                config.auto_sync = auto_sync.unwrap_or(config.auto_sync);
                config.upload_content = content.unwrap_or(config.upload_content);
                config.save(&path)?;
            }
            print_settings(&config);
        }
        Command::Auto { after_ms } => {
            auto::run(after_ms);
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
    let (report, rewrite) = sync::sync_all(ledger, &config, force)?;
    for (path, err) in &report.failed {
        eprintln!("warning: could not sync {}: {err}", path.display());
    }
    Ok((report, rewrite))
}

fn content_name(content: session::Content) -> &'static str {
    match content {
        session::Content::Local => "local",
        session::Content::Previews => "previews",
        session::Content::Metadata => "metadata",
    }
}

fn print_settings(config: &config::Config) {
    println!("Machine id: {}", config.machine_id);
    match &config.server {
        Some(server) => println!("Server:     {}", server.url),
        None => println!("Server:     not connected (nothing is uploaded)"),
    }
    println!(
        "Uploads:    {} ({})",
        content_name(config.upload_content),
        match config.upload_content {
            session::Content::Previews =>
                "200-character previews of prompts, commands and errors are sent",
            _ => "no text from prompts, commands or output is sent",
        }
    );
    println!(
        "Auto sync:  {}",
        if config.auto_sync {
            "on (runs in the background when a session ends)"
        } else {
            "off"
        }
    );
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
    let config = config::Config::load(&paths::config_path()?)?;
    print_settings(&config);
    if let Some(ago) = auto::last_started(&paths::data_dir()?) {
        println!("            last started {} ago", report::age(ago));
    }
    if let Some(server) = &config.server {
        let ledger = ledger::Ledger::open(&paths::ledger_path()?)?;
        let ids = ledger.session_ids()?;
        let sent = ids
            .iter()
            .filter(|id| matches!(ledger.uploaded_hash(id, &server.url), Ok(Some(_))))
            .count();
        println!("Uploaded:   {sent} of {} sessions in the ledger", ids.len());
    }
    Ok(())
}
