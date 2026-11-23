//! Review runs: the times a review command ran in a session, at what effort,
//! on the machine or in the cloud, and what its subagents cost.
//!
//! A run starts in one of three ways, all seen in Claude Code transcripts:
//! - The model calls the `Skill` tool with `skill: "code-review"`. The skill
//!   forks a subagent to run in, and the call's result names it (`agentId`).
//!   One run is one tool-use id: a transcript repeats the call's row.
//! - The person types `/code-review xhigh #590`: a prompt with that text, and
//!   for the hooks a `UserPromptExpansion` naming the command.
//! - A command Claude Code runs itself, `/ultrareview`: a row of its own,
//!   which the import turns into a `UserPromptExpansion` as the hooks have it.
//!
//! Codex's `/review` is its review mode: the rollout says when it was
//! entered and left, what it was pointed at, how many findings came back, and
//! the reviewer's thread, whose tokens give its cost.
//!
//! A run is decided here and nowhere else. What it is decided from are the
//! session's own events (`Seen`) and what its files say beside them
//! (`Facts`): where a typed command forked, the effort it reused, what the
//! reply that ended it found, and for Codex the review modes and the threads
//! reviewers ran in. Those who read the files only write down what is there.
//!
//! Reviews started by a prompt in words ("review this branch") leave no
//! command and are not counted: they can't be told from any other subagent
//! without reading text.
//!
//! Nothing of a command's arguments is kept but the effort and a pull request
//! number, parsed here on the machine.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::session::{Outcome, ReviewRan, ReviewRun, ReviewVia, Session, ToolStatus};
use crate::transcript::{Facts, ReviewMode, ReviewSaid, ReviewerThread};

mod findings;
pub use findings::findings_in;

/// The commands that are reviews. A plugin's skill matches on its last part
/// (`anything:code-review`). A team's own review skill under another name is
/// not counted.
pub const COMMANDS: &[&str] = &["code-review", "review", "security-review", "ultrareview"];

/// The efforts a review command takes as its first argument.
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max", "ultra"];

/// A typed command and the prompt it is in, taken as one start within this;
/// so are a review and the thread its reviewer began in.
pub const SAME_START_SECONDS: i64 = 5;

/// The `target` of a run that named a pull request of another repository
/// than the session's.
pub const OTHER_REPOSITORY: &str = "other_repository";

/// How long before its command a typed review's subagent may be written
/// down as started.
const STARTED_EARLY_MS: i64 = 1000;

/// True for an agent whose review commands are read. A session of another
/// has no count: not known, which is not none.
pub fn counted(source: &str) -> bool {
    crate::paths::SOURCES.contains(&source)
}

/// True for the name of a review command, with or without its slash. A
/// name and nothing else: what is typed after a slash may be a path that
/// ends in one (`/home/ann/notes.md:review`), which is no command and is not
/// kept.
pub fn is_review(name: &str) -> bool {
    named_review(name, false)
}

/// True for the name of a review skill, as the agent calls it or Claude Code
/// writes it down. A plugin's name may have a dot in it (`my.plugin:review`),
/// which what is typed may not: there it is how a file's name ends.
pub fn is_review_skill(name: &str) -> bool {
    named_review(name, true)
}

fn named_review(name: &str, dots: bool) -> bool {
    let name = name.trim();
    let name = name.strip_prefix('/').unwrap_or(name);
    let part = |part: &str| {
        let shaped =
            |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-' || (dots && c == '.');
        !part.is_empty() && part.chars().all(shaped)
    };
    let last = name.rsplit(':').next().unwrap_or(name);
    name.len() <= 100 && name.split(':').all(part) && COMMANDS.contains(&last)
}

/// The command and its arguments, if `text` is a slash command.
pub fn slash_command(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start().strip_prefix('/')?;
    let (name, args) = text.split_once(char::is_whitespace).unwrap_or((text, ""));
    (!name.is_empty()).then_some((name, args.trim()))
}

/// The effort and the pull request number in a review command's arguments.
/// Everything else in them (free text, paths) is left where it is.
///
/// A bare number is a pull request's only as the first or second argument
/// (`621`, `xhigh 621`): further on it is a number in a sentence ("the last
/// 3 commits"). `#528` and a pull request's URL are one wherever they are;
/// a path with `/pull/` in it (`/work/pull/42/diff.rs`) is not a URL.
pub fn parse_args(args: &str) -> (Option<String>, Option<u64>) {
    let (effort, number, _) = parse_args_of(args);
    (effort, number)
}

/// A review command's effort, its pull request number, and the name of the
/// repository a URL gave the number in.
type Args = (Option<String>, Option<u64>, Option<String>);

/// As `parse_args`, with the name of the repository the number was given
/// for, where a URL gave it (`web` for `https://github.com/acme/web/pull/7`).
fn parse_args_of(args: &str) -> Args {
    let (mut effort, mut number, mut repo) = (None, None, None);
    let mut position = 0;
    let mut words = args.split_whitespace();
    while let Some(word) = words.next() {
        if word == "--max-findings" {
            words.next();
            continue;
        }
        if word.starts_with("--") {
            continue;
        }
        position += 1;
        let bare = word.trim_end_matches(|c: char| ".,;:".contains(c));
        if position == 1 {
            let lower = bare.to_ascii_lowercase();
            if EFFORTS.contains(&lower.as_str()) {
                effort = Some(lower);
                continue;
            }
        }
        let named = bare.starts_with('#') || is_pull_url(bare);
        if number.is_none() && (named || position <= 2) {
            number = pull_number(bare);
            if number.is_some() && is_pull_url(bare) {
                let before = bare.split_once("/pull/").map_or("", |(before, _)| before);
                repo = before.rsplit('/').next().map(repo_name);
            }
        }
    }
    (effort, number, repo)
}

/// The number, unless a URL named it in a repository other than the
/// session's (`remote`). Where either is not known it is kept.
fn in_repo(number: Option<u64>, named: &Option<String>, remote: Option<&str>) -> Option<u64> {
    match (named, remote.map(repo_name)) {
        (Some(named), Some(here)) if *named != here => None,
        _ => number,
    }
}

/// A repository's name as two of them are compared: `Web.git` → `web`.
fn repo_name(written: &str) -> String {
    let name = written.rsplit('/').next().unwrap_or(written);
    name.trim_end_matches(".git").to_ascii_lowercase()
}

/// True for a pull request's URL, as against a path that has `/pull/` in it.
fn is_pull_url(word: &str) -> bool {
    let web = word.starts_with("https://") || word.starts_with("http://");
    web && word.contains("/pull/")
}

/// `621`, `#528`, or `https://github.com/o/r/pull/621`.
fn pull_number(word: &str) -> Option<u64> {
    let digits = match word.split_once("/pull/") {
        Some((_, rest)) if is_pull_url(word) => rest.split(|c: char| !c.is_ascii_digit()).next()?,
        Some(_) => return None,
        None => word.strip_prefix('#').unwrap_or(word),
    };
    let plain = !digits.is_empty() && digits.len() <= 9;
    if plain && digits.bytes().all(|b| b.is_ascii_digit()) {
        digits.parse().ok().filter(|n| *n > 0)
    } else {
        None
    }
}

/// A review command that forked a subagent to run in, as the transcript's row
/// for it says:
/// `<forked-skill-launch>{"agentId":…,"skillName":…,"description":"/code-review high"}`.
#[derive(Debug, Clone, PartialEq)]
pub struct ForkedLaunch {
    pub command: String,
    /// The arguments as typed.
    pub args: String,
    pub agent_id: Option<String>,
}

/// The forked review command in `said`, if it has one: read here only.
pub fn forked_launch(said: &str) -> Option<ForkedLaunch> {
    const OPEN: &str = "<forked-skill-launch>";
    let start = said.find(OPEN)? + OPEN.len();
    let end = said[start..].find("</forked-skill-launch>")? + start;
    let launch: Value = serde_json::from_str(said[start..end].trim()).ok()?;
    let command = launch["skillName"]
        .as_str()
        .filter(|name| is_review_skill(name))?;
    let typed = launch["description"].as_str().unwrap_or_default();
    Some(ForkedLaunch {
        command: command.to_string(),
        args: slash_command(typed)
            .map_or("", |(_, args)| args)
            .to_string(),
        agent_id: launch["agentId"].as_str().map(String::from),
    })
}

/// A review target as the record names it: `baseBranch` → `base_branch`.
fn target_name(written: &str) -> String {
    let mut name = String::new();
    for c in written.chars() {
        if c.is_ascii_uppercase() && !name.is_empty() {
            name.push('_');
        }
        name.push(c.to_ascii_lowercase());
    }
    name
}

fn ran(command: &str, effort: Option<&str>) -> ReviewRan {
    let last = command.rsplit(':').next().unwrap_or(command);
    if last == "ultrareview" || effort == Some("ultra") {
        ReviewRan::Cloud
    } else {
        ReviewRan::Local
    }
}

/// True for a prompt that is a review command typed as one (`/code-review #41`).
pub fn is_typed_review(prompt: &str) -> bool {
    slash_command(prompt).is_some_and(|(command, _)| is_review(command))
}

/// What the reply that ends a typed review's turn says it found, for the
/// prompt the command was. Every agent's reply is read here, and only the
/// number is kept.
pub fn review_said(prompt_id: &str, reply: &str) -> Option<ReviewSaid> {
    Some(ReviewSaid {
        prompt_id: prompt_id.to_string(),
        findings: findings_in(reply)?,
    })
}

/// The text of a transcript's row: a system row's content, or what a
/// message says.
fn row_text(row: &Value) -> Option<String> {
    match row["type"].as_str() {
        Some("system") => row["content"].as_str().map(String::from),
        _ => match &row["message"]["content"] {
            Value::String(text) => Some(text.clone()),
            Value::Array(blocks) => {
                let texts: Vec<&str> = blocks.iter().filter_map(|b| b["text"].as_str()).collect();
                Some(texts.join("\n"))
            }
            _ => None,
        },
    }
}

/// True for the row of a review command the person typed: the command as
/// typed (`/code-review high`), which is how Claude Code writes it, or the
/// tagged row an older transcript has for it.
pub fn typed_row(row: &Value) -> bool {
    let plain = row["isMeta"].as_bool() != Some(true)
        && row["isCompactSummary"].as_bool() != Some(true)
        && row_text(row).is_some_and(|text| is_typed_review(&text));
    plain || command_row(row).is_some()
}

/// What a typed review that ran where it was typed printed when it ended:
/// the row Claude Code writes for a command's output, where it is that and
/// not the notice of a fork.
pub fn command_output(said: &str) -> Option<&str> {
    const OPEN: &str = "<local-command-stdout>";
    let said = said.trim_start().strip_prefix(OPEN)?;
    if said.contains("<forked-skill-launch>") {
        return None;
    }
    Some(
        said.rsplit_once("</local-command-stdout>")
            .map_or(said, |(out, _)| out),
    )
}

/// A review command in a row Claude Code wrote for a command it ran itself
/// (`/ultrareview`) or an older transcript wrote for a typed one: its name and
/// arguments, as the hooks' `UserPromptExpansion` has them. Other commands
/// (`/model`, `/clear`) are not kept.
pub fn command_row(row: &Value) -> Option<Value> {
    // A summary of what went before quotes the rows of the commands in it.
    if row["isMeta"].as_bool() == Some(true) || row["isCompactSummary"].as_bool() == Some(true) {
        return None;
    }
    let text = row_text(row)?;
    // The row is the command's own: it opens with it, and does not only
    // have it somewhere in what was pasted or quoted.
    const OPENS: &[&str] = &[
        "<command-name>",
        "<command-message>",
        "<local-command-stdout>",
        "<forked-skill-launch>",
    ];
    let opening = text.trim_start();
    if !OPENS.iter().any(|tag| opening.starts_with(tag)) {
        return None;
    }
    let between = |open: &str, close: &str| {
        let start = text.find(open)? + open.len();
        let end = text[start..].find(close)? + start;
        Some(text[start..end].trim().to_string())
    };
    // A typed command that forks says so in a row of its own.
    if text.contains("<forked-skill-launch>") {
        let launch = forked_launch(&text)?;
        return Some(serde_json::json!({
            "expansion_type": "slash_command",
            "command_name": launch.command,
            "command_args": launch.args,
            "forked_agent_id": launch.agent_id,
        }));
    }
    let name = between("<command-name>", "</command-name>")?;
    let name = name.trim_start_matches('/');
    if !is_review(name) {
        return None;
    }
    Some(serde_json::json!({
        "expansion_type": "slash_command",
        "command_name": name,
        "command_args": between("<command-args>", "</command-args>").unwrap_or_default(),
    }))
}

/// The effort Claude Code says it reused for a command typed without one:
/// "Reusing high effort, the level you typed last time."
pub fn reused_effort(said: &str) -> Option<String> {
    let mut words = said.split_whitespace();
    if words.next()? != "Reusing" {
        return None;
    }
    let effort = words.next()?.to_ascii_lowercase();
    (words.next()? == "effort," && EFFORTS.contains(&effort.as_str())).then_some(effort)
}

/// A command the person typed, or that Claude Code ran.
#[derive(Debug, Clone)]
struct Typed {
    prompt_id: Option<String>,
    at: Option<DateTime<Utc>>,
    command: String,
    effort: Option<String>,
    pull_number: Option<u64>,
    /// The repository a URL named the number in, where one did.
    repo: Option<String>,
    /// The subagent the command forked to run in, where that is known.
    fork: Option<String>,
}

/// What the events show about review runs, gathered while they are read.
#[derive(Debug, Default)]
pub struct Seen {
    /// Skill calls of a review command: tool-use id → effort, number, and
    /// the repository a URL named the number in.
    skill_calls: HashMap<String, Args>,
    /// Subagents a call started (an `Agent` call, or a skill that forked):
    /// the subagent's id → the call's tool-use id.
    started_by: HashMap<String, String>,
    /// `ReportFindings` calls: tool-use id → how many findings.
    findings: HashMap<String, u64>,
    typed: Vec<Typed>,
}

impl Seen {
    /// True when the events showed no review command at all.
    pub fn is_empty(&self) -> bool {
        self.skill_calls.is_empty() && self.typed.is_empty()
    }

    /// Take in one event of a session from `source`.
    pub fn event(&mut self, source: &str, hook: &str, p: &Value, at: Option<DateTime<Utc>>) {
        let id = p["tool_use_id"].as_str().filter(|id| !id.is_empty());
        match (hook, id) {
            ("PreToolUse" | "PostToolUse" | "PostToolUseFailure", Some(id)) => {
                let input = &p["tool_input"];
                match p["tool_name"].as_str() {
                    Some("Skill") => {
                        if input["skill"].as_str().is_some_and(is_review_skill) {
                            let args = input["args"].as_str().unwrap_or_default();
                            self.skill_calls.insert(id.into(), parse_args_of(args));
                        }
                    }
                    Some("ReportFindings") => {
                        if let Some(list) = input["findings"].as_array() {
                            self.findings.insert(id.into(), list.len() as u64);
                        }
                    }
                    _ => {}
                }
                if let Some(agent) = p["tool_response"]["agentId"].as_str() {
                    // The first to name it started it: a later call may
                    // only be talking to it.
                    self.started_by
                        .entry(agent.into())
                        .or_insert_with(|| id.into());
                }
            }
            // Codex's `/review` is no prompt: it is in the rollout's review
            // mode, which the transcript's facts have.
            // Codex's own command is not in what it writes down; a prompt
            // that names it would count that review a second time.
            _ if source == crate::paths::CODEX => {}
            // Typed in Claude Code, Cursor or Grok: the prompt is the command.
            // Cursor's files wrap it in `<user_query>`, which the import has
            // taken off, and its hooks have it bare.
            ("UserPromptSubmit", _) => {
                if let Some((name, args)) = p["prompt"].as_str().and_then(slash_command) {
                    self.typed(p, at, name, args, false);
                }
            }
            ("UserPromptExpansion", _) if source == crate::paths::CLAUDE_CODE => {
                let kind = p["expansion_type"].as_str().unwrap_or("slash_command");
                if let (Some(name), "slash_command") = (p["command_name"].as_str(), kind) {
                    let args = p["command_args"].as_str().unwrap_or_default();
                    // Claude Code names the command here: it is a name, as a
                    // skill's is, and not what someone typed.
                    let known = self.typed(p, at, name.trim_start_matches('/'), args, true);
                    // Written by the import, from the row that says where it
                    // forked: of the command this one is, and no other.
                    if let (Some(fork), Some(typed), true) =
                        (p["forked_agent_id"].as_str(), self.typed.last_mut(), known)
                    {
                        typed.fork.get_or_insert_with(|| fork.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    /// Take in a typed command, if it is a review: true when it is, and the
    /// record of it is then the last. `named` for a command Claude Code
    /// names, which may be a plugin's with a dot in it; what is typed may not.
    fn typed(
        &mut self,
        p: &Value,
        at: Option<DateTime<Utc>>,
        name: &str,
        args: &str,
        named: bool,
    ) -> bool {
        if !named_review(name, named) {
            return false;
        }
        // The name alone, as it is checked.
        let name = name.trim();
        let name = name.strip_prefix('/').unwrap_or(name);
        let prompt_id = p["prompt_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .map(String::from);
        let (effort, pull_number, repo) = parse_args_of(args);
        // The hooks see a typed command twice: as the prompt and as its
        // expansion. The same command with other arguments, typed a moment
        // later, is another run.
        let again = self.typed.iter().position(|t| {
            t.command == name
                && match (&t.prompt_id, &prompt_id) {
                    (Some(a), Some(b)) => a == b,
                    _ => match (t.at, at) {
                        (Some(a), Some(b)) => {
                            (a - b).num_seconds().abs() <= SAME_START_SECONDS
                                && (&t.effort, t.pull_number, &t.repo)
                                    == (&effort, pull_number, &repo)
                        }
                        _ => false,
                    },
                }
        });
        if let Some(i) = again {
            // Last, so that what is said of it next is said of this one.
            let mut typed = self.typed.remove(i);
            // The id of whichever of the two had one: a later prompt with
            // another id is then another run.
            typed.prompt_id = typed.prompt_id.or(prompt_id);
            // The later of the two times: the turn's own prompt is then not
            // after it, and is not taken for the next one.
            typed.at = typed.at.max(at);
            self.typed.push(typed);
            return true;
        }
        self.typed.push(Typed {
            prompt_id,
            at,
            command: name.to_string(),
            effort,
            pull_number,
            repo,
            fork: None,
        });
        true
    }
}

/// The session's review runs, in the order they started. `s` is complete:
/// its tool calls, prompts and subagents with their costs. `facts` are what
/// the transcript adds, where there is one: the subagent a typed command
/// forked, the effort Claude Code reused for one typed without, and how many
/// findings a review's last reply names.
pub fn runs(s: &Session, seen: &Seen, facts: Option<&Facts>) -> Vec<ReviewRun> {
    let mut runs: Vec<ReviewRun> = Vec::new();
    // The subagent a run forked to run in, by the run's id.
    let mut forks: HashMap<String, &str> = HashMap::new();
    for (agent, call) in &seen.started_by {
        if seen.skill_calls.contains_key(call) {
            forks.insert(call.clone(), agent);
        }
    }
    // A URL of a pull request in another repository names none of this
    // one's: by name, since a fork has its own owner.
    let here = s.repo.as_ref().and_then(|r| r.remote.as_deref());
    let of_here = |number: Option<u64>, repo: &Option<String>| in_repo(number, repo, here);
    // One that named a pull request of another repository names none of this
    // one's, and is not one that named none either: it says what it was of.
    let elsewhere = |number: Option<u64>, repo: &Option<String>| {
        let dropped = number.is_some() && of_here(number, repo).is_none();
        dropped.then(|| OTHER_REPOSITORY.to_string())
    };
    for call in &s.tool_calls {
        let Some((effort, number, repo)) = seen.skill_calls.get(&call.tool_use_id) else {
            continue;
        };
        let pull_number = &of_here(*number, repo);
        let command = call.skill.clone().unwrap_or_default();
        runs.push(ReviewRun {
            id: call.tool_use_id.clone(),
            at: call.at,
            ran: ran(&command, effort.as_deref()),
            command,
            via: ReviewVia::Skill,
            effort: effort.clone(),
            pull_number: *pull_number,
            target: elsewhere(*number, repo),
            agent_id: call.agent_id.clone(),
            status: call.status,
            duration_ms: call.duration_ms,
            ..Default::default()
        });
    }

    let next_prompt = |at: Option<DateTime<Utc>>| {
        let at = at?;
        s.prompts
            .iter()
            .filter_map(|p| p.at)
            .filter(|t| *t > at)
            .min()
    };
    let typed = typed_with(seen, facts, &next_prompt);
    // The prompt of a typed command that a call's run stands for, by the run's id.
    let mut prompts: HashMap<String, &str> = HashMap::new();
    for typed in &typed {
        let ran_at = ran(&typed.command, typed.effort.as_deref());
        // `/ultrareview` leads to a skill call in the same turn: one start.
        // A command that forked ran where it forked, and led to no call.
        let end = next_prompt(typed.at);
        let number = of_here(typed.pull_number, &typed.repo);
        // The call is what the command led to only as the first thing the
        // main thread did in its turn: one made after other work is a review
        // the agent ran again.
        let first_done = |id: &str, at: Option<DateTime<Utc>>| {
            !s.tool_calls.iter().any(|c| {
                c.agent_id.is_none() && c.tool_use_id != id && c.at >= typed.at && c.at < at
            })
        };
        let same_start = runs.iter_mut().find(|r| {
            typed.fork.is_none()
                && first_done(&r.id, r.at)
                && r.via == ReviewVia::Skill
                && r.agent_id.is_none()
                && r.ran == ran_at
                && (r.ran == ReviewRan::Cloud || r.command == typed.command)
                // One for another pull request is another review.
                && r.pull_number
                    .zip(number)
                    .is_none_or(|(call, start)| call == start)
                && match (r.at, typed.at) {
                    (Some(call), Some(start)) => call >= start && end.is_none_or(|e| call < e),
                    _ => false,
                }
        });
        if let Some(run) = same_start {
            // It keeps the call's id: what is said of the prompt is said of it.
            if let Some(prompt) = &typed.prompt_id {
                prompts.insert(run.id.clone(), prompt.as_str());
            }
            run.via = ReviewVia::SlashCommand;
            run.at = typed.at;
            run.command = typed.command.clone();
            run.effort = run.effort.take().or(typed.effort.clone());
            run.pull_number = run.pull_number.or(number);
            run.target = run
                .target
                .take()
                .or(elsewhere(typed.pull_number, &typed.repo));
            // One of the two named a pull request here: it is that one's,
            // whatever the other named elsewhere.
            if run.pull_number.is_some() && run.target.as_deref() == Some(OTHER_REPOSITORY) {
                run.target = None;
            }
            continue;
        }
        let id = match &typed.prompt_id {
            Some(id) => id.clone(),
            None => format!(
                "{}@{}",
                typed.command,
                typed.at.map(|t| t.to_rfc3339()).unwrap_or_default()
            ),
        };
        if let Some(fork) = &typed.fork {
            forks.insert(id.clone(), fork);
        }
        runs.push(ReviewRun {
            id,
            at: typed.at,
            command: typed.command.clone(),
            via: ReviewVia::SlashCommand,
            ran: ran_at,
            effort: typed.effort.clone(),
            pull_number: number,
            target: elsewhere(typed.pull_number, &typed.repo),
            status: typed_status(s, typed),
            ..Default::default()
        });
    }
    let modes = facts.filter(|_| s.source == crate::paths::CODEX);
    let modes = modes.map_or(&[][..], |facts| &facts.review_modes);
    let reviewers = facts.map(|facts| reviewers_of(modes, facts));
    for (i, review) in modes.iter().enumerate() {
        if modes[..i].iter().any(|before| before.id == review.id) {
            continue;
        }
        if let Some(agent) = reviewers.as_ref().and_then(|of| of[i]) {
            forks.insert(review.id.clone(), agent);
        }
        runs.push(ReviewRun {
            id: review.id.clone(),
            at: review.at,
            command: "review".into(),
            via: ReviewVia::CodexReview,
            ran: ReviewRan::Local,
            target: review.target.as_deref().map(target_name),
            // Left without an end: the session stopped while it ran. Left
            // with nothing returned: it was interrupted.
            status: match review.ended_at {
                Some(_) if !review.interrupted => ToolStatus::Ok,
                Some(_) => ToolStatus::Interrupted,
                None => ToolStatus::NoResult,
            },
            duration_ms: review
                .at
                .zip(review.ended_at)
                .map(|(start, end)| (end - start).num_milliseconds().max(0) as u64),
            findings: review.findings,
            ..Default::default()
        });
    }
    runs.sort_by(|a, b| a.at.cmp(&b.at).then(a.id.cmp(&b.id)));
    measure(&mut runs, s, seen, &forks, &prompts, facts);
    runs
}

/// The thread each of Codex's reviews ran in: the reviewer that began while
/// the review was on, or a moment before it, each one once.
fn reviewers_of<'a>(modes: &[ReviewMode], facts: &'a Facts) -> Vec<Option<&'a str>> {
    let mut free: Vec<&ReviewerThread> = facts.reviewer_threads.iter().collect();
    free.sort_by_key(|thread| thread.began);
    let mut of = Vec::with_capacity(modes.len());
    for (i, review) in modes.iter().enumerate() {
        // Written down twice: the first has its reviewer, and this takes none.
        if modes[..i].iter().any(|before| before.id == review.id) {
            of.push(None);
            continue;
        }
        // One left without an end was on until the next one began.
        let next = modes.get(i + 1).and_then(|r| r.at);
        let within = |began: Option<DateTime<Utc>>| {
            let (Some(began), Some(start)) = (began, review.at) else {
                return false;
            };
            (start - began).num_seconds() <= SAME_START_SECONDS
                && match review.ended_at {
                    Some(end) => began <= end,
                    None => {
                        next.is_none_or(|next| (next - began).num_seconds() > SAME_START_SECONDS)
                    }
                }
        };
        let ran_in = free.iter().position(|thread| within(thread.began));
        of.push(ran_in.map(|i| free.remove(i).agent_id.as_str()));
    }
    of
}

/// How a typed command went: as its turn did, where the session has it. A
/// turn that failed is a review that failed, and one with no end yet (still
/// running, or interrupted) has no result. A command that is no prompt of
/// the session's (one Claude Code ran itself) is taken to have run.
///
/// In Claude Code a turn with no end says nothing: a typed command forks, and
/// the turn that ends is the one its subagent's notice starts, under another
/// prompt's id. There only a failure is told.
fn typed_status(s: &Session, typed: &Typed) -> ToolStatus {
    let forks = s.source == crate::paths::CLAUDE_CODE;
    let id = typed.prompt_id.as_deref();
    let turn = s
        .prompts
        .iter()
        .find(|p| id.is_some() && p.prompt_id.as_deref() == id);
    match turn.map(|p| p.outcome) {
        Some(Some(Outcome::ApiError)) => ToolStatus::Failed,
        Some(None) if !forks => ToolStatus::NoResult,
        _ => ToolStatus::Ok,
    }
}

/// The typed commands, with what the transcript says of each: where it
/// forked, if the events did not say, and the effort it reused.
fn typed_with(
    seen: &Seen,
    facts: Option<&Facts>,
    next_prompt: &dyn Fn(Option<DateTime<Utc>>) -> Option<DateTime<Utc>>,
) -> Vec<Typed> {
    let mut typed = seen.typed.clone();
    let Some(facts) = facts else {
        return typed;
    };
    let mut taken: HashSet<String> = typed.iter().filter_map(|t| t.fork.clone()).collect();
    // Each note of a reused effort is one turn's.
    let mut noted: HashSet<usize> = HashSet::new();
    for t in &mut typed {
        let Some(start) = t.at else {
            continue;
        };
        let end = next_prompt(t.at);
        // The row is written as the command starts, a moment either side of
        // the prompt's own time.
        let in_turn = |at: Option<DateTime<Utc>>| {
            at.is_some_and(|at| {
                (start - at).num_seconds() <= SAME_START_SECONDS && end.is_none_or(|e| at < e)
            })
        };
        if t.fork.is_none() {
            let launch = facts.review_launches.iter().find(|l| {
                !taken.contains(l.agent_id.as_str())
                    && l.command == t.command
                    && in_turn(l.at)
                    && (&l.effort, l.pull_number) == (&t.effort, t.pull_number)
            });
            if let Some(launch) = launch {
                taken.insert(launch.agent_id.clone());
                t.fork = Some(launch.agent_id.clone());
            }
        }
        if t.effort.is_none() {
            // The one said after the command started, before one a moment
            // ahead of it; of those, the nearest.
            let reused = facts
                .reused_efforts
                .iter()
                .enumerate()
                .filter(|(i, r)| !noted.contains(i) && in_turn(r.at))
                .min_by_key(|(_, r)| {
                    let apart = r.at.map_or(0, |at| (at - start).num_milliseconds());
                    (apart < 0, apart.abs())
                });
            if let Some((i, reused)) = reused {
                noted.insert(i);
                t.effort = Some(reused.effort.clone());
            }
        }
    }
    typed
}

/// Each run's subagents, their cost and time, and its findings.
fn measure(
    runs: &mut [ReviewRun],
    s: &Session,
    seen: &Seen,
    forks: &HashMap<String, &str>,
    prompts: &HashMap<String, &str>,
    facts: Option<&Facts>,
) {
    let calls: HashMap<&str, &crate::session::ToolCall> = s
        .tool_calls
        .iter()
        .map(|c| (c.tool_use_id.as_str(), c))
        .collect();
    // A subagent's thread (none: the main one) and when it was started from
    // there, where a call says it started it.
    let parent: HashMap<&str, (Option<&str>, Option<DateTime<Utc>>)> = seen
        .started_by
        .iter()
        .filter_map(|(agent, call)| {
            let call = calls.get(call.as_str())?;
            Some((agent.as_str(), (call.agent_id.as_deref(), call.at)))
        })
        .collect();
    let forked: HashSet<&str> = forks.values().copied().collect();
    let next_prompt = |at: DateTime<Utc>| s.prompts.iter().filter_map(|p| p.at).find(|t| *t > at);
    // The run a thing that happened at `at` in `thread` belongs to: the
    // latest run of that thread started before it, and in the main thread
    // before the person's next prompt. A review in the cloud has no
    // subagents here but the one it forked (`local`).
    // `by_time`: a subagent whose start is known only by its first row,
    // which may be written a moment before the prompt that started it.
    let owner = |thread: Option<&str>,
                 at: Option<DateTime<Utc>>,
                 local: bool,
                 by_time: bool|
     -> Option<usize> {
        let at = at?;
        let early = chrono::Duration::milliseconds(if by_time { STARTED_EARLY_MS } else { 0 });
        let i = runs.iter().rposition(|r| {
            r.agent_id.as_deref() == thread
                && r.at.is_some_and(|t| {
                    // Only a typed command's own row is written late.
                    let typed = r.via == ReviewVia::SlashCommand;
                    t <= at || (typed && t <= at + early)
                })
                && !(local && r.ran == ReviewRan::Cloud)
        })?;
        let start = runs[i].at?;
        let in_turn = thread.is_some() || next_prompt(start).is_none_or(|end| at < end);
        in_turn.then_some(i)
    };

    let mut members: Vec<HashSet<&str>> = vec![HashSet::new(); runs.len()];
    for (i, run) in runs.iter().enumerate() {
        if let Some(fork) = forks.get(run.id.as_str()) {
            members[i].insert(fork);
        }
    }
    for sub in &s.subagents {
        let id = sub.agent_id.as_str();
        if forked.contains(id) {
            continue;
        }
        // Not known who started it: by time, and only for the main thread.
        let i = match parent.get(id) {
            Some((thread, at)) => owner(*thread, *at, true, false),
            None => owner(None, sub.started_at, true, true),
        };
        if let Some(i) = i.filter(|i| !forks.contains_key(runs[*i].id.as_str())) {
            members[i].insert(id);
        }
    }
    // And whatever those subagents started in turn.
    for set in &mut members {
        loop {
            let more: Vec<&str> = parent
                .iter()
                .filter(|(agent, (thread, _))| {
                    !set.contains(*agent) && thread.is_some_and(|t| set.contains(t))
                })
                .map(|(agent, _)| *agent)
                .collect();
            if more.is_empty() {
                break;
            }
            set.extend(more);
        }
    }

    // A review that ran inside another's subagent has its own: they are
    // not the outer one's too, or their cost would be in both.
    let whole = members.clone();
    for (i, set) in members.iter_mut().enumerate() {
        for (j, run) in runs.iter().enumerate() {
            let inside = run
                .agent_id
                .as_deref()
                .is_some_and(|t| whole[i].contains(t));
            if i != j && inside {
                set.retain(|agent| !whole[j].contains(agent));
            }
        }
    }

    let mut findings: Vec<Option<u64>> = vec![None; runs.len()];
    for (call, n) in &seen.findings {
        let Some(call) = calls.get(call.as_str()) else {
            continue;
        };
        // One that failed or was refused reported nothing: it is made again.
        if call.status != ToolStatus::Ok {
            continue;
        }
        let thread = call.agent_id.as_deref();
        let i = thread
            .and_then(|t| members.iter().position(|m| m.contains(t)))
            .or_else(|| owner(thread, call.at, false, false));
        if let Some(i) = i {
            *findings[i].get_or_insert(0) += n;
        }
    }

    for (i, run) in runs.iter_mut().enumerate() {
        let subs: Vec<_> = s
            .subagents
            .iter()
            .filter(|sub| members[i].contains(sub.agent_id.as_str()))
            .collect();
        run.subagents = subs.len() as u64;
        let costs: Vec<f64> = subs.iter().filter_map(|s| s.estimated_cost_usd).collect();
        run.estimated_cost_usd = match run.ran {
            ReviewRan::Local if !costs.is_empty() => {
                // To a millionth of a dollar: the same session gives the same upload.
                Some((costs.iter().sum::<f64>() * 1e6).round() / 1e6)
            }
            _ => None,
        };
        let last_end = subs.iter().filter_map(|s| s.ended_at).max();
        // Codex says itself when a review ended: one it did not end has no duration.
        let timed = run.via == ReviewVia::CodexReview;
        if let (Some(start), Some(end), false) = (run.at, last_end, timed) {
            if end > start {
                run.duration_ms = Some((end - start).num_milliseconds() as u64);
            }
        }
        // A review that forked took as long as its fork did. Where that
        // one's end is not known, neither is how long the review took: the
        // call's own time is only what it took to start it.
        if let (Some(fork), false) = (forks.get(run.id.as_str()), timed) {
            let ended = subs
                .iter()
                .any(|s| s.agent_id == *fork && s.ended_at.is_some());
            if !ended {
                run.duration_ms = None;
            }
        }
        // Reported as a list, or else what the last reply of the subagent
        // the review ran in says.
        // Where it forked none, what the main thread's reply to it says.
        run.findings = run.findings.or(findings[i]).or_else(|| {
            let facts = facts?;
            match forks.get(run.id.as_str()) {
                Some(fork) => {
                    let said = facts.subagents.iter().find(|sub| sub.agent_id == *fork)?;
                    said.findings
                }
                None => {
                    let prompt = prompts.get(run.id.as_str()).copied().unwrap_or(&run.id);
                    let said = facts
                        .review_replies
                        .iter()
                        .find(|r| r.prompt_id == prompt)?;
                    Some(said.findings)
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::from_events;
    use crate::transcript::{Facts, SubagentFacts};
    use serde_json::json;

    fn event(second: u32, hook: &str, mut payload: Value) -> Value {
        payload["session_id"] = json!("s1");
        json!({
            "v": 1, "source": "claude-code", "hook": hook, "session_id": "s1",
            "received_at": format!("2026-11-20T10:{:02}:{:02}.000000Z", second / 60, second % 60),
            "payload": payload,
        })
    }

    fn prompt(second: u32, id: &str, text: &str) -> Value {
        event(
            second,
            "UserPromptSubmit",
            json!({ "prompt_id": id, "prompt": text }),
        )
    }

    /// A Skill call and its result; `fork` is the subagent it forked.
    fn skill(second: u32, id: &str, name: &str, args: &str, fork: Option<&str>) -> [Value; 2] {
        let input = json!({ "skill": name, "args": args });
        let mut response = json!({ "success": true, "commandName": name });
        if let Some(fork) = fork {
            response["status"] = json!("forked");
            response["agentId"] = json!(fork);
        }
        let call = json!({ "tool_use_id": id, "tool_name": "Skill", "tool_input": input });
        let mut done = call.clone();
        done["tool_response"] = response;
        [
            event(second, "PreToolUse", call),
            event(second, "PostToolUse", done),
        ]
    }

    /// An Agent call from `thread` (none: the main one) that started `agent`.
    fn agent_call(second: u32, id: &str, thread: Option<&str>, agent: &str) -> [Value; 2] {
        let mut call = json!({ "tool_use_id": id, "tool_name": "Agent",
                               "tool_input": { "description": "look" } });
        if let Some(thread) = thread {
            call["agent_id"] = json!(thread);
        }
        let mut done = call.clone();
        done["tool_response"] = json!({ "status": "completed", "agentId": agent });
        [
            event(second, "PreToolUse", call),
            event(second, "PostToolUse", done),
        ]
    }

    fn subagent(start: u32, end: u32, id: &str) -> [Value; 2] {
        let who = json!({ "agent_id": id, "agent_type": "general-purpose" });
        [
            event(start, "SubagentStart", who.clone()),
            event(end, "SubagentStop", who),
        ]
    }

    fn costs(of: &[(&str, f64)]) -> Facts {
        Facts {
            subagents: of
                .iter()
                .map(|(id, usd)| SubagentFacts {
                    agent_id: id.to_string(),
                    estimated_cost_usd: Some(*usd),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    fn session(events: Vec<Vec<Value>>, facts: Option<&Facts>) -> Session {
        let events: Vec<Value> = events.into_iter().flatten().collect();
        from_events(&events, facts, "claude-code").unwrap()
    }

    #[test]
    fn a_review_skill_call_is_a_run_and_another_skill_is_not() {
        let s = session(
            vec![
                vec![prompt(0, "p1", "review it")],
                skill(1, "t1", "code-review", "xhigh #621", None).into(),
                skill(2, "t2", "simplify", "", None).into(),
            ],
            None,
        );
        assert_eq!(s.counts.reviews, Some(1));
        let run = &s.reviews[0];
        assert_eq!(
            (
                run.id.as_str(),
                run.command.as_str(),
                run.via,
                run.ran,
                run.effort.as_deref(),
                run.pull_number,
                run.status
            ),
            (
                "t1",
                "code-review",
                ReviewVia::Skill,
                ReviewRan::Local,
                Some("xhigh"),
                Some(621),
                ToolStatus::Ok
            )
        );
        let skills: Vec<_> = s.tool_calls.iter().map(|c| c.skill.as_deref()).collect();
        assert_eq!(skills, [Some("code-review"), Some("simplify")]);
    }

    #[test]
    fn the_same_call_on_several_rows_is_one_run() {
        let [pre, post] = skill(1, "t1", "code-review", "high", None);
        let s = session(vec![vec![pre.clone(), pre, post.clone(), post]], None);
        assert_eq!(s.reviews.len(), 1);
    }

    #[test]
    fn a_forked_review_costs_what_its_subagents_cost() {
        let facts = costs(&[
            ("fork", 1.5),
            ("child", 0.25),
            ("other", 9.0),
            ("later", 4.0),
        ]);
        let s = session(
            vec![
                vec![prompt(0, "p1", "review the pull request")],
                skill(1, "t1", "code-review", "high 7", Some("fork")).into(),
                subagent(2, 60, "fork").into(),
                // the fork's own subagent, started after the person's next prompt
                agent_call(45, "a1", Some("fork"), "child").into(),
                subagent(45, 90, "child").into(),
                // the main thread's own subagent in the same turn
                agent_call(5, "a2", None, "other").into(),
                subagent(5, 8, "other").into(),
                vec![prompt(40, "p2", "next")],
                subagent(50, 55, "later").into(),
            ],
            Some(&facts),
        );
        let run = &s.reviews[0];
        assert_eq!(run.subagents, 2);
        assert_eq!(run.estimated_cost_usd, Some(1.75));
        assert_eq!(
            run.duration_ms,
            Some(89_000),
            "until its last subagent ended"
        );
    }

    #[test]
    fn without_a_fork_the_subagents_are_those_of_its_turn() {
        let facts = costs(&[("in", 2.0), ("deep", 0.5), ("out", 3.0), ("none", 0.0)]);
        let s = session(
            vec![
                vec![prompt(0, "p1", "go")],
                subagent(1, 2, "before").into(),
                skill(3, "t1", "code-review", "", None).into(),
                agent_call(4, "a1", None, "in").into(),
                subagent(4, 20, "in").into(),
                agent_call(6, "a2", Some("in"), "deep").into(),
                subagent(6, 10, "deep").into(),
                vec![prompt(30, "p2", "thanks")],
                subagent(31, 32, "out").into(),
            ],
            Some(&facts),
        );
        let run = &s.reviews[0];
        assert_eq!(run.subagents, 2);
        assert_eq!(run.estimated_cost_usd, Some(2.5));
    }

    #[test]
    fn a_review_with_no_priced_subagent_has_no_cost() {
        let s = session(
            vec![
                skill(1, "t1", "code-review", "", Some("fork")).into(),
                subagent(2, 3, "fork").into(),
            ],
            None,
        );
        assert_eq!(
            (s.reviews[0].subagents, s.reviews[0].estimated_cost_usd),
            (1, None)
        );
    }

    #[test]
    fn a_run_in_a_subagent_is_marked_and_owns_what_it_started() {
        let facts = costs(&[("rev", 1.0), ("fork", 2.0), ("sibling", 5.0)]);
        let [pre, post] = skill(10, "t1", "code-review", "high #751", Some("fork"));
        let in_sub = |mut e: Value| {
            e["payload"]["agent_id"] = json!("rev");
            e
        };
        let s = session(
            vec![
                vec![prompt(0, "p1", "review 751 and 752")],
                agent_call(1, "a1", None, "rev").into(),
                agent_call(1, "a2", None, "sibling").into(),
                subagent(2, 100, "rev").into(),
                subagent(2, 100, "sibling").into(),
                vec![in_sub(pre), in_sub(post)],
                subagent(11, 50, "fork").into(),
            ],
            Some(&facts),
        );
        let run = &s.reviews[0];
        assert_eq!(run.agent_id.as_deref(), Some("rev"));
        assert_eq!((run.subagents, run.estimated_cost_usd), (1, Some(2.0)));
    }

    #[test]
    fn a_typed_command_is_one_run_however_the_hooks_see_it() {
        let s = session(
            vec![
                vec![
                    prompt(0, "p1", "/code-review xhigh #590"),
                    event(
                        0,
                        "UserPromptExpansion",
                        json!({ "prompt_id": "p1", "expansion_type": "slash_command",
                                "command_name": "code-review", "command_args": "xhigh #590" }),
                    ),
                    prompt(5, "p2", "/model"),
                    event(
                        5,
                        "UserPromptExpansion",
                        json!({ "prompt_id": "p2", "command_name": "model" }),
                    ),
                ],
                subagent(1, 30, "fork").into(),
            ],
            Some(&costs(&[("fork", 3.0)])),
        );
        assert_eq!(s.reviews.len(), 1);
        let run = &s.reviews[0];
        assert_eq!(
            (
                run.id.as_str(),
                run.via,
                run.effort.as_deref(),
                run.pull_number
            ),
            ("p1", ReviewVia::SlashCommand, Some("xhigh"), Some(590))
        );
        assert_eq!(run.estimated_cost_usd, Some(3.0));
    }

    #[test]
    fn ultrareview_runs_in_the_cloud_and_its_skill_call_is_the_same_start() {
        let expansion = |second: u32, args: &str| {
            event(
                second,
                "UserPromptExpansion",
                json!({ "command_name": "ultrareview", "command_args": args }),
            )
        };
        let alone = session(
            vec![vec![expansion(1, "#2")], subagent(2, 3, "nearby").into()],
            None,
        );
        let run = &alone.reviews[0];
        assert_eq!(
            (run.ran, run.via, run.pull_number, run.estimated_cost_usd),
            (ReviewRan::Cloud, ReviewVia::SlashCommand, Some(2), None)
        );
        assert_eq!(run.subagents, 0, "what runs here is not the cloud's");

        let facts = costs(&[("fork", 1.0)]);
        let s = session(
            vec![
                vec![expansion(1, "#2")],
                skill(2, "t1", "code-review", "ultra #2", Some("fork")).into(),
                subagent(3, 4, "fork").into(),
                // a later turn's cloud review is a run of its own
                vec![prompt(10, "p2", "again")],
                skill(11, "t2", "code-review", "ultra", None).into(),
            ],
            Some(&facts),
        );
        assert_eq!(s.reviews.len(), 2);
        let first = &s.reviews[0];
        assert_eq!(
            (
                first.id.as_str(),
                first.command.as_str(),
                first.via,
                first.ran
            ),
            (
                "t1",
                "ultrareview",
                ReviewVia::SlashCommand,
                ReviewRan::Cloud
            )
        );
        assert_eq!(first.at, alone.reviews[0].at);
        // a cloud review's cost is not known, even with a local subagent
        assert_eq!((first.subagents, first.estimated_cost_usd), (1, None));
        assert_eq!(s.reviews[1].via, ReviewVia::Skill);
    }

    #[test]
    fn findings_are_counted_where_the_review_reports_them() {
        let report = |second: u32, id: &str, thread: Option<&str>, n: usize| {
            let mut call = json!({ "tool_use_id": id, "tool_name": "ReportFindings",
                                   "tool_input": { "findings": vec![json!({}); n] } });
            if let Some(thread) = thread {
                call["agent_id"] = json!(thread);
            }
            vec![
                event(second, "PreToolUse", call.clone()),
                event(second, "PostToolUse", call),
            ]
        };
        // one that failed reported nothing: it is made again
        let failed = event(
            7,
            "PostToolUseFailure",
            json!({ "tool_use_id": "r0", "tool_name": "ReportFindings", "agent_id": "fork",
                    "tool_input": { "findings": [{}, {}, {}] }, "error": "invalid" }),
        );
        let s = session(
            vec![
                vec![prompt(0, "p1", "review both")],
                skill(1, "t1", "code-review", "", Some("fork")).into(),
                subagent(2, 9, "fork").into(),
                vec![failed],
                report(8, "r1", Some("fork"), 3),
                skill(10, "t2", "code-review", "", None).into(),
                report(12, "r2", None, 2),
                vec![prompt(20, "p2", "ok")],
                skill(21, "t3", "code-review", "", None).into(),
                // a later turn reports nothing for t3
                vec![prompt(30, "p3", "and?")],
                report(31, "r3", None, 5),
            ],
            None,
        );
        let found: Vec<_> = s.reviews.iter().map(|r| r.findings).collect();
        assert_eq!(found, [Some(3), Some(2), None]);
    }

    #[test]
    fn a_prompt_that_names_codexs_review_is_not_a_run_of_its_own() {
        let mut e = prompt(0, "p1", "/review");
        e["source"] = json!("codex");
        let s = from_events(&[e], None, "codex").unwrap();
        assert!(s.reviews.is_empty());
    }

    #[test]
    fn a_forked_launch_names_the_command_its_arguments_and_the_subagent() {
        let row = |skill: &str| {
            format!(
                "<forked-skill-launch>{{\"agentId\":\"a1\",\"skillName\":\"{skill}\",\
                 \"description\":\"/{skill} high #7\"}}</forked-skill-launch>"
            )
        };
        assert_eq!(
            forked_launch(&row("code-review")),
            Some(ForkedLaunch {
                command: "code-review".into(),
                args: "high #7".into(),
                agent_id: Some("a1".into()),
            })
        );
        assert_eq!(forked_launch(&row("deploy")), None);
        assert_eq!(forked_launch("<forked-skill-launch>not json"), None);
    }

    #[test]
    fn a_url_of_another_repositorys_pull_request_names_none_of_this_one() {
        let (_, number, repo) = parse_args_of("high https://github.com/acme/api/pull/41");
        assert_eq!((number, repo.as_deref()), (Some(41), Some("api")));
        let web = Some("github.com/acme/web");
        assert_eq!(in_repo(number, &repo, web), None);
        assert_eq!(
            in_repo(number, &repo, Some("github.com/acme/API.git")),
            Some(41)
        );
        // a fork has its own owner and the same name
        assert_eq!(in_repo(number, &repo, Some("github.com/ann/api")), Some(41));
        // not known where the session is: kept
        assert_eq!(in_repo(number, &repo, None), Some(41));
        // a bare number is this repository's
        let (_, number, repo) = parse_args_of("#41");
        assert_eq!(in_repo(number, &repo, web), Some(41));
    }

    #[test]
    fn a_command_seen_a_moment_before_its_prompt_keeps_its_turn() {
        let s = session(
            vec![
                vec![
                    event(
                        0,
                        "UserPromptExpansion",
                        json!({ "prompt_id": "p1", "command_name": "code-review",
                                "command_args": "" }),
                    ),
                    prompt(1, "p1", "/code-review"),
                ],
                subagent(2, 30, "fork").into(),
            ],
            Some(&costs(&[("fork", 3.0)])),
        );
        assert_eq!(s.reviews.len(), 1);
        assert_eq!(
            (s.reviews[0].subagents, s.reviews[0].estimated_cost_usd),
            (1, Some(3.0))
        );
    }

    #[test]
    fn a_subagent_is_the_run_that_started_it_whoever_talks_to_it_later() {
        let facts = costs(&[("x", 2.0)]);
        let mut again = agent_call(60, "a2", None, "x");
        again[0]["payload"]["tool_name"] = json!("SendMessage");
        again[1]["payload"]["tool_name"] = json!("SendMessage");
        let s = session(
            vec![
                vec![prompt(0, "p1", "review it twice")],
                skill(1, "t1", "code-review", "", None).into(),
                agent_call(2, "a1", None, "x").into(),
                subagent(3, 40, "x").into(),
                skill(50, "t2", "code-review", "", None).into(),
                again.into(),
            ],
            Some(&facts),
        );
        let costs: Vec<_> = s.reviews.iter().map(|r| r.estimated_cost_usd).collect();
        assert_eq!(costs, [Some(2.0), None]);
    }

    #[test]
    fn a_typed_command_in_claude_code_ran_though_its_own_turn_has_no_end() {
        // It forked: the turn that ends is another prompt's.
        let s = session(
            vec![
                vec![prompt(0, "p1", "/code-review high #46")],
                subagent(1, 110, "fork").into(),
            ],
            None,
        );
        assert_eq!(s.reviews[0].status, ToolStatus::Ok);
    }

    #[test]
    fn a_review_the_agent_runs_again_later_in_the_turn_is_another_run() {
        let bash = |second: u32, id: &str| {
            let call = json!({ "tool_use_id": id, "tool_name": "Bash",
                               "tool_input": { "command": "cargo test" } });
            [
                event(second, "PreToolUse", call.clone()),
                event(second, "PostToolUse", call),
            ]
        };
        let s = session(
            vec![
                vec![prompt(0, "p1", "/code-review high")],
                bash(100, "b1").into(),
                skill(600, "t1", "code-review", "high", Some("again")).into(),
                // straight after a typed command, the call is what it led to
                vec![prompt(700, "p2", "/code-review high")],
                skill(703, "t2", "code-review", "high", None).into(),
            ],
            None,
        );
        let runs: Vec<_> = s.reviews.iter().map(|r| (r.id.as_str(), r.via)).collect();
        assert_eq!(
            runs,
            [
                ("p1", ReviewVia::SlashCommand),
                ("t1", ReviewVia::Skill),
                ("t2", ReviewVia::SlashCommand),
            ]
        );
    }

    #[test]
    fn a_subagent_written_a_moment_before_its_command_is_that_commands() {
        let at = |ms: u32| format!("2026-11-20T10:00:{:02}.{:03}000Z", ms / 1000, ms % 1000);
        let stamped = |ms: u32, mut e: Value| {
            e["received_at"] = json!(at(ms));
            e
        };
        let who = json!({ "agent_id": "fork", "agent_type": "general-purpose" });
        let s = session(
            vec![vec![
                prompt(0, "p1", "/code-review high #14"),
                stamped(3043, event(3, "SubagentStart", who.clone())),
                stamped(3050, prompt(3, "p2", "/code-review high #15")),
                event(50, "SubagentStop", who),
            ]],
            Some(&costs(&[("fork", 2.0)])),
        );
        let runs: Vec<_> = s
            .reviews
            .iter()
            .map(|r| (r.pull_number, r.subagents))
            .collect();
        assert_eq!(runs, [(Some(14), 0), (Some(15), 1)]);
    }

    #[test]
    fn a_review_whose_fork_has_no_end_has_no_duration() {
        let who = json!({ "agent_id": "fork", "agent_type": "general-purpose" });
        let s = session(
            vec![
                vec![prompt(0, "p1", "review it")],
                skill(1, "t1", "code-review", "", Some("fork")).into(),
                vec![event(1, "SubagentStart", who)],
            ],
            Some(&costs(&[("fork", 0.31)])),
        );
        let run = &s.reviews[0];
        assert_eq!((run.subagents, run.duration_ms), (1, None));
    }

    #[test]
    fn a_url_of_another_repository_is_checked_against_the_sessions_own() {
        use crate::session::Repo;
        let [other, _] = skill(
            1,
            "t1",
            "code-review",
            "https://github.com/acme/api/pull/41",
            None,
        );
        let [own, _] = skill(
            2,
            "t2",
            "code-review",
            "https://github.com/acme/web/pull/42",
            None,
        );
        let events = [prompt(0, "p1", "review them"), other, own];
        // As a session is built: its repository is known before its runs are.
        let (mut s, seen) = crate::normalize::assemble(&events, None, "claude-code").unwrap();
        s.repo = Some(Repo {
            remote: Some("github.com/acme/web".into()),
            ..Default::default()
        });
        crate::normalize::add_reviews(&mut s, &seen, None);
        let numbers: Vec<_> = s
            .reviews
            .iter()
            .map(|r| (r.pull_number, r.target.as_deref()))
            .collect();
        // It names none of this repository's, and is not one that named none.
        assert_eq!(numbers, [(None, Some(OTHER_REPOSITORY)), (Some(42), None)]);
        assert_eq!(s.counts.reviews, Some(2));
    }

    #[test]
    fn a_typed_command_for_another_repositorys_pull_request_is_none_of_this_ones() {
        use crate::session::Repo;
        const API: &str = "https://github.com/acme/api/pull/41";
        let runs = |events: Vec<Vec<Value>>| {
            let events: Vec<Value> = events.into_iter().flatten().collect();
            let (mut s, seen) = crate::normalize::assemble(&events, None, "claude-code").unwrap();
            s.repo = Some(Repo {
                remote: Some("github.com/acme/web".into()),
                ..Default::default()
            });
            crate::normalize::add_reviews(&mut s, &seen, None);
            let runs = s.reviews.iter();
            runs.map(|r| (r.via, r.pull_number, r.target.clone()))
                .collect::<Vec<_>>()
        };
        let typed = ReviewVia::SlashCommand;
        let elsewhere = Some(OTHER_REPOSITORY.to_string());
        // typed, and nothing more
        assert_eq!(
            runs(vec![vec![prompt(0, "p1", &format!("/code-review {API}"))]]),
            [(typed, None, elsewhere.clone())]
        );
        // typed, and the call it led to names none
        assert_eq!(
            runs(vec![
                vec![prompt(0, "p1", &format!("/code-review {API}"))],
                skill(1, "t1", "code-review", "", None).into(),
            ]),
            [(typed, None, elsewhere)]
        );
        // One of the two names a pull request here: the run is that one's.
        assert_eq!(
            runs(vec![
                vec![prompt(0, "p1", "/code-review #42")],
                skill(1, "t1", "code-review", API, None).into(),
            ]),
            [(typed, Some(42), None)]
        );
        assert_eq!(
            runs(vec![
                vec![prompt(0, "p1", &format!("/code-review {API}"))],
                skill(1, "t1", "code-review", "#42", None).into(),
            ]),
            [(typed, Some(42), None)]
        );
    }

    #[test]
    fn a_command_named_with_spaces_or_its_slash_is_kept_by_its_name() {
        let named = |name: &str| {
            let s = session(
                vec![vec![event(
                    0,
                    "UserPromptExpansion",
                    json!({ "prompt_id": "p1", "command_name": name, "command_args": "" }),
                )]],
                None,
            );
            s.reviews[0].command.clone()
        };
        assert_eq!(named(" code-review "), "code-review");
        assert_eq!(named("/my.plugin:code-review"), "my.plugin:code-review");
    }

    #[test]
    fn a_typed_review_that_led_to_a_call_has_what_was_said_of_its_prompt() {
        use crate::transcript::ReviewSaid;
        let facts = Facts {
            review_replies: vec![ReviewSaid {
                prompt_id: "p1".into(),
                findings: 4,
            }],
            ..Default::default()
        };
        let s = session(
            vec![
                vec![prompt(0, "p1", "/security-review")],
                skill(2, "t1", "security-review", "", None).into(),
            ],
            Some(&facts),
        );
        let runs: Vec<_> = s
            .reviews
            .iter()
            .map(|r| (r.id.as_str(), r.via, r.findings))
            .collect();
        assert_eq!(runs, [("t1", ReviewVia::SlashCommand, Some(4))]);
    }

    #[test]
    fn a_typed_review_that_forked_none_has_what_the_main_threads_reply_found() {
        use crate::transcript::ReviewSaid;
        let facts = Facts {
            review_replies: vec![ReviewSaid {
                prompt_id: "p1".into(),
                findings: 3,
            }],
            ..Default::default()
        };
        let s = session(
            vec![vec![
                prompt(0, "p1", "/security-review"),
                prompt(60, "p2", "/security-review"),
            ]],
            Some(&facts),
        );
        let found: Vec<_> = s.reviews.iter().map(|r| r.findings).collect();
        assert_eq!(found, [Some(3), None]);
    }

    #[test]
    fn the_same_number_in_another_repository_is_another_command() {
        let expansion = |args: &str| {
            event(
                0,
                "UserPromptExpansion",
                json!({ "command_name": "code-review", "command_args": args }),
            )
        };
        let s = session(
            vec![vec![
                expansion("https://github.com/acme/api/pull/41"),
                expansion("#41"),
            ]],
            None,
        );
        assert_eq!(s.reviews.len(), 2);
    }

    #[test]
    fn a_plugins_fork_is_its_own_and_not_the_command_before_its() {
        let launch = |second: u32, name: &str, fork: &str| {
            event(
                second,
                "UserPromptExpansion",
                json!({ "command_name": name, "command_args": "", "forked_agent_id": fork }),
            )
        };
        let s = session(
            vec![
                vec![
                    prompt(0, "p1", "/review"),
                    launch(60, "my.plugin:code-review", "f2"),
                ],
                subagent(61, 90, "f2").into(),
            ],
            Some(&costs(&[("f2", 2.0)])),
        );
        let runs: Vec<_> = s
            .reviews
            .iter()
            .map(|r| (r.command.as_str(), r.estimated_cost_usd))
            .collect();
        assert_eq!(
            runs,
            [("review", None), ("my.plugin:code-review", Some(2.0))]
        );
        // one that is no review at all leaves the one before it as it was
        let s = session(
            vec![
                vec![
                    prompt(0, "p1", "/review"),
                    prompt(50, "p2", "now deploy it"),
                    launch(60, "deploy", "f2"),
                ],
                subagent(61, 90, "f2").into(),
            ],
            Some(&costs(&[("f2", 2.0)])),
        );
        assert_eq!(s.reviews.len(), 1);
        assert_eq!(s.reviews[0].subagents, 0);
    }

    #[test]
    fn a_subagent_started_a_moment_before_a_skill_review_is_not_that_reviews() {
        let at = |ms: u32| format!("2026-11-20T10:00:{:02}.{:03}000Z", ms / 1000, ms % 1000);
        let stamped = |ms: u32, mut e: Value| {
            e["received_at"] = json!(at(ms));
            e
        };
        let who = json!({ "agent_id": "x", "agent_type": "general-purpose" });
        let [pre, post] = skill(3, "t2", "code-review", "", None);
        let s = session(
            vec![
                vec![prompt(0, "p1", "review it twice")],
                skill(1, "t1", "code-review", "", None).into(),
                vec![
                    stamped(3000, event(3, "SubagentStart", who.clone())),
                    stamped(3500, pre),
                    stamped(3500, post),
                    event(50, "SubagentStop", who),
                ],
            ],
            Some(&costs(&[("x", 2.0)])),
        );
        let subagents: Vec<_> = s.reviews.iter().map(|r| r.subagents).collect();
        assert_eq!(subagents, [1, 0]);
    }

    #[test]
    fn names_on_the_list_are_reviews() {
        for name in ["code-review", "/ultrareview", "review", "security-review"] {
            assert!(is_review(name), "{name}");
        }
        assert!(is_review("some-plugin:code-review"));
        // a plugin's name may have a dot where the agent calls it, not where it is typed
        assert!(is_review_skill("my.plugin:code-review"));
        assert!(!is_review("my.plugin:code-review"));
        assert!(!is_review_skill("/home/ann/notes.md:review"));
        for name in ["model", "clear", "code-reviewer", "my-review", ""] {
            assert!(!is_review(name), "{name}");
        }
        // a path that ends in one is no command, and none of it is kept
        for path in [
            "/home/ann/clients/acme-secret/notes.md:review",
            "notes.md:review",
            "a b:review",
            ":review",
        ] {
            assert!(!is_review(path), "{path}");
        }
        assert!(!is_typed_review(
            "/home/ann/clients/acme-secret/notes.md:review please look at this"
        ));
        let mut e = prompt(
            0,
            "p1",
            "/home/ann/clients/acme-secret/notes.md:review please look",
        );
        e["source"] = json!("cursor");
        let s = from_events(&[e], None, "cursor").unwrap();
        assert_eq!((s.reviews.len(), s.counts.reviews), (0, Some(0)));
    }

    #[test]
    fn a_commands_output_is_what_it_printed_and_not_the_notice_of_a_fork() {
        assert_eq!(
            command_output("<local-command-stdout>10 findings</local-command-stdout>"),
            Some("10 findings")
        );
        assert_eq!(
            command_output("<local-command-stdout>Running</local-command-stdout>\n<forked-skill-launch>{}</forked-skill-launch>"),
            None
        );
        assert_eq!(command_output("Reusing high effort, the level"), None);
    }

    #[test]
    fn a_codex_review_written_down_twice_is_one_run_and_one_without_its_rollout_is_not_known() {
        let at = |second: u32| {
            format!("2026-11-20T10:00:{second:02}Z")
                .parse::<DateTime<Utc>>()
                .ok()
        };
        let review = ReviewMode {
            id: "r1".into(),
            at: at(1),
            target: Some("uncommittedChanges".into()),
            ended_at: at(9),
            findings: Some(3),
            interrupted: false,
        };
        // Left with nothing returned, and its reviewer began as the first ended.
        let next = ReviewMode {
            id: "r2".into(),
            at: at(9),
            ended_at: at(20),
            interrupted: true,
            ..Default::default()
        };
        let facts = Facts {
            review_modes: vec![review.clone(), review, next],
            review_modes_read: true,
            reviewer_threads: vec![
                ReviewerThread {
                    agent_id: "rev".into(),
                    began: at(2),
                },
                ReviewerThread {
                    agent_id: "rev2".into(),
                    began: at(9),
                },
            ],
            ..Default::default()
        };
        let mut e = prompt(0, "p1", "look at this");
        e["source"] = json!("codex");
        let mut events = vec![e.clone()];
        for agent in ["rev", "rev2"] {
            let mut started = event(2, "SubagentStart", json!({ "agent_id": agent }));
            started["source"] = json!("codex");
            events.push(started);
        }
        let s = from_events(&events, Some(&facts), "codex").unwrap();
        let runs: Vec<_> = s
            .reviews
            .iter()
            .map(|r| (r.id.as_str(), r.status, r.findings, r.subagents))
            .collect();
        // The copy takes no reviewer: the next review has its own.
        assert_eq!(
            runs,
            [
                ("r1", ToolStatus::Ok, Some(3), 1),
                ("r2", ToolStatus::Interrupted, None, 1)
            ]
        );
        assert_eq!(s.reviews[0].target.as_deref(), Some("uncommitted_changes"));
        assert_eq!(s.counts.reviews, Some(2));
        // The reviews are in the rollout only: without it, or with facts
        // saved before it was read for them, not known.
        let unread = Facts::default();
        for facts in [None, Some(&unread)] {
            let s = from_events(std::slice::from_ref(&e), facts, "codex").unwrap();
            assert_eq!(s.counts.reviews, None);
        }
    }

    #[test]
    fn arguments_give_an_effort_and_a_number_and_nothing_else() {
        let parse = |a: &str| parse_args(a);
        assert_eq!(parse("xhigh 621"), (Some("xhigh".into()), Some(621)));
        assert_eq!(parse("xhigh #528"), (Some("xhigh".into()), Some(528)));
        assert_eq!(parse("high"), (Some("high".into()), None));
        assert_eq!(parse("ultra"), (Some("ultra".into()), None));
        assert_eq!(parse(""), (None, None));
        assert_eq!(parse("#12"), (None, Some(12)));
        assert_eq!(
            parse("xhigh. Review the repo at /home/ann/src/web-621 for leaks"),
            (Some("xhigh".into()), None)
        );
        assert_eq!(
            parse("medium /home/ann/projects/valkey"),
            (Some("medium".into()), None)
        );
        assert_eq!(parse("xhigh demo-mirror"), (Some("xhigh".into()), None));
        assert_eq!(
            parse("--max-findings 5 high https://github.com/o/r/pull/77/files"),
            (Some("high".into()), Some(77))
        );
        assert_eq!(parse("--comment XHigh 9"), (Some("xhigh".into()), Some(9)));
        // the effort is the first argument only
        assert_eq!(parse("621 high"), (None, Some(621)));
        // a bare number further on is a number in a sentence
        assert_eq!(
            parse("xhigh check the last 3 commits"),
            (Some("xhigh".into()), None)
        );
        assert_eq!(
            parse("medium look at 12 files"),
            (Some("medium".into()), None)
        );
        assert_eq!(
            parse("high the fix for #88 again"),
            (Some("high".into()), Some(88))
        );
        // a path is no pull request's URL
        assert_eq!(
            parse("high inspect /work/pull/42/diff.rs"),
            (Some("high".into()), None)
        );
        assert_eq!(parse("src/pull/42"), (None, None));
    }

    #[test]
    fn a_review_inside_a_review_has_its_own_subagents_cost_and_findings() {
        let facts = costs(&[("outer", 1.0), ("helper", 2.0), ("inner", 4.0)]);
        let in_outer = |mut e: Value| {
            e["payload"]["agent_id"] = json!("outer");
            e
        };
        let [pre, post] = skill(10, "t2", "security-review", "", Some("inner"));
        let report = event(
            20,
            "PostToolUse",
            json!({ "tool_use_id": "r1", "tool_name": "ReportFindings", "agent_id": "inner",
                    "tool_input": { "findings": [{}, {}] } }),
        );
        let [look, looked] = agent_call(5, "a1", Some("outer"), "helper");
        let s = session(
            vec![
                vec![prompt(0, "p1", "review it")],
                skill(1, "t1", "code-review", "", Some("outer")).into(),
                subagent(2, 60, "outer").into(),
                vec![in_outer(look), in_outer(looked)],
                subagent(6, 9, "helper").into(),
                vec![in_outer(pre), in_outer(post)],
                subagent(11, 30, "inner").into(),
                vec![report],
            ],
            Some(&facts),
        );
        let runs: Vec<_> = s
            .reviews
            .iter()
            .map(|r| (r.id.as_str(), r.subagents, r.estimated_cost_usd, r.findings))
            .collect();
        assert_eq!(
            runs,
            [("t1", 2, Some(3.0), None), ("t2", 1, Some(4.0), Some(2))]
        );
    }

    #[test]
    fn a_typed_command_and_a_call_for_another_pull_request_are_two_runs() {
        let s = session(
            vec![
                vec![prompt(0, "p1", "/code-review #41")],
                skill(3, "t1", "code-review", "#42", None).into(),
                vec![prompt(60, "p2", "/code-review #43")],
                skill(63, "t2", "code-review", "#43", None).into(),
            ],
            None,
        );
        let runs: Vec<_> = s.reviews.iter().map(|r| (r.via, r.pull_number)).collect();
        assert_eq!(
            runs,
            [
                (ReviewVia::SlashCommand, Some(41)),
                (ReviewVia::Skill, Some(42)),
                (ReviewVia::SlashCommand, Some(43)),
            ]
        );
    }

    #[test]
    fn an_expansion_without_an_id_takes_its_prompts_and_a_later_prompt_is_another_run() {
        let s = session(
            vec![vec![
                event(
                    0,
                    "UserPromptExpansion",
                    json!({ "command_name": "code-review", "command_args": "" }),
                ),
                prompt(0, "p1", "/code-review"),
                prompt(3, "p2", "/code-review"),
            ]],
            None,
        );
        let ids: Vec<_> = s.reviews.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["p1", "p2"]);
    }

    #[test]
    fn a_typed_review_went_as_its_turn_did() {
        let of = |mut e: Value| {
            e["source"] = json!("cursor");
            e
        };
        let events = [
            of(prompt(0, "p1", "/code-review #1")),
            of(event(9, "Stop", json!({ "prompt_id": "p1" }))),
            of(prompt(20, "p2", "/code-review #2")),
            of(event(
                29,
                "StopFailure",
                json!({ "prompt_id": "p2", "error": "rate_limit" }),
            )),
            of(prompt(40, "p3", "/code-review #3")),
        ];
        let s = from_events(&events, None, "cursor").unwrap();
        let went: Vec<_> = s.reviews.iter().map(|r| r.status).collect();
        assert_eq!(
            went,
            [ToolStatus::Ok, ToolStatus::Failed, ToolStatus::NoResult]
        );
    }

    #[test]
    fn a_note_of_a_reused_effort_is_one_turns() {
        use crate::transcript::ReusedEffort;
        let at = |second: u32| {
            format!("2026-11-20T10:00:{second:02}Z")
                .parse::<DateTime<Utc>>()
                .ok()
        };
        let facts = Facts {
            reused_efforts: vec![
                ReusedEffort {
                    at: at(1),
                    effort: "high".into(),
                },
                ReusedEffort {
                    at: at(5),
                    effort: "xhigh".into(),
                },
            ],
            ..Default::default()
        };
        let s = session(
            vec![vec![
                prompt(0, "p1", "/code-review"),
                prompt(4, "p2", "/code-review #7"),
            ]],
            Some(&facts),
        );
        let efforts: Vec<_> = s.reviews.iter().map(|r| r.effort.as_deref()).collect();
        assert_eq!(efforts, [Some("high"), Some("xhigh")]);
    }

    #[test]
    fn the_transcript_says_where_a_typed_command_forked_and_what_effort_it_reused() {
        use crate::transcript::{ReusedEffort, ReviewLaunch};
        let at = |second: u32| {
            format!("2026-11-20T10:00:{second:02}Z")
                .parse::<DateTime<Utc>>()
                .ok()
        };
        let mut facts = costs(&[("f1", 2.0), ("f2", 1.0), ("stray", 9.0)]);
        facts.subagents[0].findings = Some(4);
        facts.review_launches = vec![
            ReviewLaunch {
                at: at(1),
                command: "code-review".into(),
                agent_id: "f1".into(),
                ..Default::default()
            },
            ReviewLaunch {
                at: at(31),
                command: "code-review".into(),
                effort: Some("xhigh".into()),
                pull_number: Some(7),
                agent_id: "f2".into(),
            },
        ];
        facts.reused_efforts = vec![ReusedEffort {
            at: at(1),
            effort: "high".into(),
        }];
        // As the hooks have it: nothing says which subagent a command forked.
        let s = session(
            vec![
                vec![prompt(0, "p1", "/code-review")],
                subagent(1, 20, "f1").into(),
                subagent(2, 3, "stray").into(),
                vec![prompt(30, "p2", "/code-review xhigh 7")],
                subagent(31, 40, "f2").into(),
            ],
            Some(&facts),
        );
        let runs: Vec<_> = s
            .reviews
            .iter()
            .map(|r| {
                (
                    r.effort.as_deref(),
                    r.subagents,
                    r.estimated_cost_usd,
                    r.findings,
                )
            })
            .collect();
        assert_eq!(
            runs,
            [
                (Some("high"), 1, Some(2.0), Some(4)),
                (Some("xhigh"), 1, Some(1.0), None)
            ]
        );
    }

    #[test]
    fn a_command_typed_in_cursor_or_grok_is_a_run() {
        for source in ["cursor", "grok"] {
            let of = |mut e: Value| {
                e["source"] = json!(source);
                e
            };
            let events = [
                of(prompt(0, "p1", "/code-review #41")),
                of(prompt(30, "p2", "now fix the first one")),
                of(prompt(
                    60,
                    "p3",
                    "/code-review https://github.com/acme/web/pull/42 again",
                )),
                of(prompt(90, "p4", "/model")),
            ];
            let s = from_events(&events, None, source).unwrap();
            assert_eq!(s.counts.reviews, Some(2), "{source}");
            let runs: Vec<_> = s
                .reviews
                .iter()
                .map(|r| (r.command.as_str(), r.via, r.ran, r.pull_number, r.subagents))
                .collect();
            assert_eq!(
                runs,
                [
                    (
                        "code-review",
                        ReviewVia::SlashCommand,
                        ReviewRan::Local,
                        Some(41),
                        0
                    ),
                    (
                        "code-review",
                        ReviewVia::SlashCommand,
                        ReviewRan::Local,
                        Some(42),
                        0
                    ),
                ],
                "{source}"
            );
            assert_eq!(s.reviews[0].estimated_cost_usd, None);
        }
    }

    #[test]
    fn what_a_review_turns_last_reply_found_is_the_runs_findings() {
        assert!(is_typed_review("/code-review #41"));
        assert!(!is_typed_review("fix it"));
        assert!(!is_typed_review("/model"));
        assert_eq!(
            review_said("p1", "I found 2 issues in #41."),
            Some(ReviewSaid {
                prompt_id: "p1".into(),
                findings: 2
            })
        );
        assert_eq!(review_said("p1", "Do not merge this yet."), None);
        let of = |mut e: Value| {
            e["source"] = json!("grok");
            e
        };
        let events = [
            of(prompt(0, "p1", "/code-review #41")),
            of(prompt(30, "p2", "/code-review #41")),
        ];
        let facts = Facts {
            review_replies: review_said("p1", "I found 2 issues in #41.")
                .into_iter()
                .collect(),
            ..Default::default()
        };
        let s = from_events(&events, Some(&facts), "grok").unwrap();
        let found: Vec<_> = s.reviews.iter().map(|r| r.findings).collect();
        assert_eq!(found, [Some(2), None]);
    }

    #[test]
    fn an_agent_whose_commands_are_not_read_has_no_count() {
        let mut e = prompt(0, "p1", "hello");
        e["source"] = json!("another");
        let s = from_events(&[e], None, "another").unwrap();
        assert_eq!(s.counts.reviews, None);
        let s = session(vec![vec![prompt(0, "p1", "hello")]], None);
        assert_eq!(s.counts.reviews, Some(0));
    }

    #[test]
    fn slash_commands_are_split_from_their_arguments() {
        assert_eq!(
            slash_command("/code-review xhigh #590"),
            Some(("code-review", "xhigh #590"))
        );
        assert_eq!(slash_command("  /ultrareview"), Some(("ultrareview", "")));
        assert_eq!(slash_command("review /code-review"), None);
        assert_eq!(slash_command("/"), None);
    }
}
