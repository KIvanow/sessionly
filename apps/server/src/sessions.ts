// Storing uploaded sessions and answering the dashboard's questions about them.
import type { FileRow, GroupBy, Session, SessionRow, Totals, Upload } from "@sessionly/schema";
import type { Principal } from "./auth.ts";
import type { Db } from "./db.ts";

const UNKNOWN = "(unknown)";

export class Conflict extends Error {}

const num = (value: unknown): number => (value == null ? 0 : Number(value));
const numOrNull = (value: unknown): number | null => (value == null ? null : Number(value));
/** A jsonb array of strings, which a driver may hand over parsed or as text. */
const strings = (value: unknown): string[] => {
  const list = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(list) ? list.map(String) : [];
};

/** Store one session, replacing an earlier upload of the same session. */
export async function storeUpload(db: Db, upload: Upload, owner: Principal): Promise<void> {
  const s: Session = upload.session ?? {};
  const key = [s.machine_id, s.source, s.session_id];
  const existing = await db.query<{ owner_email: string }>(
    `SELECT owner_email FROM sessions WHERE machine_id = $1 AND source = $2 AND session_id = $3`,
    key,
  );
  if (existing[0] && existing[0].owner_email !== owner.email) {
    throw new Conflict("this session was uploaded by someone else");
  }
  const usage = s.usage ?? [];
  const counts = s.counts ?? {};
  const rewrite = upload.rewrite ?? null;
  const columns: Record<string, unknown> = {
    machine_id: s.machine_id,
    source: s.source,
    session_id: s.session_id,
    owner_email: owner.email,
    user_email: s.user?.email ?? null,
    user_name: s.user?.name ?? null,
    repo: s.repo?.remote ?? s.repo?.root ?? s.cwd ?? null,
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
    payload: JSON.stringify(upload),
  };
  const names = Object.keys(columns);
  const casts: Record<string, string> = { models: "::jsonb", payload: "::jsonb" };
  const placeholders = names.map((name, i) => `$${i + 1}${casts[name] ?? ""}`);
  const updates = names
    .filter((name) => !["machine_id", "source", "session_id"].includes(name))
    .map((name) => `${name} = EXCLUDED.${name}`);
  await db.query(
    `INSERT INTO sessions (${names.join(", ")}) VALUES (${placeholders.join(", ")})
     ON CONFLICT (machine_id, source, session_id)
     DO UPDATE SET ${updates.join(", ")}, updated_at = now()`,
    Object.values(columns),
  );
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
  /** The agent exactly: `claude-code`, `cursor` or `grok`. */
  tool?: string;
  /** Substring of the title, repository, branch, or anything in the record. */
  q?: string;
  since?: string;
  until?: string;
}

/** WHERE clause for what `viewer` may see, narrowed by `filters`. */
function where(viewer: Principal, filters: Filters): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown) => `$${params.push(value)}`;
  const like = (text: string) => bind(`%${text.replace(/[\\%_]/g, "\\$&")}%`);
  if (viewer.role !== "admin") conditions.push(`owner_email = ${bind(viewer.email)}`);
  if (filters.user) conditions.push(`owner_email ILIKE ${like(filters.user)}`);
  if (filters.repo) conditions.push(`repo ILIKE ${like(filters.repo)}`);
  if (filters.repo_is === UNKNOWN) conditions.push(`repo IS NULL`);
  else if (filters.repo_is) conditions.push(`repo = ${bind(filters.repo_is)}`);
  if (filters.model) conditions.push(`models::text ILIKE ${like(filters.model)}`);
  if (filters.model_is === UNKNOWN) conditions.push(`primary_model IS NULL`);
  else if (filters.model_is) conditions.push(`primary_model = ${bind(filters.model_is)}`);
  if (filters.tool) conditions.push(`source = ${bind(filters.tool)}`);
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
  return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
}

const GROUP_KEY: Record<GroupBy, string> = {
  user: `owner_email`,
  repo: `coalesce(repo, '${UNKNOWN}')`,
  model: `coalesce(primary_model, '${UNKNOWN}')`,
  tool: `source`,
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
  db: Db,
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
  db: Db,
  viewer: Principal,
  filters: Filters,
  page: { limit: number; offset: number },
): Promise<{ sessions: SessionRow[]; total: number }> {
  const { sql, params } = where(viewer, filters);
  const rows = await db.query(
    `SELECT machine_id, source, session_id, owner_email, repo, branch, title,
            payload->'session'->'prompts'->0->'text'->>'preview' AS first_prompt,
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
  db: Db,
  viewer: Principal,
  key: { machine_id: string; source: string; session_id: string },
): Promise<{ owner_email: string; updated_at: string; upload: Upload } | null> {
  const rows = await db.query<{ owner_email: string; updated_at: unknown; payload: unknown }>(
    `SELECT owner_email, updated_at, payload FROM sessions
     WHERE machine_id = $1 AND source = $2 AND session_id = $3`,
    [key.machine_id, key.source, key.session_id],
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
  db: Db,
  viewer: Principal,
  filters: Filters,
  limit: number,
): Promise<{ files: FileRow[]; total: number }> {
  const { sql, params } = where(viewer, filters);
  const and = sql ? `${sql} AND` : "WHERE";
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
  db: Db,
  viewer: Principal,
): Promise<{ users: string[]; repos: string[]; models: string[]; tools: string[] }> {
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
  };
}
