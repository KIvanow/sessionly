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
use crate::transcript::Facts;

/// The commands that are reviews. A plugin's skill matches on its last part
/// (`anything:code-review`). A team's own review skill under another name is
/// not counted.
pub const COMMANDS: &[&str] = &["code-review", "review", "security-review", "ultrareview"];

/// The efforts a review command takes as its first argument.
const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max", "ultra"];

/// How far into a reply its number of findings is looked for: its first lines.
const FINDINGS_WITHIN: usize = 400;

/// A typed command and the prompt it is in, taken as one start within this;
/// so are a review and the thread its reviewer began in.
pub const SAME_START_SECONDS: i64 = 5;

/// How long before its command a typed review's subagent may be written
/// down as started.
const STARTED_EARLY_MS: i64 = 1000;

/// True for an agent whose review commands are read. A session of another
/// has no count: not known, which is not none.
pub fn counted(source: &str) -> bool {
    crate::paths::SOURCES.contains(&source)
}

/// True for the name of a review command, with or without its slash.
pub fn is_review(name: &str) -> bool {
    let name = name.trim().trim_start_matches('/');
    let last = name.rsplit(':').next().unwrap_or(name);
    COMMANDS.contains(&last)
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

/// The origin of the repository the session ran in, as the record has it or,
/// before it has, as git says for where the session ran.
fn remote_of(s: &Session) -> Option<String> {
    if let Some(repo) = &s.repo {
        return repo.remote.clone();
    }
    let root = crate::git::repo_root(std::path::Path::new(s.cwd.as_deref()?))?;
    crate::git::origin_remote(&root)
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
        .filter(|name| is_review(name))?;
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

/// How many findings a review's reply says it has, where its first lines say
/// so in a way that can be relied on: a JSON list of them, or a number of
/// findings, issues, problems or bugs that the reply opens a sentence with or
/// says it found, kept or has ("15 findings, most severe first", "I reviewed
/// PR #50 and found 4 issues", "there are no findings"). Read here on the
/// machine; only the number is kept.
///
/// None when the reply words it another way, and when it is not clear which
/// number is meant: "the two earlier findings are fixed" counts nothing, two
/// different numbers are none unless one is what was kept, and none of one
/// kind ("no blocking bugs") is not none at all.
pub fn findings_in(reply: &str) -> Option<u64> {
    let reply = reply.trim();
    if let Some(block) = reply.strip_prefix("```json") {
        let list = block.rsplit_once("```").map_or(block, |(list, _)| list);
        return match serde_json::from_str::<Value>(list.trim()).ok()? {
            Value::Array(found) => Some(found.len() as u64),
            _ => None,
        };
    }
    const THINGS: &[&str] = &[
        "finding", "findings", "issue", "issues", "problem", "problems", "bug", "bugs",
    ];
    // What says that the number after it is this review's.
    const FRAMES: &[&str] = &[
        "found",
        "kept",
        "keeping",
        "are",
        "is",
        "has",
        "have",
        "with",
        "reports",
        "reporting",
    ];
    const NOT_A_KIND: &[&str] = &["of", "the", "in", "and", "or", "to", "for", "on", "from"];
    const WORDS: &[&str] = &[
        "no",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
        "twenty",
    ];
    let head: String = reply.chars().take(FINDINGS_WITHIN).collect();
    let raw: Vec<&str> = head.split_whitespace().collect();
    let clean = |word: &str| {
        word.trim_matches(|c: char| !c.is_alphanumeric())
            .to_ascii_lowercase()
    };
    let number = |word: &str| -> Option<u64> {
        if word.starts_with('#') {
            return None;
        }
        let word = clean(word);
        match WORDS.iter().position(|w| *w == word) {
            Some(n) => Some(n as u64),
            None => word.parse().ok().filter(|_| word.len() <= 4),
        }
    };
    let (mut kept, mut counts): (Vec<u64>, Vec<u64>) = (Vec::new(), Vec::new());
    for (i, word) in raw.iter().enumerate() {
        if !THINGS.contains(&clean(word).as_str()) || i == 0 {
            continue;
        }
        // "4 issues", or with what kind between: "4 blocking issues".
        let at = match number(raw[i - 1]) {
            Some(_) => i - 1,
            None if i >= 2 && !NOT_A_KIND.contains(&clean(raw[i - 1]).as_str()) => i - 2,
            None => continue,
        };
        let Some(count) = number(raw[at]) else {
            continue;
        };
        // None of a kind says nothing of the other kinds.
        if count == 0 && at != i - 1 {
            continue;
        }
        let before = at.checked_sub(1).map(|b| raw[b]);
        let frame = before.map(clean).unwrap_or_default();
        let opens = before.is_none_or(|b| b.ends_with(['.', ':', '!', '?']));
        if frame == "kept" || frame == "keeping" {
            kept.push(count);
        } else if opens || FRAMES.contains(&frame.as_str()) {
            counts.push(count);
        }
    }
    let one = |of: &[u64]| of.first().copied().filter(|n| of.iter().all(|m| m == n));
    one(&kept).or_else(|| one(&counts).filter(|_| kept.is_empty()))
}

/// What an import writes for a turn that a review command started, where
/// its last reply says how many findings it has: read by `Seen::event`.
pub fn reply_event(prompt_id: &str, prompt: &str, reply: &str) -> Option<Value> {
    let (command, _) = slash_command(prompt)?;
    if !is_review(command) {
        return None;
    }
    let findings = findings_in(reply)?;
    Some(serde_json::json!({ "prompt_id": prompt_id, "findings": findings }))
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
    /// What the last reply of a review's turn says it found, by prompt id:
    /// written by the imports of the agents whose reviews run in the
    /// session's own thread.
    said: HashMap<String, u64>,
    typed: Vec<Typed>,
    /// Codex's `/review` runs, as its rollout has them.
    codex: Vec<CodexReview>,
}

/// One run of Codex's `/review`: review mode entered and left.
#[derive(Debug, Clone)]
struct CodexReview {
    id: String,
    at: Option<DateTime<Utc>>,
    target: Option<String>,
    ended: Option<DateTime<Utc>>,
    findings: Option<u64>,
    /// The thread the reviewer ran in.
    agent: Option<String>,
}

impl Seen {
    /// Take in one event of a session from `source`.
    pub fn event(&mut self, source: &str, hook: &str, p: &Value, at: Option<DateTime<Utc>>) {
        let id = p["tool_use_id"].as_str().filter(|id| !id.is_empty());
        match (hook, id) {
            ("PreToolUse" | "PostToolUse" | "PostToolUseFailure", Some(id)) => {
                let input = &p["tool_input"];
                match p["tool_name"].as_str() {
                    Some("Skill") => {
                        if input["skill"].as_str().is_some_and(is_review) {
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
            // Codex's `/review` is no prompt: the import writes this from the
            // rollout's review mode.
            ("CodexReview", _) if source == crate::paths::CODEX => {
                let Some(id) = p["review_id"].as_str() else {
                    return;
                };
                if self.codex.iter().any(|r| r.id == id) {
                    return;
                }
                let time = |v: &Value| v.as_str().and_then(|t| t.parse::<DateTime<Utc>>().ok());
                self.codex.push(CodexReview {
                    id: id.to_string(),
                    at,
                    target: p["target"].as_str().map(target_name),
                    ended: time(&p["ended_at"]),
                    findings: p["findings"].as_u64(),
                    agent: p["agent_id"].as_str().map(String::from),
                });
            }
            ("ReviewReply", _) => {
                if let (Some(prompt), Some(n)) = (p["prompt_id"].as_str(), p["findings"].as_u64()) {
                    self.said.insert(prompt.to_string(), n);
                }
            }
            // Codex's own command is not in what it writes down; a prompt
            // that names it would count the review above a second time.
            _ if source == crate::paths::CODEX => {}
            // Typed in Claude Code, Cursor or Grok: the prompt is the command.
            // Cursor's files wrap it in `<user_query>`, which the import has
            // taken off, and its hooks have it bare.
            ("UserPromptSubmit", _) => {
                if let Some((name, args)) = p["prompt"].as_str().and_then(slash_command) {
                    self.typed(p, at, name, args);
                }
            }
            ("UserPromptExpansion", _) if source == crate::paths::CLAUDE_CODE => {
                let kind = p["expansion_type"].as_str().unwrap_or("slash_command");
                if let (Some(name), "slash_command") = (p["command_name"].as_str(), kind) {
                    let args = p["command_args"].as_str().unwrap_or_default();
                    self.typed(p, at, name.trim_start_matches('/'), args);
                    // Written by the import, from the row that says where it forked.
                    if let (Some(fork), Some(typed)) =
                        (p["forked_agent_id"].as_str(), self.typed.last_mut())
                    {
                        typed.fork.get_or_insert_with(|| fork.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    fn typed(&mut self, p: &Value, at: Option<DateTime<Utc>>, name: &str, args: &str) {
        if !is_review(name) {
            return;
        }
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
                                && (&t.effort, t.pull_number) == (&effort, pull_number)
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
            return;
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
    // The session's repository is asked for only where a URL named one: it
    // is not on the record yet while its runs are built.
    let named = |repo: &Option<String>| repo.is_some();
    let asked = seen.skill_calls.values().any(|(_, _, repo)| named(repo))
        || seen.typed.iter().any(|t| named(&t.repo));
    let here = asked.then(|| remote_of(s)).flatten();
    let of_here =
        |number: Option<u64>, repo: &Option<String>| in_repo(number, repo, here.as_deref());
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
            run.via = ReviewVia::SlashCommand;
            run.at = typed.at;
            run.command = typed.command.clone();
            run.effort = run.effort.take().or(typed.effort.clone());
            run.pull_number = run.pull_number.or(number);
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
            status: typed_status(s, typed),
            findings: typed
                .prompt_id
                .as_ref()
                .and_then(|p| seen.said.get(p))
                .copied(),
            ..Default::default()
        });
    }
    for review in &seen.codex {
        if let Some(agent) = &review.agent {
            forks.insert(review.id.clone(), agent);
        }
        runs.push(ReviewRun {
            id: review.id.clone(),
            at: review.at,
            command: "review".into(),
            via: ReviewVia::CodexReview,
            ran: ReviewRan::Local,
            target: review.target.clone(),
            // Left without an end: the session stopped while it ran.
            status: match review.ended {
                Some(_) => ToolStatus::Ok,
                None => ToolStatus::NoResult,
            },
            duration_ms: review
                .at
                .zip(review.ended)
                .map(|(start, end)| (end - start).num_milliseconds().max(0) as u64),
            findings: review.findings,
            ..Default::default()
        });
    }
    runs.sort_by(|a, b| a.at.cmp(&b.at).then(a.id.cmp(&b.id)));
    measure(&mut runs, s, seen, &forks, facts);
    runs
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
                && r.at.is_some_and(|t| t <= at + early)
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
        run.findings = run.findings.or(findings[i]).or_else(|| {
            let fork = forks.get(run.id.as_str())?;
            let said = facts?.subagents.iter().find(|sub| sub.agent_id == *fork)?;
            said.findings
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
    fn a_url_of_another_repository_is_checked_against_where_the_session_ran() {
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let done = std::process::Command::new("git")
                .args(args)
                .current_dir(dir.path())
                .output()
                .unwrap();
            assert!(done.status.success());
        };
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", "https://github.com/acme/web.git"]);
        let here = |mut e: Value| {
            e["payload"]["cwd"] = json!(dir.path());
            e
        };
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
        let s = session(
            vec![vec![
                here(prompt(0, "p1", "review them")),
                here(other),
                here(own),
            ]],
            None,
        );
        let numbers: Vec<_> = s.reviews.iter().map(|r| r.pull_number).collect();
        assert_eq!(numbers, [None, Some(42)]);
    }

    #[test]
    fn names_on_the_list_are_reviews() {
        for name in ["code-review", "/ultrareview", "review", "security-review"] {
            assert!(is_review(name), "{name}");
        }
        assert!(is_review("some-plugin:code-review"));
        for name in ["model", "clear", "code-reviewer", "my-review", ""] {
            assert!(!is_review(name), "{name}");
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
    fn a_reply_says_how_many_findings_in_a_few_known_ways() {
        assert_eq!(
            findings_in("```json\n[{\"file\":\"a.rs\"},{\"file\":\"b.rs\"}]\n```"),
            Some(2)
        );
        assert_eq!(findings_in("```json\n[]\n```"), Some(0));
        assert_eq!(findings_in("```json\n{\"ok\":true}\n```"), None);
        assert_eq!(findings_in("I found 3 issues in PR #50."), Some(3));
        assert_eq!(findings_in("I found no problems in the diff."), Some(0));
        assert_eq!(
            findings_in("15 findings, most severe first:\n\n1. ..."),
            Some(15)
        );
        assert_eq!(findings_in("No findings."), Some(0));
        // further into the first lines, said as found, kept or had
        for (reply, n) in [
            ("I reviewed PR #50 at high effort and found 4 issues.", 4),
            (
                "I reviewed PR 12 (`feat/x`, 9 files). There are 7 findings.",
                7,
            ),
            (
                "Review of PR #3 is done. Ten findings, most severe first.",
                10,
            ),
            ("I reviewed 14 files and found 3 confirmed problems.", 3),
            ("PR #77 has no issues.", 0),
            ("Of 20 candidates I verified each and kept 5 findings.", 5),
            (
                "I found 9 issues and, after checking each, kept 6 findings.",
                6,
            ),
        ] {
            assert_eq!(findings_in(reply), Some(n), "{reply}");
        }
        for other in [
            "I reviewed PR #50 at high effort and 3 things stand out.",
            "I found the 2 callers.",
            "2026 was a long year",
            // another review's findings
            "The two earlier findings are fixed.",
            "Both of the 3 issues from the last round are gone.",
            // two numbers, and nothing says which
            "I found 3 issues in the server. The CLI has 2 problems.",
            // a pull request's number is no count
            "This closes #12 issues aside.",
            // none of one kind is not none at all
            "PR #77 has no blocking bugs.",
            "I found no blocking bugs, but the diff has several minor issues.",
            "",
        ] {
            assert_eq!(findings_in(other), None, "{other}");
        }
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
        assert_eq!(
            reply_event("p1", "/code-review #41", "I found 2 issues in #41."),
            Some(json!({ "prompt_id": "p1", "findings": 2 }))
        );
        assert_eq!(reply_event("p1", "fix it", "I found 2 issues."), None);
        assert_eq!(
            reply_event("p1", "/code-review", "Do not merge this yet."),
            None
        );
        let of = |mut e: Value| {
            e["source"] = json!("grok");
            e
        };
        let events = [
            of(prompt(0, "p1", "/code-review #41")),
            of(event(
                9,
                "ReviewReply",
                json!({ "prompt_id": "p1", "findings": 2 }),
            )),
            of(prompt(30, "p2", "/code-review #41")),
        ];
        let s = from_events(&events, None, "grok").unwrap();
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
