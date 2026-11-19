// One repository's sessions shown in another organisation: a demo anyone may
// be let into, of work that was really done. The sessions stay where they
// were uploaded, with everything they hold. What is copied is made anew from
// what is safe to show (who, when, which models, what it cost, which files
// of the repository, the hashes of the lines), and nothing that was typed or
// run: no prompt, no title, no command, no path outside the repository. So
// the organisation they are shown in never holds what must not be seen, and
// nothing that reads from it has to leave anything out.
import { createHash } from "node:crypto";
import type {
  AddedLines,
  Cost,
  Counts,
  FileTouched,
  ModelUsage,
  PullReport,
  RewriteMeasurement,
  Session,
  Subagent,
  Upload,
} from "@sessionly/schema";
import type { Principal } from "./auth.ts";
import type { OrgDb } from "./db.ts";
import { IN_WORKTREE, rematchPulls } from "./pulls.ts";
import { removeUpload, storeUpload } from "./sessions.ts";

export interface Demo {
  /** The organisation the sessions are uploaded to. */
  from: string;
  /** The repository, as sessions are filed under it: `github.com/owner/name`. */
  repo: string;
  /** The organisation they are shown in. */
  org: string;
  /** Paths of the repository that are not shown: a file, or a folder and what is in it. */
  hide: string[];
  /** How often the copy is brought up to date. */
  minutes: number;
}

/** One organisation's view of the database, a transaction at a time. */
type Each = <T>(fn: (db: OrgDb) => Promise<T>) => Promise<T>;

/**
 * Whether a path a session names is a file of the repository that may be
 * shown. One from the home directory or the root, or that climbs out, is
 * somewhere else on the person's machine. A hidden path is hidden in a
 * worktree's copy of the repository too, and however its folders are
 * divided: a machine with Windows writes `notes\plan.md`.
 */
export function inRepo(path: string | null | undefined, hide: string[]): path is string {
  if (!path) return false;
  const plain = path.replace(/\\/g, "/");
  if (/^[/~]|^[A-Za-z]:/.test(plain) || plain.split("/").includes("..")) return false;
  const hidden = (file: string) => hide.some((one) => file === one || file.startsWith(one.endsWith("/") ? one : `${one}/`));
  const inWorktree = IN_WORKTREE.exec(plain)?.[1];
  return !hidden(plain) && !(inWorktree && hidden(inWorktree));
}

// Each kind of thing in a session, written out field by field, down to the
// last one: what a later version of the record adds to any of them is not
// shown until it is put here. Nothing is passed on whole.

const costOf = (c: Cost | null | undefined): Cost | null =>
  c
    ? {
        total_usd: c.total_usd,
        source: c.source,
        transcript_estimate_usd: c.transcript_estimate_usd,
        unpriced_requests: c.unpriced_requests,
        untracked_usd: c.untracked_usd,
        prompts_covered: c.prompts_covered,
      }
    : null;

const usageOf = (u: ModelUsage): ModelUsage => ({
  model: u.model,
  requests: u.requests,
  input_tokens: u.input_tokens,
  output_tokens: u.output_tokens,
  thinking_tokens: u.thinking_tokens,
  cache_read_tokens: u.cache_read_tokens,
  cache_write_5m_tokens: u.cache_write_5m_tokens,
  cache_write_1h_tokens: u.cache_write_1h_tokens,
  estimated_cost_usd: u.estimated_cost_usd,
});

const countsOf = (c: Counts | undefined): Counts | undefined =>
  c && {
    events: c.events,
    prompts: c.prompts,
    tool_calls: c.tool_calls,
    tool_failures: c.tool_failures,
    permission_requests: c.permission_requests,
    permission_denials: c.permission_denials,
    subagents: c.subagents,
    compactions: c.compactions,
    api_errors: c.api_errors,
    files_read: c.files_read,
    files_changed: c.files_changed,
    lines_added: c.lines_added,
    lines_removed: c.lines_removed,
  };

const fileOf = (f: FileTouched): FileTouched => ({
  path: f.path,
  reads: f.reads,
  writes: f.writes,
  created: f.created,
  lines_added: f.lines_added,
  lines_removed: f.lines_removed,
});

// What a subagent was asked to do is a prompt too.
const subagentOf = (a: Subagent): Subagent => ({
  agent_id: a.agent_id,
  agent_type: a.agent_type,
  description: null,
  started_at: a.started_at,
  ended_at: a.ended_at,
  tool_calls: a.tool_calls,
  requests: a.requests,
  input_tokens: a.input_tokens,
  output_tokens: a.output_tokens,
  estimated_cost_usd: a.estimated_cost_usd,
});

const linesOf = (l: AddedLines): AddedLines => ({ path: l.path, model: l.model, hashes: (l.hashes ?? []).map(String) });

const rewriteOf = (r: RewriteMeasurement | null | undefined, hide: string[]): RewriteMeasurement | null =>
  r
    ? {
        measured_at: r.measured_at,
        branch: r.branch,
        head: r.head,
        files_measured: r.files_measured,
        files_rewritten: r.files_rewritten,
        lines_added: r.lines_added,
        lines_surviving: r.lines_surviving,
        files: (r.files ?? [])
          .filter((f) => inRepo(f.path, hide))
          .map((f) => ({ path: f.path, lines_added: f.lines_added, lines_surviving: f.lines_surviving, exists: f.exists })),
      }
    : null;

/** A session as it is shown. */
export function shown(upload: Upload, hide: string[]): Upload {
  const s: Session = upload.session ?? {};
  return {
    schema_version: upload.schema_version,
    session: {
      schema_version: s.schema_version,
      source: s.source,
      collector_version: s.collector_version,
      machine_id: s.machine_id,
      captured_by: s.captured_by,
      content: "metadata",
      session_id: s.session_id,
      // Made from the first prompt.
      title: null,
      user: s.user ? { name: s.user.name ?? null, email: s.user.email ?? null } : null,
      runtime: s.runtime ? { kind: s.runtime.kind, id: s.runtime.id } : null,
      started_at: s.started_at,
      ended_at: s.ended_at,
      duration_ms: s.duration_ms,
      active_ms: s.active_ms,
      end_reason: s.end_reason,
      captured_from_start: s.captured_from_start,
      cwd: null,
      // Where the clone is on the person's machine is theirs.
      repo: s.repo ? { remote: s.repo.remote ?? null, branch: s.repo.branch ?? null } : null,
      agent_version: s.agent_version,
      entrypoint: s.entrypoint,
      models: (s.models ?? []).map(String),
      permission_modes: (s.permission_modes ?? []).map(String),
      cost: costOf(s.cost),
      usage: (s.usage ?? []).map(usageOf),
      counts: countsOf(s.counts),
      // When, and how each ended. Of what was typed, not its length even: nor a hash, which a short one is found by.
      prompts: (s.prompts ?? []).map((p) => ({ prompt_id: p.prompt_id, at: p.at, ended_at: p.ended_at, outcome: p.outcome })),
      // Which tool, when, and how it went: not what it was given, nor what it said went wrong.
      tool_calls: (s.tool_calls ?? []).map((t) => ({
        tool_use_id: t.tool_use_id,
        prompt_id: t.prompt_id,
        agent_id: t.agent_id,
        tool: t.tool,
        model: t.model,
        at: t.at,
        status: t.status,
        duration_ms: t.duration_ms,
        file_path: inRepo(t.file_path, hide) ? t.file_path : null,
        output_bytes: t.output_bytes,
        lines_added: t.lines_added,
        lines_removed: t.lines_removed,
      })),
      files: (s.files ?? []).filter((f) => inRepo(f.path, hide)).map(fileOf),
      subagents: (s.subagents ?? []).map(subagentOf),
      instruction_files: (s.instruction_files ?? []).filter((path) => inRepo(path, hide)),
    },
    rewrite: rewriteOf(upload.rewrite, hide),
    lines: (upload.lines ?? []).filter((l) => inRepo(l.path, hide)).map(linesOf),
  };
}

/**
 * A pull request's report as it is kept where the repository is shown:
 * without the files that are not shown, and with no word of where a comment
 * on one of them is. The Action reports every file; this is where the ones
 * not shown stop.
 */
export function shownReport(report: PullReport, hide: string[]): PullReport {
  return {
    ...report,
    files: report.files.filter((f) => inRepo(f.path, hide)),
    feedback: report.feedback?.map((f) => (f.path == null || inRepo(f.path, hide) ? f : { ...f, path: null, line: null })),
  };
}

/**
 * The rules a copy was made by: what is left out here, and the paths not
 * shown. A copy made by others is made again. Raise the number when `shown`
 * leaves out more than it did.
 */
const SHOWN_VERSION = 1;
export const rulesOf = (hide: string[]): string =>
  createHash("sha256").update(JSON.stringify([SHOWN_VERSION, [...hide].sort()])).digest("hex").slice(0, 16);

/** A session where it is uploaded: under whom, and when it was last stored, to the microsecond, as text. */
interface Theirs {
  machine_id: string;
  source: string;
  session_id: string;
  owner_email: string;
  sent: string;
}

/** What was sent of one to where it is shown. */
interface Sent {
  machine_id: string;
  source: string;
  session_id: string;
  owner_email: string;
  sent_at: string;
  rules: string;
  removed: boolean;
}

const keyOf = (s: { machine_id: string; source: string; session_id: string }): string => `${s.machine_id}\n${s.source}\n${s.session_id}`;

/** Whoever a session is filed under, storing or removing their own in the organisation it is shown in. */
const as = (orgId: string, email: string): Principal => ({
  orgId,
  email,
  name: null,
  role: "member",
  tokenId: null,
  userId: null,
  signedIn: false,
  owner: false,
});

/** How long a session that was removed is remembered to have been: by then every pull request has been matched since. */
const REMEMBERED_DAYS = 7;

/**
 * Bring the organisation the repository is shown in up to date: sessions
 * that are new, were stored again since they were sent, or were sent by
 * other rules are copied, and ones that are gone (taken back, their
 * repository stopped, the repository shown another now) are removed there
 * too. Each is stored like an upload, in a transaction of its own, so one
 * that fails is said (`log`) and leaves the others.
 *
 * Then the pull requests there that were last matched before the latest
 * copy or removal are matched again: a report of one comes before the
 * sessions that wrote it, which are copied later. That goes by what is
 * kept, so one this could not get to (the server stopped) is matched the
 * next time.
 *
 * Only sessions this sent are ever removed where they are shown.
 */
export async function copyRepo(
  from: Each,
  to: Each,
  demo: Pick<Demo, "repo" | "hide">,
  key?: string,
  log: (err: unknown) => void = () => {},
): Promise<{ copied: number; kept: number; removed: number; failed: number; matched: number }> {
  const rules = rulesOf(demo.hide);
  const theirs = await from((db) =>
    db.query<Theirs>(
      `SELECT machine_id, source, session_id, owner_email, updated_at::text AS sent FROM sessions WHERE org_id = $1 AND repo = $2`,
      [db.orgId, demo.repo],
    ),
  );
  const sent = new Map(
    (
      await to((db) =>
        db.query<Sent>(
          `SELECT machine_id, source, session_id, owner_email, sent_at, rules, removed_at IS NOT NULL AS removed
           FROM shown_sessions WHERE org_id = $1`,
          [db.orgId],
        ),
      )
    ).map((s) => [keyOf(s), s]),
  );
  const note = (db: OrgDb, s: Theirs) =>
    db.query(
      `INSERT INTO shown_sessions (org_id, machine_id, source, session_id, owner_email, sent_at, rules, copied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, clock_timestamp())
       ON CONFLICT (org_id, machine_id, source, session_id) DO UPDATE
       SET owner_email = EXCLUDED.owner_email, sent_at = EXCLUDED.sent_at, rules = EXCLUDED.rules,
           copied_at = EXCLUDED.copied_at, removed_at = NULL`,
      [db.orgId, s.machine_id, s.source, s.session_id, s.owner_email, s.sent, rules],
    );
  let copied = 0;
  let kept = 0;
  let removed = 0;
  let failed = 0;
  for (const s of theirs) {
    const had = sent.get(keyOf(s));
    sent.delete(keyOf(s));
    // What was sent is what is there, by these rules and under the same person: nothing to do.
    if (had && !had.removed && had.sent_at === s.sent && had.rules === rules && had.owner_email === s.owner_email) continue;
    try {
      // With when it was stored, as this statement saw it: one stored again a moment later has another time, and is sent the next time.
      const [row] = await from((db) =>
        db.query<Theirs & { payload: unknown }>(
          `SELECT machine_id, source, session_id, owner_email, updated_at::text AS sent, payload FROM sessions
           WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4 AND repo = $5`,
          [db.orgId, s.machine_id, s.source, s.session_id, demo.repo],
        ),
      );
      // Gone in the moment since: the next time removes it here.
      if (!row) continue;
      const upload = shown((typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Upload, demo.hide);
      const stored = await to(async (db) => {
        // Filed under another person since: theirs now, and not a copy beside the old one.
        if (had && !had.removed && had.owner_email !== row.owner_email) await removeUpload(db, as(db.orgId, had.owner_email), had);
        const { stored } = await storeUpload(db, upload, as(db.orgId, row.owner_email));
        // Noted whether or not it was stored: one the organisation would not take is not offered again until it changes.
        await note(db, row);
        return stored;
      });
      if (stored) copied += 1;
      else kept += 1;
    } catch (err) {
      failed += 1;
      log(err);
    }
  }
  // What is left was sent once and is in the repository no more.
  for (const gone of sent.values()) {
    if (gone.removed) continue;
    try {
      await to(async (db) => {
        await removeUpload(db, as(db.orgId, gone.owner_email), gone);
        await db.query(
          // Whose it was goes with it: that one was here, and when it went, is all that is kept a while.
          `UPDATE shown_sessions SET removed_at = clock_timestamp(), owner_email = ''
           WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4`,
          [db.orgId, gone.machine_id, gone.source, gone.session_id],
        );
      });
      removed += 1;
    } catch (err) {
      failed += 1;
      log(err);
    }
  }
  const latest = await to(async (db) => {
    await db.query(`DELETE FROM shown_sessions WHERE org_id = $1 AND removed_at < now() - $2 * interval '1 day'`, [db.orgId, REMEMBERED_DAYS]);
    const [row] = await db.query<{ at: unknown }>(
      `SELECT max(greatest(copied_at, coalesce(removed_at, copied_at))) AS at FROM shown_sessions WHERE org_id = $1`,
      [db.orgId],
    );
    return row?.at == null ? null : new Date(row.at as string);
  });
  let matched = 0;
  if (latest) {
    // A millisecond on: the time is kept finer than it is carried here, and one matched within it is matched once more.
    const since = new Date(latest.getTime() + 1).toISOString();
    // Some at a time, as the page's own button does it, until none is left or none gets further.
    for (;;) {
      const some = await rematchPulls(to, {}, since, key, log);
      matched += some.matched;
      failed += some.failed;
      if (some.remaining === 0 || some.matched === 0) break;
    }
  }
  return { copied, kept, removed, failed, matched };
}

/** The settings of a demo, and the default of the one that has one. */
const SETTINGS = ["SESSIONLY_DEMO_FROM", "SESSIONLY_DEMO_REPO", "SESSIONLY_DEMO_ORG"] as const;
const EVERY_MINUTES = 30;

/**
 * The demo the settings ask for: undefined if they ask for none, and what is
 * wrong with them otherwise. All three of where from, which repository and
 * where to are needed, and the two organisations are not the same one: what
 * is shown is made without most of what a session holds, and would replace
 * the session itself.
 */
export function demoFrom(env: NodeJS.ProcessEnv): Demo | { problem: string } | undefined {
  const [from, repo, org] = SETTINGS.map((name) => env[name]?.trim() ?? "");
  const set = SETTINGS.filter((name) => env[name]?.trim());
  if (set.length === 0) return undefined;
  if (set.length < SETTINGS.length) {
    return { problem: `Only ${set.join(" and ")} of ${SETTINGS.join(", ")} ${set.length === 1 ? "is" : "are"} set: showing a repository in another organisation needs all three, and is off.` };
  }
  if (from === org) return { problem: "SESSIONLY_DEMO_FROM and SESSIONLY_DEMO_ORG name the same organisation: a repository is shown in another one, and this is off." };
  const minutes = Number(env.SESSIONLY_DEMO_MINUTES?.trim() || EVERY_MINUTES);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 24 * 60) {
    return { problem: "SESSIONLY_DEMO_MINUTES is not a whole number of minutes from 1 to 1440: showing a repository in another organisation is off." };
  }
  const hide = (env.SESSIONLY_DEMO_HIDE ?? "")
    .split(/[,\n]/)
    .map((path) => path.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter(Boolean);
  return { from: from!, repo: repo!, org: org!, hide, minutes };
}
