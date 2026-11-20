---
title: Agents
nav_order: 4
has_children: true
---

# Agents

Sessions of Claude Code, Cursor, Grok and Codex sit in one ledger, under one record, so
`list`, `summary`, `show`, the rewrite rate, uploads and the dashboard treat them alike. The
agents' tools are mapped to common names (Read, Edit, Write, Bash and so on), so a row means
the same thing whichever agent produced it.

What differs is where a session is read from, and so what is known of it:

| Agent | Read from | Cost | Not there |
|---|---|---|---|
| [Claude Code](claude-code.md) | its hooks, and its transcript | Claude Code's own total, with an estimate for what that leaves out | |
| [Cursor](cursor-and-grok.md) (the editor) | its transcripts, and the hooks for what those leave out | an estimate at API list prices, for the turns the hooks saw | for turns from before the hooks: times, failures, the model |
| [Grok](cursor-and-grok.md) | its session files | Grok's own figure | subagents, permission prompts |
| [Codex](codex.md) | its rollout files, and its hooks for two things those leave out | an estimate: its tokens at OpenAI's API list prices, not what a ChatGPT plan bills | |

One `sessionly install` sets up all four: Cursor and Grok run the hooks in
`~/.claude/settings.json` too, and Codex gets its own. For Cursor, Grok and Codex the agent's
own file is the record, and the hooks say that a session happened, so it is brought in at the
next sync without running `sessionly import`.

Sessions that run in the cloud are captured another way, through hooks a repository carries:

| In the cloud | What is recorded |
|---|---|
| [Claude Code's cloud sessions](cloud-sessions.md) | as on a machine |
| [Cursor's cloud agents](cloud-sessions.md) | prompts, tool calls, files and lines, the model; no tokens and no cost |
| [Codex's cloud tasks](codex-cloud-tasks.md) | the files and lines each turn changed; no prompts, tool calls, model or cost |

Not read: Cursor's command-line agent (`cursor-agent`), and Codex rollouts that Codex has
compressed.
