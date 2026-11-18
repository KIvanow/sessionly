---
title: Cost and transcripts
nav_order: 5
parent: Command line
---

# Cost and transcripts

## How cost is calculated

This is how the cost of a Claude Code session is worked out.

Claude Code records its own cost total in the transcript, but only for one run of a session
(from the last start or resume until the total was last written). Sessionly combines that with
its own estimate from the token counts:

- **Inside the recorded run:** Claude Code's total, or our estimate if that is higher.
- **Before or after it** (earlier runs of a resumed session, or activity since the total was
  written): our estimate.
- **No recorded total** (session still running, or it crashed): estimate only, labelled as such.

The record says which of these a cost is, in `cost.source`: `recorded`,
`recorded_and_estimated`, `estimated`, or `partial_estimate` when some requests had no price
(see below). `list` and `summary` mark any cost that is or includes an estimate with `~`.

Estimates use Anthropic's published API prices in
[`pricing.rs`](https://github.com/KIvanow/sessionly/blob/main/crates/sessionly/src/pricing.rs). Each API response is counted once, with its
final token counts, even when it appears in several transcript files. A request made in fast
mode costs twice the usual, and a write to the cache 1.25 times the input price (kept five
minutes) or twice (kept an hour). Requests to a model that isn't in the price table are left
out of an estimate and counted in `unpriced_requests`, so an incomplete total is visible as
such. (Inside a recorded run they need no estimate: Claude Code's total covers them.)

The table has Anthropic's models only, from the Claude 4 models on. A model's name is read without
what a provider adds to it (`anthropic.` in front, a date or `[1m]` behind). Sessions of other
agents get their cost another way, or have none: see [Agents](agents.md).

How close is it? On one machine with 97 transcripts, the estimate for a recorded run equalled
Claude Code's total to the cent in about a third of the sessions and was lower in most of the
rest: 23% of recorded spend ($536 of $2,359) does not appear in any transcript. Each session
reports its part of that as `untracked_usd` (the recorded total less the estimate for the same
run), and we have not yet identified what it is. An estimate without a recorded
total is therefore a lower bound.

## Reading a transcript

`sessionly transcript <session>` reads Claude Code's transcript directly: tokens and cost per
model, for the main thread and each subagent. It also accepts a path to a
transcript file, and works for any past session, including ones from before Sessionly was
installed. Transcripts are looked for under `~/.claude/projects`, or under
`$CLAUDE_CONFIG_DIR/projects`.

```
Session    5233c02a-28f3-4e87-9fc8-d43379292252
Time       2026-11-13 13:00:05Z → 13:00:28Z (22s)
Context    branch HEAD, Claude Code 2.1.302, via sdk-cli
Cost       $0.20 (recorded by Claude Code)

Main thread
  model                   reqs     input    output  cache read cache write  est. cost
  claude-opus-5-5            6        12       630      130.7K       12.8K      $0.14

Subagent aab436e5 (general-purpose): Echo hello from subagent
  model                   reqs     input    output  cache read cache write  est. cost
  claude-opus-5-5            2         4       106       24.5K       11.3K      $0.06
```
