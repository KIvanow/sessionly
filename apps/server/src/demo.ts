// One repository's sessions shown in another organisation: a demo anyone may
// be let into, of work that was really done. The sessions stay where they
// were uploaded, with everything they hold. What is copied is made anew from
// what is safe to show (who, when, which models, what it cost, which files
// of the repository, the hashes of the lines), and nothing that was typed or
// run: no prompt, no title, no command, no path outside the repository. So
// the organisation they are shown in never holds what must not be seen, and
// nothing that reads from it has to leave anything out.
import type { Session, Upload } from "@sessionly/schema";
import type { Principal } from "./auth.ts";
import type { OrgDb } from "./db.ts";
import { rematchPulls } from "./pulls.ts";
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
 * somewhere else on the person's machine.
 */
export function inRepo(path: string | null | undefined, hide: string[]): path is string {
  if (!path || /^[/~\\]|^[A-Za-z]:/.test(path) || path.split(/[/\\]/).includes("..")) return false;
  return !hide.some((hidden) => path === hidden || path.startsWith(hidden.endsWith("/") ? hidden : `${hidden}/`));
}

/**
 * A session as it is shown: written out field by field, so that what a
 * later version of the record adds is not shown until it is put here.
 */
export function shown(upload: Upload, hide: string[]): Upload {
  const s: Session = upload.session ?? {};
  const mine = <T extends { path?: string }>(files: T[] | undefined): T[] => (files ?? []).filter((f) => inRepo(f.path, hide));
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
      runtime: s.runtime,
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
      models: s.models,
      permission_modes: s.permission_modes,
      cost: s.cost,
      usage: s.usage,
      counts: s.counts,
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
      files: mine(s.files),
      // What a subagent was asked to do is a prompt too.
      subagents: (s.subagents ?? []).map((a) => ({ ...a, description: null })),
      instruction_files: (s.instruction_files ?? []).filter((path) => inRepo(path, hide)),
    },
    rewrite: upload.rewrite ? { ...upload.rewrite, files: mine(upload.rewrite.files) } : (upload.rewrite ?? null),
    lines: mine(upload.lines),
  };
}

interface Held {
  machine_id: string;
  source: string;
  session_id: string;
  owner_email: string;
  updated_at: unknown;
}

const keyOf = (s: Held): string => `${s.machine_id}\n${s.source}\n${s.session_id}`;
const at = (value: unknown): number => new Date(value as string).getTime();

/** Whoever a session is filed under, storing or removing their own in the organisation it is shown in. */
const as = (orgId: string, email: string): Principal => ({
  orgId,
  email,
  name: null,
  role: "member",
  tokenId: null,
  userId: null,
  signedIn: false,
});

/**
 * Bring the organisation the repository is shown in up to date: sessions
 * that are new or were sent again since they were last copied are copied,
 * and ones that are gone (taken back, their repository stopped) are removed
 * there too. Each is stored like an upload, in a transaction of its own, so
 * one that fails is said (`log`) and leaves the others. Then, if anything
 * changed, the pull requests there are matched again: a report of one comes
 * before the sessions that wrote it, which are copied later.
 *
 * Only sessions of the repository are touched in either organisation.
 */
export async function copyRepo(
  from: Each,
  to: Each,
  demo: Pick<Demo, "repo" | "hide">,
  key?: string,
  log: (err: unknown) => void = () => {},
): Promise<{ copied: number; removed: number; failed: number; matched: number }> {
  const held = (db: OrgDb) =>
    db.query<Held>(
      `SELECT machine_id, source, session_id, owner_email, updated_at FROM sessions WHERE org_id = $1 AND repo = $2`,
      [db.orgId, demo.repo],
    );
  const theirs = await from(held);
  const ours = new Map((await to(held)).map((s) => [keyOf(s), s]));
  let copied = 0;
  let removed = 0;
  let failed = 0;
  for (const s of theirs) {
    const have = ours.get(keyOf(s));
    ours.delete(keyOf(s));
    // Copied after it was last sent, and under the same person: nothing to do.
    if (have && have.owner_email === s.owner_email && at(have.updated_at) >= at(s.updated_at)) continue;
    try {
      const [row] = await from((db) =>
        db.query<{ payload: unknown }>(
          `SELECT payload FROM sessions WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4`,
          [db.orgId, s.machine_id, s.source, s.session_id],
        ),
      );
      // Gone in the moment since: the next time removes it here.
      if (!row) continue;
      const upload = shown((typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload) as Upload, demo.hide);
      await to(async (db) => {
        // Filed under another person since: theirs now, and not a copy beside the old one.
        if (have && have.owner_email !== s.owner_email) await removeUpload(db, as(db.orgId, have.owner_email), have);
        await storeUpload(db, upload, as(db.orgId, s.owner_email));
      });
      copied += 1;
    } catch (err) {
      failed += 1;
      log(err);
    }
  }
  // What is left was copied once and is in the repository no more.
  for (const gone of ours.values()) {
    try {
      if (await to((db) => removeUpload(db, as(db.orgId, gone.owner_email), gone))) removed += 1;
    } catch (err) {
      failed += 1;
      log(err);
    }
  }
  let matched = 0;
  if (copied + removed > 0) {
    // Some at a time, as the page's own button does it, until none is left or none gets further.
    let started: string | undefined;
    for (;;) {
      const some = await rematchPulls(to, { repo: demo.repo }, started, key, log);
      matched += some.matched;
      started = some.started;
      if (some.remaining === 0 || some.matched === 0) break;
    }
  }
  return { copied, removed, failed, matched };
}

/** The settings of a demo, and the default of the one that has one. */
const SETTINGS = ["SESSIONLY_DEMO_FROM", "SESSIONLY_DEMO_REPO", "SESSIONLY_DEMO_ORG"] as const;
const EVERY_MINUTES = 30;

/**
 * The demo the settings ask for: undefined if they ask for none, and what is
 * wrong with them otherwise. All three of where from, which repository and
 * where to are needed, and the two organisations are not the same one:
 * sessions are removed from where they are shown when they are gone from
 * where they came, which in one organisation would be every one of them.
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
    .map((path) => path.trim().replace(/^\.\//, ""))
    .filter(Boolean);
  return { from: from!, repo: repo!, org: org!, hide, minutes };
}
