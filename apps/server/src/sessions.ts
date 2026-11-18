// Storing uploaded sessions and answering the dashboard's questions about them.
import {
  parseRepo,
  sessionCovered,
  type ExcludedRepos,
  type FileRow,
  type GroupBy,
  type HeldSessions,
  type Session,
  type SessionPlace,
  type SessionRow,
  type Totals,
  type Upload,
} from "@sessionly/schema";
import type { Principal } from "./auth.ts";
import type { OrgDb } from "./db.ts";

const UNKNOWN = "(unknown)";

export class Conflict extends Error {}

const num = (value: unknown): number => (value == null ? 0 : Number(value));
const numOrNull = (value: unknown): number | null => (value == null ? null : Number(value));
/** A jsonb array of strings, which a driver may hand over parsed or as text. */
const strings = (value: unknown): string[] => {
  const list = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(list) ? list.map(String) : [];
};

/**
 * Whose session an upload is. A token belongs to one person and its uploads
 * are theirs, whatever name the record carries. The exception is a cloud
 * session uploaded with an `env` token: that token sits in an environment
 * several people start sessions in, so the session is filed under the person
 * the platform named, and under the token's own address only if it named
 * nobody.
 */
export function ownerOf(upload: Upload, uploader: Principal): string {
  const s: Session = upload.session ?? {};
  const named = s.user?.email?.trim().toLowerCase() ?? "";
  const cloud = s.runtime?.kind === "cloud";
  return uploader.role === "env" && cloud && /^\S+@\S+$/.test(named) ? named : uploader.email;
}

/** What storing an upload did. `excluded` means the repository is stopped, so nothing was stored. */
export type StoreResult = { stored: boolean; excluded?: true };

/**
 * Store one session, replacing an earlier upload of the same session.
 * `stored` is false when what the server has was kept instead, or when the
 * person has stopped the repository: then a copy of theirs is removed.
 */
export async function storeUpload(db: OrgDb, upload: Upload, uploader: Principal): Promise<StoreResult> {
  const s: Session = upload.session ?? {};
  const owner = { email: ownerOf(upload, uploader) };
  const cloud = s.runtime?.kind === "cloud";
  const counts = s.counts ?? {};
  const key = [db.orgId, s.machine_id, s.source, s.session_id];
  const repoName = s.repo?.remote ?? s.repo?.root ?? s.cwd ?? null;
  const place: SessionPlace = { repo: repoName, root: s.repo?.root ?? null, cwd: s.cwd ?? null };
  // A row filed under the environment's own address is this person's too:
  // storing this would have moved it to them.
  const mayRefile = uploader.role === "env" ? uploader.email : null;
  // Before the row is read: stopping the repository removes what is there.
  await oneAtATime(db, owner.email, "storing");
  if (await submissionStopped(db, owner.email, place)) {
    await dropOwn(db, key, owner.email, mayRefile);
    return { stored: false, excluded: true };
  }
  const [existing] = await db.query<{ owner_email: string; runtime: string | null; prompts: number }>(
    `SELECT owner_email, runtime, prompts FROM sessions
     WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4`,
    key,
  );
  if (existing && existing.owner_email !== owner.email) {
    // A session first filed under the environment's own address (the
    // platform had not named anyone yet) moves to its person.
    const refiled = uploader.role === "env" && existing.owner_email === uploader.email;
    if (!refiled) throw new Conflict("this session was uploaded by someone else");
  }
  // A cloud session can outlive its sandbox. The next sandbox has seen only
  // what happened since it started: what it sends must not replace more.
  if (existing?.runtime === "cloud" && cloud && (counts.prompts ?? 0) < Number(existing.prompts)) {
    return { stored: false };
  }
  const usage = s.usage ?? [];
  const rewrite = upload.rewrite ?? null;
  const columns: Record<string, unknown> = {
    org_id: db.orgId,
    machine_id: s.machine_id,
    source: s.source,
    session_id: s.session_id,
    owner_email: owner.email,
    runtime: s.runtime?.kind ?? null,
    runtime_id: s.runtime?.id ?? null,
    // An empty one is none: the session is then its uploader's.
    user_email: s.user?.email || null,
    user_name: s.user?.name ?? null,
    repo: repoName,
    repo_root: place.root,
    cwd: place.cwd,
    branch: s.repo?.branch ?? null,
    title: s.title ?? null,
    started_at: s.started_at ?? null,
    ended_at: s.ended_at ?? null,
    duration_ms: s.duration_ms ?? null,
    active_ms: s.active_ms ?? 0,
    cost_usd: s.cost?.total_usd ?? null,
    cost_source: s.cost?.source ?? null,
    unpriced_requests: s.cost?.unpriced_requests ?? 0,
    primary_model: s.models?.[0] ?? null,
    models: JSON.stringify(s.models ?? []),
    input_tokens: usage.reduce((sum, u) => sum + (u.input_tokens ?? 0), 0),
    output_tokens: usage.reduce((sum, u) => sum + (u.output_tokens ?? 0), 0),
    prompts: counts.prompts ?? 0,
    tool_calls: counts.tool_calls ?? 0,
    tool_failures: counts.tool_failures ?? 0,
    subagents: counts.subagents ?? 0,
    files_changed: counts.files_changed ?? 0,
    lines_added: counts.lines_added ?? 0,
    lines_removed: counts.lines_removed ?? 0,
    content: s.content ?? "metadata",
    captured_by: s.captured_by ?? null,
    captured_from_start: s.captured_from_start ?? true,
    collector_version: s.collector_version ?? null,
    rw_files_measured: rewrite?.files_measured ?? null,
    rw_files_rewritten: rewrite?.files_rewritten ?? null,
    rw_lines_added: rewrite?.lines_added ?? null,
    rw_lines_surviving: rewrite?.lines_surviving ?? null,
    rw_measured_at: rewrite?.measured_at ?? null,
    hashed_lines: (upload.lines ?? []).reduce((sum, file) => sum + (file.hashes?.length ?? 0), 0),
    payload: JSON.stringify(upload),
  };
  const names = Object.keys(columns);
  const casts: Record<string, string> = { models: "::jsonb", payload: "::jsonb" };
  const placeholders = names.map((name, i) => `$${i + 1}${casts[name] ?? ""}`);
  const updates = names
    .filter((name) => !["org_id", "machine_id", "source", "session_id"].includes(name))
    .map((name) => `${name} = EXCLUDED.${name}`);
  // The check above read the row a moment ago. If someone else stored this
  // very session in between, it is theirs: the update is skipped, not won by
  // whoever came last.
  const stored = await db.query(
    `INSERT INTO sessions (${names.join(", ")}) VALUES (${placeholders.join(", ")})
     ON CONFLICT (org_id, machine_id, source, session_id)
     DO UPDATE SET ${updates.join(", ")}, updated_at = now()
     WHERE sessions.owner_email = EXCLUDED.owner_email OR sessions.owner_email = $${names.length + 1}
     RETURNING 1`,
    [...Object.values(columns), mayRefile],
  );
  if (stored.length === 0) throw new Conflict("this session was uploaded by someone else");
  return { stored: true };
}

/**
 * Storing a person's session and stopping a repository of theirs take turns.
 * Otherwise each could finish without seeing what the other wrote, and a
 * session would stay in a repository that is stopped. Uploads do not wait
 * for one another. Held until the transaction ends.
 */
async function oneAtATime(db: OrgDb, email: string, doing: "storing" | "stopping"): Promise<void> {
  const lock = doing === "stopping" ? "pg_advisory_xact_lock" : "pg_advisory_xact_lock_shared";
  await db.query(`SELECT ${lock}(hashtext($1))`, [`sessionly-stop:${db.orgId}:${email}`]);
}

/**
 * Delete this person's copy of one session, if it is theirs. `refiled` is the
 * address of the environment uploading it, whose copy is this person's too.
 */
async function dropOwn(db: OrgDb, key: unknown[], email: string, refiled: string | null): Promise<void> {
  const removed = await db.query(
    `DELETE FROM sessions
     WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4
       AND (owner_email = $5 OR owner_email = $6)
     RETURNING machine_id, source, session_id`,
    [...key, email, refiled],
  );
  await forgetLines(db, removed);
}

/**
 * A deleted session's lines go from the pull requests that kept which ones
 * they were. That it had lines there, and how many, stays: the pull request
 * then says a session of it was deleted since.
 */
async function forgetLines(db: OrgDb, sessions: Record<string, unknown>[]): Promise<void> {
  if (sessions.length === 0) return;
  await db.query(
    `UPDATE pull_sessions p SET matched = NULL
     FROM jsonb_to_recordset($2::jsonb) AS gone(machine_id text, source text, session_id text)
     WHERE p.org_id = $1 AND p.machine_id = gone.machine_id AND p.source = gone.source
       AND p.session_id = gone.session_id AND p.matched IS NOT NULL`,
    [db.orgId, JSON.stringify(sessions.map((s) => ({ machine_id: s.machine_id, source: s.source, session_id: s.session_id })))],
  );
}

/** Whether this person stopped the repository a session is filed under, or a folder it ran in. */
async function submissionStopped(db: OrgDb, email: string, place: SessionPlace): Promise<boolean> {
  const rules = await db.query<{ repo: string }>(
    `SELECT repo FROM repo_exclusions WHERE org_id = $1 AND owner_email = $2`,
    [db.orgId, email],
  );
  return rules.some((rule) => sessionCovered(place, rule.repo));
}

/** The repositories this person stopped, in name order, and how often they allowed one again. */
export async function listExcluded(db: OrgDb, email: string): Promise<ExcludedRepos> {
  const rows = await db.query<{ repo: string }>(
    `SELECT repo FROM repo_exclusions WHERE org_id = $1 AND owner_email = $2 ORDER BY repo`,
    [db.orgId, email],
  );
  const [allowed] = await db.query<{ times: number }>(
    `SELECT times FROM repos_allowed_again WHERE org_id = $1 AND owner_email = $2`,
    [db.orgId, email],
  );
  return { repos: rows.map((row) => row.repo), allowed_again: num(allowed?.times) };
}

/**
 * The sessions of this person the server has from one machine. A machine
 * asks after a repository was allowed again: what it sent and is not here
 * was deleted, and is sent again.
 */
export async function heldSessions(db: OrgDb, email: string, machine: string): Promise<HeldSessions> {
  const sessions = await db.query<{ source: string; session_id: string }>(
    `SELECT source, session_id FROM sessions
     WHERE org_id = $1 AND owner_email = $2 AND machine_id = $3 ORDER BY source, session_id`,
    [db.orgId, email, machine],
  );
  return { sessions };
}

/**
 * Stop `raw` for this person and delete the sessions of theirs it covers.
 * Doing it again deletes any that arrived since.
 */
export async function excludeRepo(
  db: OrgDb,
  email: string,
  raw: unknown,
): Promise<{ repo: string; sessions_removed: number; covers_folders: boolean }> {
  const parsed = parseRepo(raw);
  if (!parsed.ok) throw new RepoNameError(parsed.error);
  const { repo, coversFolders } = parsed.name;
  await oneAtATime(db, email, "stopping");
  await db.query(
    `INSERT INTO repo_exclusions (org_id, owner_email, repo) VALUES ($1, $2, $3)
     ON CONFLICT (org_id, owner_email, repo) DO NOTHING`,
    [db.orgId, email, repo],
  );
  // Which sessions the name covers is decided by the one rule everything
  // else uses, on the few places this person's sessions are from.
  const places = await db.query<{ repo: string | null; root: string | null; cwd: string | null }>(
    `SELECT DISTINCT repo, repo_root AS root, cwd FROM sessions WHERE org_id = $1 AND owner_email = $2`,
    [db.orgId, email],
  );
  const gone = places.filter((place) => sessionCovered(place, repo));
  if (gone.length === 0) return { repo, sessions_removed: 0, covers_folders: coversFolders };
  const removed = await db.query(
    `DELETE FROM sessions s
     USING unnest($3::text[], $4::text[], $5::text[]) AS gone(repo, root, cwd)
     WHERE s.org_id = $1 AND s.owner_email = $2
       AND s.repo IS NOT DISTINCT FROM gone.repo
       AND s.repo_root IS NOT DISTINCT FROM gone.root
       AND s.cwd IS NOT DISTINCT FROM gone.cwd
     RETURNING s.machine_id, s.source, s.session_id`,
    [db.orgId, email, gone.map((place) => place.repo), gone.map((place) => place.root), gone.map((place) => place.cwd)],
  );
  await forgetLines(db, removed);
  return { repo, sessions_removed: removed.length, covers_folders: coversFolders };
}

/** Allow a repository again. Returns its name, or null if it was not stopped. Nothing deleted is restored. */
export async function includeRepo(db: OrgDb, email: string, raw: unknown): Promise<string | null> {
  const parsed = parseRepo(raw);
  if (!parsed.ok) throw new RepoNameError(parsed.error);
  const rows = await db.query<{ repo: string }>(
    `DELETE FROM repo_exclusions WHERE org_id = $1 AND owner_email = $2 AND repo = $3 RETURNING repo`,
    [db.orgId, email, parsed.name.repo],
  );
  if (!rows[0]) return null;
  // What stopping deleted may be sent again from now on. Each machine of
  // this person sees the number change and asks what is still here.
  await db.query(
    `INSERT INTO repos_allowed_again (org_id, owner_email, times) VALUES ($1, $2, 1)
     ON CONFLICT (org_id, owner_email) DO UPDATE SET times = repos_allowed_again.times + 1`,
    [db.orgId, email],
  );
  return rows[0].repo;
}

/** `parseRepo` refused the name. The route says so as a 400. */
export class RepoNameError extends Error {}

/**
 * Take back one session its uploader no longer has: what it held is now part
 * of another session, which a second copy here would count twice. Only the
 * person it is filed under can: for an `env` token that is its own address,
 * so a cloud session filed under whoever started it stays. Returns whether
 * there was one to remove.
 */
export async function removeUpload(
  db: OrgDb,
  uploader: Principal,
  key: { machine_id: string; source: string; session_id: string },
): Promise<boolean> {
  const removed = await db.query(
    `DELETE FROM sessions
     WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4 AND owner_email = $5
     RETURNING machine_id, source, session_id`,
    [db.orgId, key.machine_id, key.source, key.session_id, uploader.email],
  );
  await forgetLines(db, removed);
  return removed.length > 0;
}

export type { GroupBy };

export interface Filters {
  /** Substring of the uploader's email. */
  user?: string;
  /** Substring of the repository. */
  repo?: string;
  /** The repository exactly, as a summary by repository names it. */
  repo_is?: string;
  /** Substring of any model used. */
  model?: string;
  /** The session's main model exactly, as a summary by model names it. */
  model_is?: string;
  /** The agent exactly: `claude-code`, `cursor`, `grok` or `codex`. */
  tool?: string;
  /** Where it ran: `cloud`, or `local` for a person's own machine. */
  runtime?: string;
  /** Substring of the title, repository, branch, or anything in the record. */
  q?: string;
  since?: string;
  until?: string;
}

/**
 * WHERE clause for what `viewer` may see, narrowed by `filters`. It always
 * starts with the viewer's organisation: an admin sees all of it, anyone
 * else their own sessions in it.
 */
function where(viewer: Principal, filters: Filters): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (value: unknown) => `$${params.push(value)}`;
  const like = (text: string) => bind(`%${text.replace(/[\\%_]/g, "\\$&")}%`);
  const conditions: string[] = [`org_id = ${bind(viewer.orgId)}`];
  if (viewer.role !== "admin") conditions.push(`owner_email = ${bind(viewer.email)}`);
  if (filters.user) conditions.push(`owner_email ILIKE ${like(filters.user)}`);
  if (filters.repo) conditions.push(`repo ILIKE ${like(filters.repo)}`);
  if (filters.repo_is === UNKNOWN) conditions.push(`repo IS NULL`);
  else if (filters.repo_is) conditions.push(`repo = ${bind(filters.repo_is)}`);
  if (filters.model) conditions.push(`models::text ILIKE ${like(filters.model)}`);
  if (filters.model_is === UNKNOWN) conditions.push(`primary_model IS NULL`);
  else if (filters.model_is) conditions.push(`primary_model = ${bind(filters.model_is)}`);
  if (filters.tool) conditions.push(`source = ${bind(filters.tool)}`);
  if (filters.runtime === "local") conditions.push(`runtime IS NULL`);
  else if (filters.runtime) conditions.push(`runtime = ${bind(filters.runtime)}`);
  if (filters.q) {
    const p = like(filters.q);
    conditions.push(
      `(title ILIKE ${p} OR repo ILIKE ${p} OR branch ILIKE ${p} OR session_id ILIKE ${p}
        OR (payload->'session'->'prompts')::text ILIKE ${p}
        OR (payload->'session'->'files')::text ILIKE ${p})`,
    );
  }
  if (filters.since) conditions.push(`started_at >= ${bind(filters.since)}::timestamptz`);
  if (filters.until) conditions.push(`started_at < ${bind(filters.until)}::timestamptz`);
  return { sql: `WHERE ${conditions.join(" AND ")}`, params };
}

const GROUP_KEY: Record<GroupBy, string> = {
  user: `owner_email`,
  repo: `coalesce(repo, '${UNKNOWN}')`,
  model: `coalesce(primary_model, '${UNKNOWN}')`,
  tool: `source`,
  runtime: `coalesce(runtime, 'local')`,
  day: `coalesce(to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), '${UNKNOWN}')`,
};

const TOTAL_COLUMNS = `
  count(*) AS sessions,
  coalesce(sum(cost_usd), 0) AS cost_usd,
  count(*) FILTER (WHERE cost_usd IS NULL) AS sessions_without_cost,
  count(*) FILTER (WHERE cost_usd IS NOT NULL AND cost_source <> 'recorded') AS sessions_with_estimated_cost,
  sum(active_ms) AS active_ms, sum(prompts) AS prompts, sum(tool_calls) AS tool_calls,
  sum(tool_failures) AS tool_failures, sum(files_changed) AS files_changed,
  sum(lines_added) AS lines_added, sum(lines_removed) AS lines_removed,
  sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
  jsonb_agg(DISTINCT source) AS tools,
  jsonb_agg(DISTINCT primary_model) FILTER (WHERE primary_model IS NOT NULL) AS models,
  sum(rw_files_measured) AS rw_files_measured, sum(rw_files_rewritten) AS rw_files_rewritten,
  sum(rw_lines_added) AS rw_lines_added, sum(rw_lines_surviving) AS rw_lines_surviving`;

function totals(row: Record<string, unknown>): Totals {
  return {
    key: String(row.key),
    sessions: num(row.sessions),
    cost_usd: num(row.cost_usd),
    sessions_without_cost: num(row.sessions_without_cost),
    sessions_with_estimated_cost: num(row.sessions_with_estimated_cost),
    active_ms: num(row.active_ms),
    prompts: num(row.prompts),
    tool_calls: num(row.tool_calls),
    tool_failures: num(row.tool_failures),
    files_changed: num(row.files_changed),
    lines_added: num(row.lines_added),
    lines_removed: num(row.lines_removed),
    input_tokens: num(row.input_tokens),
    output_tokens: num(row.output_tokens),
    tools: strings(row.tools).sort(),
    models: strings(row.models).sort(),
    rewrite: {
      files_measured: num(row.rw_files_measured),
      files_rewritten: num(row.rw_files_rewritten),
      lines_added: num(row.rw_lines_added),
      lines_surviving: num(row.rw_lines_surviving),
    },
  };
}

/** Totals per group (largest cost first; days oldest first) and overall. */
export async function summarize(
  db: OrgDb,
  viewer: Principal,
  by: GroupBy,
  filters: Filters,
): Promise<{ groups: Totals[]; total: Totals }> {
  const { sql, params } = where(viewer, filters);
  const order = by === "day" ? "1" : "cost_usd DESC, 1";
  const groups = await db.query(
    `SELECT ${GROUP_KEY[by]} AS key, ${TOTAL_COLUMNS} FROM sessions ${sql} GROUP BY 1 ORDER BY ${order}`,
    params,
  );
  const [total] = await db.query(`SELECT 'total' AS key, ${TOTAL_COLUMNS} FROM sessions ${sql}`, params);
  return { groups: groups.map(totals), total: totals(total ?? { key: "total" }) };
}

const iso = (value: unknown): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();

/** Sessions the viewer may see, newest first. */
export async function listSessions(
  db: OrgDb,
  viewer: Principal,
  filters: Filters,
  page: { limit: number; offset: number },
): Promise<{ sessions: SessionRow[]; total: number }> {
  const { sql, params } = where(viewer, filters);
  const rows = await db.query(
    `SELECT machine_id, source, session_id, owner_email, runtime, repo, branch, title,
            (SELECT p->'text'->>'preview'
               FROM jsonb_array_elements(payload->'session'->'prompts') WITH ORDINALITY AS t(p, n)
              WHERE coalesce(p->'text'->>'preview', '') <> ''
              ORDER BY n LIMIT 1) AS first_prompt,
            started_at, duration_ms, active_ms, cost_usd, cost_source, primary_model, prompts,
            tool_calls, tool_failures, files_changed, lines_added, lines_removed, content,
            captured_by, rw_files_measured, rw_files_rewritten, rw_lines_added,
            rw_lines_surviving, updated_at
     FROM sessions ${sql}
     ORDER BY started_at DESC NULLS LAST, session_id
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, page.limit, page.offset],
  );
  const [count] = await db.query<{ n: unknown }>(`SELECT count(*) AS n FROM sessions ${sql}`, params);
  return {
    total: num(count?.n),
    sessions: rows.map((r) => ({
      machine_id: String(r.machine_id),
      source: String(r.source),
      session_id: String(r.session_id),
      owner_email: String(r.owner_email),
      runtime: (r.runtime as string) ?? null,
      repo: (r.repo as string) ?? null,
      branch: (r.branch as string) ?? null,
      title: (r.title as string) ?? null,
      first_prompt: (r.first_prompt as string) || null,
      started_at: iso(r.started_at),
      duration_ms: numOrNull(r.duration_ms),
      active_ms: num(r.active_ms),
      cost_usd: numOrNull(r.cost_usd),
      cost_source: (r.cost_source as string) ?? null,
      primary_model: (r.primary_model as string) ?? null,
      prompts: num(r.prompts),
      tool_calls: num(r.tool_calls),
      tool_failures: num(r.tool_failures),
      files_changed: num(r.files_changed),
      lines_added: num(r.lines_added),
      lines_removed: num(r.lines_removed),
      content: String(r.content),
      captured_by: (r.captured_by as string) ?? null,
      rewrite:
        r.rw_files_measured == null
          ? null
          : {
              files_measured: num(r.rw_files_measured),
              files_rewritten: num(r.rw_files_rewritten),
              lines_added: num(r.rw_lines_added),
              lines_surviving: num(r.rw_lines_surviving),
            },
      updated_at: iso(r.updated_at) ?? "",
    })),
  };
}

/** One session as uploaded, or null if it doesn't exist or isn't the viewer's to see. */
export async function getSession(
  db: OrgDb,
  viewer: Principal,
  key: { machine_id: string; source: string; session_id: string },
): Promise<{ owner_email: string; updated_at: string; upload: Upload } | null> {
  const rows = await db.query<{ owner_email: string; updated_at: unknown; payload: unknown }>(
    `SELECT owner_email, updated_at, payload FROM sessions
     WHERE org_id = $1 AND machine_id = $2 AND source = $3 AND session_id = $4`,
    [db.orgId, key.machine_id, key.source, key.session_id],
  );
  const row = rows[0];
  if (!row || (viewer.role !== "admin" && row.owner_email !== viewer.email)) return null;
  const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  return { owner_email: row.owner_email, updated_at: iso(row.updated_at) ?? "", upload: payload as Upload };
}

/**
 * Files that agents changed in the sessions the viewer may see: how much was
 * added and removed, and how much of what was added is still there.
 */
export async function listFiles(
  db: OrgDb,
  viewer: Principal,
  filters: Filters,
  limit: number,
): Promise<{ files: FileRow[]; total: number }> {
  const { sql, params } = where(viewer, filters);
  const and = `${sql} AND`;
  const changed = `sessions CROSS JOIN LATERAL
    jsonb_array_elements(coalesce(payload->'session'->'files', '[]'::jsonb)) AS f
    ${and} coalesce((f->>'writes')::double precision, 0) > 0`;
  const rows = await db.query(
    `SELECT f->>'path' AS path,
            count(DISTINCT machine_id || '/' || source || '/' || session_id) AS sessions,
            sum(coalesce((f->>'lines_added')::double precision, 0)) AS lines_added,
            sum(coalesce((f->>'lines_removed')::double precision, 0)) AS lines_removed,
            bool_or(coalesce((f->>'created')::boolean, false)) AS created,
            max(started_at) AS last_changed,
            jsonb_agg(DISTINCT source) AS tools
     FROM ${changed}
     GROUP BY 1 ORDER BY 3 DESC, 1 LIMIT $${params.length + 1}`,
    [...params, limit],
  );
  const [count] = await db.query<{ n: unknown }>(
    `SELECT count(DISTINCT f->>'path') AS n FROM ${changed}`,
    params,
  );
  const measured = await db.query(
    `SELECT r->>'path' AS path,
            sum(coalesce((r->>'lines_added')::double precision, 0)) AS lines_added,
            sum(coalesce((r->>'lines_surviving')::double precision, 0)) AS lines_surviving,
            bool_and(coalesce((r->>'exists')::boolean, true)) AS exists_now
     FROM sessions CROSS JOIN LATERAL
       jsonb_array_elements(coalesce(payload->'rewrite'->'files', '[]'::jsonb)) AS r
     ${sql} GROUP BY 1`,
    params,
  );
  const rewrite = new Map(measured.map((r) => [String(r.path), r]));
  return {
    total: num(count?.n),
    files: rows.map((r) => {
      const m = rewrite.get(String(r.path));
      return {
        path: String(r.path),
        sessions: num(r.sessions),
        lines_added: num(r.lines_added),
        lines_removed: num(r.lines_removed),
        created: r.created === true,
        last_changed: iso(r.last_changed),
        tools: strings(r.tools).sort(),
        rewrite: m
          ? {
              lines_added: num(m.lines_added),
              lines_surviving: num(m.lines_surviving),
              exists: m.exists_now !== false,
            }
          : null,
      };
    }),
  };
}

/** Values to offer in the dashboard's filters. */
export async function filterOptions(
  db: OrgDb,
  viewer: Principal,
): Promise<{ users: string[]; repos: string[]; models: string[]; tools: string[]; runtimes: string[] }> {
  const { sql, params } = where(viewer, {});
  const column = async (expr: string) =>
    (
      await db.query<{ v: string }>(
        `SELECT DISTINCT ${expr} AS v FROM sessions ${sql} ORDER BY 1`,
        params,
      )
    )
      .map((r) => r.v)
      .filter((v) => v != null);
  return {
    users: await column("owner_email"),
    repos: await column("repo"),
    models: await column("primary_model"),
    tools: await column("source"),
    runtimes: await column("coalesce(runtime, 'local')"),
  };
}
