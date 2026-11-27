use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use clap::{Args, Parser, Subcommand};

mod auto;
mod capture;
mod changes;
mod config;
mod cursor_hooks;
mod git;
mod hooks;
mod import;
mod import_codex;
mod import_cursor;
mod import_grok;
mod import_opencode;
mod jsonl;
mod ledger;
mod normalize;
mod opencode;
mod outcomes;
mod paths;
mod pricing;
mod repo;
mod report;
mod reviews;
mod rewrite;
mod runtime;
mod session;
mod sync;
mod transcript;
mod turn;
mod update;
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
    /// Add the capture hooks: to this machine's settings, or with --repo to a
    /// repository, for sessions that run in the cloud
    Install {
        #[command(flatten)]
        target: Target,
        /// With --repo: read the release's SHA256SUMS from this file instead
        /// of downloading it
        #[arg(long, value_name = "FILE", requires = "repo")]
        checksums: Option<PathBuf>,
    },
    /// Remove the capture hooks again
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
    /// Bring in past sessions from the files Claude Code, Cursor, Grok, Codex and OpenCode keep
    Import {
        /// Session ids (or the start of one) to import [default: every session]
        sessions: Vec<String>,
        /// Only this tool's sessions: claude-code, cursor, grok, codex or opencode (repeatable)
        #[arg(long = "tool", value_name = "TOOL")]
        tools: Vec<String>,
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
    /// Totals per tool, user, repository, model or day
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
    /// The later commits that changed a session's lines: fixes, reverts, rework
    Outcomes {
        /// Session id or a unique prefix of one
        session: String,
        /// Print JSON instead of a table
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
    /// Stop submitting sessions from a repository, and delete the ones already submitted
    Exclude {
        /// The repository: a directory, or the name the dashboard shows
        /// (`github.com/owner/name`, `~/Documents`). Omit to list them.
        repo: Option<String>,
    },
    /// Submit sessions from a repository again. What was deleted stays deleted
    /// until a machine that still has the sessions uploads them.
    Include {
        /// The repository, as named to `sessionly exclude`
        repo: String,
    },
    /// The server's Business or Enterprise license
    License {
        #[command(subcommand)]
        action: LicenseAction,
    },
    /// Show or change local settings
    Settings {
        /// Sync (and upload, if connected) in the background when a turn or a
        /// session ends
        #[arg(long, value_name = "on|off", value_parser = parse_on_off)]
        auto_sync: Option<bool>,
        /// How much content uploads carry
        #[arg(long, value_enum)]
        content: Option<session::Content>,
        /// Upload hashes of the lines agents added, so the server can tell
        /// which lines of a pull request an agent wrote
        #[arg(long, value_name = "on|off", value_parser = parse_on_off)]
        line_hashes: Option<bool>,
        /// How much of what changes in a repository while an agent's shell
        /// command runs is counted as the agent's. Its files are compared
        /// before and after each command
        #[arg(long, value_enum)]
        shell_edits: Option<config::ShellEdits>,
        /// Ask once a day whether a newer release is out, and say so in
        /// status, list and summary. The capture hooks never ask
        #[arg(long, value_name = "on|off", value_parser = parse_on_off)]
        update_check: Option<bool>,
        /// Read repositories' history for what later commits did to the
        /// agents' lines (fixes, reverts), and upload the counts
        #[arg(long, value_name = "on|off", value_parser = parse_on_off)]
        outcomes: Option<bool>,
        /// The words that make a commit subject a fix, separated by commas, in
        /// place of the defaults; `default` for those
        #[arg(long, value_name = "WORDS")]
        fix_words: Option<String>,
    },
    /// Replace this binary with the newest release
    Update {
        /// Only say whether there is a newer release
        #[arg(long)]
        check: bool,
        /// This release instead of the newest one, such as 0.4.0
        #[arg(long, value_name = "VERSION")]
        version: Option<String>,
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
    /// Hook entry point: read one payload on stdin and store it (used by the
    /// hooks of Claude Code, Cursor, Grok and Codex)
    Capture,
}

#[derive(Subcommand)]
enum LicenseAction {
    /// Show the license installed on the connected server
    Status,
    /// Install a license file on the connected server (needs an admin token)
    Install {
        /// The license file you were issued
        file: PathBuf,
    },
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
    /// The repository at DIR (default: this directory), for Claude Code
    /// cloud sessions, Cursor cloud agents and Codex cloud tasks: a script,
    /// hook entries and an AGENTS.md section to commit, which do nothing on a
    /// person's own machine
    #[arg(
        long,
        value_name = "DIR",
        num_args = 0..=1,
        default_missing_value = ".",
        conflicts_with = "project"
    )]
    repo: Option<PathBuf>,
}

/// Which sessions to include. Text filters match substrings, ignoring case.
#[derive(Args)]
struct FilterArgs {
    /// Tool: claude-code, cursor, grok, codex or opencode
    #[arg(long)]
    tool: Option<String>,
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
            tool: a.tool,
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

    /// The repository named with `--repo`, as an absolute path.
    fn repo_dir(&self) -> Option<PathBuf> {
        self.repo
            .as_deref()
            .map(|dir| std::path::absolute(dir).unwrap_or_else(|_| dir.to_path_buf()))
    }
}

/// `sessionly install --repo`: write the script and the hook entries, and
/// say what is left for a person to do.
fn install_in_repo(dir: &std::path::Path, checksums: Option<&std::path::Path>) -> Result<()> {
    let version = env!("CARGO_PKG_VERSION");
    let base = std::env::var("SESSIONLY_RELEASE_BASE")
        .ok()
        .filter(|base| !base.trim().is_empty())
        .unwrap_or_else(|| repo::DEFAULT_RELEASE_BASE.to_string());
    let sums = match checksums {
        Some(file) => {
            std::fs::read_to_string(file).with_context(|| format!("reading {}", file.display()))?
        }
        None => {
            let url = repo::checksums_url(&base, version);
            upload::fetch_text(&url).with_context(|| {
                format!(
                    "could not get the checksums of sessionly {version} from {url}. \
                     The script must name a released version; if this build is not \
                     one, install with a released sessionly, or pass --checksums FILE"
                )
            })?
        }
    };
    let release = repo::Release::from_checksums(version, &base, &sums)?;
    let written = repo::install(dir, &release)?;
    for file in &written {
        let path = file.path.strip_prefix(dir).unwrap_or(&file.path);
        println!(
            "{}  {}",
            if file.changed {
                "wrote    "
            } else {
                "unchanged"
            },
            path.display()
        );
    }
    println!();
    println!("Sessions in the cloud will fetch sessionly {version} and capture with it.");
    println!("What is left to do:");
    println!("  1. Commit those four files.");
    println!("  2. Give the cloud environment SESSIONLY_URL and SESSIONLY_TOKEN, as secrets");
    println!("     (a token made for it on the server's Team page). Without them the");
    println!("     session is captured in the sandbox and sent nowhere. In Codex's cloud");
    println!("     set them as environment variables: its tasks are not given secrets.");
    println!("  3. Claude Code and Codex: add the server's host to the environment's");
    println!("     allowed domains. Cursor's cloud agents can reach it as they are.");
    println!("Optional, also in the environment: SESSIONLY_LINE_HASHES=on (needed for");
    println!("pull request figures) and SESSIONLY_CONTENT=previews.");
    println!("On a person's own machine the script does nothing.");
    println!("Codex's cloud runs no hooks: AGENTS.md asks the agent there to run the");
    println!("script around each turn's work, which records the files and lines a turn");
    println!("changed and nothing else (no prompts, tool calls, tokens or cost).");
    Ok(())
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
    // So is what an agent that runs no hooks is asked to run itself.
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "turn") {
        let which = std::env::args().nth(2).unwrap_or_default();
        return ExitCode::from(turn::run(&which) as u8);
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
        Command::Install { target, checksums } => {
            if let Some(dir) = target.repo_dir() {
                return install_in_repo(&dir, checksums.as_deref());
            }
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
                paths::raw_root()?.display()
            );
            println!("The hooks run {}", exe.display());
            if target.project.is_some() {
                println!(
                    "Note: that path is specific to this machine. If this settings file is \
                     committed, use .claude/settings.local.json for the hooks instead."
                );
            } else {
                // Codex reads its own file, not Claude Code's. A file that
                // cannot be changed is no reason to undo the install above.
                if paths::codex_home().is_some_and(|home| home.is_dir()) {
                    if let Err(err) = install_codex(&exe) {
                        eprintln!("warning: Codex hooks not installed: {err:#}");
                    }
                }
                if let Err(err) = opencode::install(&exe) {
                    eprintln!("warning: OpenCode plugin not installed: {err:#}");
                }
            }
        }
        Command::Uninstall(target) => {
            if let Some(dir) = target.repo_dir() {
                let touched = repo::uninstall(&dir)?;
                if touched.is_empty() {
                    println!("No Sessionly files in {}", dir.display());
                }
                for path in &touched {
                    println!(
                        "removed from  {}",
                        path.strip_prefix(&dir).unwrap_or(path).display()
                    );
                }
                return Ok(());
            }
            let path = target.settings_path()?;
            if hooks::uninstall(&path, hooks::Kind::Machine)? {
                println!("Removed Sessionly hooks from {}", path.display());
            } else {
                println!("No Sessionly hooks in {}", path.display());
            }
            if target.project.is_none() {
                if let Err(err) = uninstall_codex() {
                    eprintln!("warning: Codex hooks not removed: {err:#}");
                }
                if let Err(err) = opencode::uninstall() {
                    eprintln!("warning: OpenCode plugin not removed: {err:#}");
                }
            }
        }
        Command::Status(target) => status(&target)?,
        Command::Watch => watch::run(&paths::raw_root()?)?,
        Command::Sync { force } => {
            let mut ledger = ledger::Ledger::open(&paths::ledger_path()?)?;
            let (report, rewrite) = sync_ledger_for(&mut ledger, force, outcomes::PATIENT)?;
            println!(
                "Synced: {} updated, {} unchanged, {} without usable events",
                report.synced, report.unchanged, report.empty
            );
            if report.removed > 0 {
                println!(
                    "Removed: {} sessions whose capture is gone or has nothing in it",
                    report.removed
                );
            }
            println!(
                "Rewrite: {} changed files measured, {} in directories that no longer exist",
                rewrite.measured, rewrite.unavailable
            );
            if rewrite.checkpoints > 0 {
                println!(
                    "Kept: {} measurements of sessions that reached 1, 7 or 30 days since they ended",
                    rewrite.checkpoints
                );
            }
            println!(
                "Ledger: {} sessions in {}",
                ledger.count()?,
                paths::ledger_path()?.display()
            );
        }
        Command::Import { sessions, tools } => {
            if let Some(unknown) = tools.iter().find(|t| !paths::SOURCES.contains(&t.as_str())) {
                bail!(
                    "unknown tool \"{unknown}\"; use one of: {}",
                    paths::SOURCES.join(", ")
                );
            }
            let homes = import::AgentHomes::detect();
            let report = import::import_all(&homes, &paths::data_dir()?, &tools, &sessions);
            println!(
                "Imported: {} sessions, {} already up to date, {} with nothing to import",
                report.imported, report.up_to_date, report.empty
            );
            for (source, count) in &report.by_source {
                println!("  {:<12} {count}", report::tool_name(source));
            }
            for (path, err) in &report.failed {
                eprintln!("warning: could not import {}: {err}", path.display());
            }
            let mut ledger = ledger::Ledger::open(&paths::ledger_path()?)?;
            let (synced, _) = sync_ledger(&mut ledger, false)?;
            println!(
                "Ledger: {} sessions ({} updated just now)",
                ledger.count()?,
                synced.synced
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
                let checkpoints = ledger.checkpoints_of(&record.session_id)?;
                let outcomes = ledger.outcome_checkpoints_of(&record.session_id)?;
                print!(
                    "{}",
                    report::session(
                        &record,
                        &files,
                        measured_at.as_deref(),
                        &checkpoints,
                        &outcomes
                    )
                );
            }
        }
        Command::Outcomes { session, json } => {
            let mut ledger = ledger::Ledger::open(&paths::ledger_path()?)?;
            sync_ledger(&mut ledger, false)?;
            let record = ledger
                .get(&session)?
                .with_context(|| format!("no session matching \"{session}\" in the ledger"))?;
            let events = ledger.outcome_events_of(&record.session_id)?;
            let kept = ledger.outcome_checkpoints_of(&record.session_id)?;
            if json {
                let both = serde_json::json!({ "events": events, "checkpoints": kept });
                println!("{}", serde_json::to_string_pretty(&both)?);
            } else {
                print!("{}", report::outcomes(&record, &events, &kept));
                let config = config::Config::load(&paths::config_path()?)?.with_environment();
                if !config.outcomes {
                    println!("(outcomes are off: sessionly settings --outcomes on)");
                }
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
                say_newer_release(true);
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
                say_newer_release(true);
            }
        }
        Command::Transcript { session, json } => {
            let path = PathBuf::from(&session);
            let path = if path.is_file() {
                path
            } else {
                transcript::find(&session, paths::raw_dir(paths::CLAUDE_CODE).ok().as_deref())
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
            config::check_server_url(&url)?;
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
            let config = config::Config::load(&paths::config_path()?)?.with_environment();
            let mut ledger = ledger::Ledger::open(&paths::ledger_path()?)?;
            sync_ledger(&mut ledger, false)?;
            let report = upload::run(&mut ledger, &config, dry_run)?;
            let server = config.server.as_ref().map_or("", |s| s.url.as_str());
            println!("{}", upload_line(dry_run, &report, server));
            if let Some(reason) = &report.unasked {
                eprintln!(
                    "warning: the server was not asked which repositories are stopped, \
                     so none are left out of this count: {reason}"
                );
            }
            if report.withdrawn > 0 {
                println!(
                    "Took back {} that are part of another session now",
                    report.withdrawn
                );
            }
            for (id, reason) in &report.failed {
                eprintln!("warning: {id} was not uploaded: {reason}");
            }
            for (id, reason) in &report.not_withdrawn {
                eprintln!("warning: {id} was not taken back: {reason}");
            }
            if let Some(reason) = report.stopped {
                bail!("upload stopped early: {reason}");
            }
            if !report.failed.is_empty() {
                bail!("{} sessions were not uploaded", report.failed.len());
            }
            if !report.not_withdrawn.is_empty() {
                bail!(
                    "{} sessions were not taken back",
                    report.not_withdrawn.len()
                );
            }
        }
        Command::Exclude { repo } => exclude_repository(repo.as_deref())?,
        Command::Include { repo } => include_repository(&repo)?,
        Command::License { action } => {
            let config = config::Config::load(&paths::config_path()?)?;
            let Some(server) = &config.server else {
                bail!("no server is configured; run: sessionly connect <url>");
            };
            let client = upload::Client::new(server);
            let answer = match action {
                LicenseAction::Status => client.get("/api/v1/license"),
                LicenseAction::Install { file } => {
                    let text = std::fs::read_to_string(&file)
                        .with_context(|| format!("reading {}", file.display()))?;
                    client.post("/api/v1/license", &serde_json::json!({ "license": text }))
                }
            };
            match answer {
                Ok(state) => print!("{}", report::license(&server.url, &state)),
                // The core server has no license endpoints at all.
                Err(upload::SendError::Rejected(m)) if m.starts_with("HTTP 404") => println!(
                    "{} runs the core server, which needs no license. Business and Enterprise \
                     features need the ee server.",
                    server.url
                ),
                Err(err) => bail!("{err}"),
            }
        }
        Command::Update { check, version } => {
            let this = env!("CARGO_PKG_VERSION");
            // The file itself, not a link to it: the link stays where it is.
            let exe = std::env::current_exe()
                .and_then(std::fs::canonicalize)
                .context("locating the sessionly binary")?;
            match update::run(&exe, this, version.as_deref(), check)? {
                update::Outcome::Current => println!("sessionly {this} is the newest release."),
                update::Outcome::Available(found) => {
                    println!("sessionly {found} is out (this is {this}). Run: sessionly update")
                }
                update::Outcome::Updated(now, path) => {
                    println!("Updated sessionly {this} to {now} at {}", path.display());
                    println!("The hooks run it from the same place and need nothing.");
                    println!(
                        "A repository set up with `sessionly install --repo` keeps fetching the \
                         version it names until that is run there again."
                    );
                }
            }
        }
        Command::Settings {
            auto_sync,
            content,
            line_hashes,
            shell_edits,
            update_check,
            outcomes,
            fix_words,
        } => {
            let path = paths::config_path()?;
            let mut config = config::Config::load(&path)?;
            let asked = [auto_sync, line_hashes, update_check, outcomes];
            if let Some(words) = &fix_words {
                let words: Vec<String> = words
                    .split(',')
                    .map(|w| w.trim().to_string())
                    .filter(|w| !w.is_empty())
                    .collect();
                if words.is_empty() {
                    bail!("--fix-words needs at least one word, or `default`");
                }
                // A subject is read word by word, so each must be one word as it is read.
                if let Some(bad) = words.iter().find(|w| !crate::outcomes::is_word(w)) {
                    bail!(
                        "--fix-words: `{bad}` is not one word; subjects are split on everything \
                         that is not a letter or digit"
                    );
                }
                let default = words.len() == 1 && words[0].eq_ignore_ascii_case("default");
                config.outcomes_fix_words =
                    (!default).then(|| words.iter().map(|w| w.to_lowercase()).collect());
            }
            if content.is_some()
                || shell_edits.is_some()
                || fix_words.is_some()
                || asked.iter().any(Option::is_some)
            {
                config.auto_sync = auto_sync.unwrap_or(config.auto_sync);
                config.upload_content = content.unwrap_or(config.upload_content);
                config.upload_line_hashes = line_hashes.unwrap_or(config.upload_line_hashes);
                config.shell_edits = shell_edits.unwrap_or(config.shell_edits);
                config.update_check = update_check.unwrap_or(config.update_check);
                config.outcomes = outcomes.unwrap_or(config.outcomes);
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
            let payload = upload::build(
                &ledger,
                &record,
                content.unwrap_or(config.upload_content),
                config.upload_line_hashes,
            )?;
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
    sync_ledger_for(ledger, force, outcomes::WAITED_FOR)
}

/// The same, reading history for outcomes for no longer than `outcomes_for`.
fn sync_ledger_for(
    ledger: &mut ledger::Ledger,
    force: bool,
    outcomes_for: std::time::Duration,
) -> Result<(sync::Report, rewrite::Report)> {
    let config = config::Config::load(&paths::config_path()?)?.with_environment();
    let (report, rewrite) = sync::sync_all(ledger, &config, force, outcomes_for)?;
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

fn upload_line(dry_run: bool, report: &upload::Report, server: &str) -> String {
    let verb = if dry_run { "Would upload" } else { "Uploaded" };
    let mut text = format!(
        "{verb} {} sessions to {server} ({} already up to date",
        report.sent, report.unchanged
    );
    if report.excluded > 0 {
        text.push_str(&format!(
            ", {} from repositories you stopped submitting",
            report.excluded
        ));
    }
    text.push(')');
    text
}

/// What `sessionly exclude` and `sessionly include` say when the server has
/// no such route.
const EXCLUSIONS_UNSUPPORTED: &str =
    "this server cannot stop a repository yet; it needs a newer version of sessionly";

/// A client for the server this machine uploads to. Which repositories are
/// stopped is kept there and nowhere else, so that every machine of a
/// person, and the dashboard, see one list.
fn connected_client() -> Result<upload::Client> {
    let config = config::Config::load(&paths::config_path()?)?.with_environment();
    let Some(server) = config.server.as_ref() else {
        bail!("no server is configured; run: sessionly connect <url>");
    };
    Ok(upload::Client::new(server))
}

/// Why the server did not do what `sessionly exclude` or `include` asked.
fn exclusion_problem(err: upload::SendError) -> anyhow::Error {
    if err.no_such_route() {
        anyhow::anyhow!(EXCLUSIONS_UNSUPPORTED)
    } else {
        anyhow::anyhow!("{err}")
    }
}

fn list_excluded(client: &upload::Client) -> Result<()> {
    let Some(stopped) = client.stopped().map_err(exclusion_problem)? else {
        bail!(EXCLUSIONS_UNSUPPORTED);
    };
    if stopped.repos.is_empty() {
        println!("Nothing is stopped.");
        return Ok(());
    }
    println!("Stopped:");
    for name in &stopped.repos {
        println!("  {name}");
    }
    Ok(())
}

fn exclude_repository(repo: Option<&str>) -> Result<()> {
    let client = connected_client()?;
    let Some(text) = repo else {
        return list_excluded(&client);
    };
    let asked = upload::repository_name(text)?;
    let answer = client.exclude_repo(&asked).map_err(exclusion_problem)?;
    let name = answer
        .get("repo")
        .and_then(|value| value.as_str())
        .unwrap_or(&asked)
        .to_string();
    let removed = answer
        .get("sessions_removed")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let covers = answer
        .get("covers_folders")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let removed = match removed {
        0 => "No sessions of yours were on the server.".to_string(),
        1 => "1 session already submitted from it was removed.".to_string(),
        n => format!("{n} sessions already submitted from it were removed."),
    };
    println!("Stopped submitting {name}. {removed}");
    if covers {
        println!("Directories inside it are stopped too.");
    }
    println!("The copy on this machine is kept, and is not sent again until you allow it.");
    println!("To submit it again: sessionly include {name}");
    Ok(())
}

fn include_repository(repo: &str) -> Result<()> {
    let client = connected_client()?;
    let asked = upload::repository_name(repo)?;
    let answer = match client.include_repo(&asked) {
        Ok(answer) => answer,
        Err(upload::SendError::Rejected(message)) if message.contains("no such repository") => {
            bail!("{asked} is not stopped");
        }
        Err(err) => return Err(exclusion_problem(err)),
    };
    let name = answer
        .get("repo")
        .and_then(|value| value.as_str())
        .unwrap_or(&asked);
    println!("{name} will be submitted again.");
    println!("The next upload from each machine that still has the sessions sends them.");
    Ok(())
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
        "Hashes:     {}",
        if config.upload_line_hashes {
            "on (hashes of the lines agents added are sent, for pull request reports)"
        } else {
            "off"
        }
    );
    println!(
        "Auto sync:  {}",
        if config.auto_sync {
            "on (runs in the background when a turn or a session ends)"
        } else {
            "off"
        }
    );
    println!(
        "Update:     {}",
        auto::update_check_blocker(config).unwrap_or(
            "on (a background upload asks once a day, and status says when a newer release is out)",
        )
    );
    println!(
        "Shell:      {}",
        match config.shell_edits {
            config::ShellEdits::Sure => {
                "sure (of what changes while an agent's command runs, what is sure to be the command's is counted)"
            }
            config::ShellEdits::All => {
                "all (what changes in a repository while an agent's command runs is counted as the agent's)"
            }
            config::ShellEdits::Off =>
                "off (only what agents change with their file tools is counted)",
        }
    );
    println!(
        "Outcomes:   {}",
        if config.outcomes {
            "on (history is read for later fixes and reverts of agents' lines; only counts are sent)"
        } else {
            "off"
        }
    );
    if let Some(words) = &config.outcomes_fix_words {
        println!("Fix words:  {}", words.join(", "));
    }
}

/// Install the hooks in Codex's own file.
fn install_codex(exe: &Path) -> Result<()> {
    let path = hooks::codex_hooks_path()?;
    let changed = hooks::install_for(&path, &hooks::capture_command(exe), hooks::Agent::Codex)?;
    println!(
        "{} for {} events in {}",
        if changed {
            "Installed Sessionly hooks for Codex"
        } else {
            "Sessionly hooks for Codex already installed"
        },
        hooks::Agent::Codex.events().count(),
        path.display()
    );
    if changed {
        println!(
            "Codex runs new or changed hooks only once you have approved them: \
             start codex and accept them in the review it shows, or run /hooks there."
        );
    }
    Ok(())
}

/// Remove the hooks from Codex's own file, if it has any.
fn uninstall_codex() -> Result<()> {
    let path = hooks::codex_hooks_path()?;
    if path.exists() && hooks::uninstall(&path, hooks::Kind::Machine)? {
        println!("Removed Sessionly hooks from {}", path.display());
    }
    Ok(())
}

fn status(target: &Target) -> Result<()> {
    if let Some(dir) = target.repo_dir() {
        let found = repo::status(&dir)?;
        println!("Repository: {}", dir.display());
        match &found.script_version {
            Some(version) => {
                println!("Script:     .sessionly/hook.sh, fetching sessionly {version}")
            }
            None => println!("Script:     not installed (run: sessionly install --repo)"),
        }
        println!(
            "Claude Code: {}/{} events in .claude/settings.json",
            found.claude_events,
            hooks::all_events().count()
        );
        println!(
            "Cursor:     {}/{} events in .cursor/hooks.json",
            found.cursor_events,
            repo::CURSOR_EVENTS.len()
        );
        println!(
            "Codex:      {}",
            if found.codex_asked {
                "asked in AGENTS.md to run the script around each turn"
            } else {
                "not asked in AGENTS.md (run: sessionly install --repo)"
            }
        );
        say_newer_release(false);
        return Ok(());
    }
    let path = target.settings_path()?;
    let installed = hooks::installed_events(&path, hooks::Kind::Machine)?;
    let total = hooks::all_events().count();
    println!("Settings:   {}", path.display());
    println!("Hooks:      {}/{} events", installed.len(), total);
    let missing: Vec<_> = hooks::all_events()
        .filter(|e| !installed.iter().any(|i| i == e))
        .collect();
    if !installed.is_empty() && !missing.is_empty() {
        println!("Missing:    {}", missing.join(", "));
    }
    if target.project.is_none() && paths::codex_home().is_some_and(|home| home.is_dir()) {
        let total = hooks::Agent::Codex.events().count();
        match hooks::codex_hooks_path() {
            Ok(path) => match hooks::installed_events(&path, hooks::Kind::Machine) {
                Ok(installed) => println!(
                    "Codex:      {}/{total} events in {}",
                    installed.len(),
                    path.display()
                ),
                Err(err) => println!("Codex:      unreadable, {}: {err:#}", path.display()),
            },
            Err(err) => println!("Codex:      {err:#}"),
        }
    }
    // Installed for the whole machine only, as Codex's hooks are.
    if let Some(line) = opencode::status().filter(|_| target.project.is_none()) {
        println!("OpenCode:   {line}");
    }
    let raw = paths::raw_root()?;
    let (mut sessions, mut bytes) = (0u64, 0u64);
    for source in paths::SOURCES {
        for entry in std::fs::read_dir(raw.join(source))
            .into_iter()
            .flatten()
            .flatten()
        {
            if entry.path().extension().is_some_and(|x| x == "jsonl") {
                sessions += 1;
                bytes += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
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
    say_newer_release(false);
    Ok(())
}

/// One line when a newer release was recorded. `status` always says so.
/// `list` and `summary` say so only in a terminal, and never in `--json`,
/// which is why those pass `only_terminal`.
fn say_newer_release(only_terminal: bool) {
    if only_terminal && !std::io::IsTerminal::is_terminal(&std::io::stdout()) {
        return;
    }
    let Ok(dir) = paths::data_dir() else {
        return;
    };
    if let Some(line) = auto::pending_update(&dir) {
        println!("{line}");
    }
}
