// How numbers, times and names are shown. Pure functions, tested in test/.
import type { KeptAt, OutcomeCheckpoint, OutcomesAt, RewriteCheckpoint, RewriteTotals } from "@sessionly/schema";

const whole = new Intl.NumberFormat("en-US");

/** 1284 -> "1,284" */
export function count(n: number): string {
  return whole.format(Math.round(n));
}

/** 1284 -> "1,284", 12940 -> "12.9K", 4200000 -> "4.2M" */
export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 10_000) return count(n);
  if (abs < 1_000_000) return `${trim(n / 1_000)}K`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(n: number): string {
  return n.toFixed(Math.abs(n) < 100 ? 1 : 0).replace(/\.0$/, "");
}

/** Dollars: "$0.0042" below a cent, otherwise "$1,234.56". */
export function usd(n: number): string {
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What one line cost, or a small share: under a dollar, the two digits that say something. "$0.015", "$0.000042". */
export function usdEach(n: number): string {
  if (n >= 1 || n <= 0) return usd(n);
  const two = Number(n.toPrecision(2));
  return `$${two.toFixed(Math.min(8, Math.max(2, 1 - Math.floor(Math.log10(two)))))}`;
}

/** Dollars for a headline or an axis: "$4.20", "$1,284", "$12.9K". */
export function usdCompact(n: number): string {
  if (Math.abs(n) < 100) return usd(n);
  return `$${compact(n)}`;
}

/** A cost that may be missing, or an estimate (marked with ~). */
export function cost(value: number | null, source: string | null, show: (n: number) => string = usd): string {
  if (value == null) return "–";
  return source === "recorded" ? show(value) : `~${show(value)}`;
}

/** 7000 -> "7s", 843000 -> "14m 3s", 203760000 -> "56h 36m" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Active time, or a dash where none was recorded: Cursor records no turn lengths. */
export function activeTime(ms: number): string {
  return ms > 0 ? duration(ms) : "–";
}

/** A group's cost, or a dash if none of its sessions has a cost figure. */
export function groupCost(g: { cost_usd: number; sessions: number; sessions_without_cost: number }): string {
  return g.sessions > 0 && g.sessions_without_cost === g.sessions ? "–" : usd(g.cost_usd);
}

const TOOL_NAMES: Record<string, string> = { "claude-code": "Claude Code", cursor: "Cursor", grok: "Grok", codex: "Codex", opencode: "OpenCode" };

/** "claude-code" -> "Claude Code"; an agent this dashboard doesn't know keeps its id. */
export function toolName(source: string): string {
  return Object.hasOwn(TOOL_NAMES, source) ? TOOL_NAMES[source]! : source;
}

/** "claude-opus-5-5" -> "opus-5-5" */
export function modelName(model: string): string {
  return model.replace(/^claude-/, "");
}

/** A total over a number of things, to one decimal: 3 over 2 -> "1.5"; over none -> "–" */
export function average(total: number, over: number): string {
  return over > 0 ? (total / over).toFixed(1).replace(/\.0$/, "") : "–";
}

/** 0.4183 -> "42%"; null -> "–" */
export function percent(share: number | null): string {
  return share == null || Number.isNaN(share) ? "–" : `${Math.round(share * 100)}%`;
}

/** A share of lines as a percentage: "100%" only for all of them, "0%" only for none. */
export function shareOf(part: number, wholeAmount: number): string {
  if (!(wholeAmount > 0)) return "–";
  const rounded = Math.round((part / wholeAmount) * 100);
  return `${part < wholeAmount ? Math.min(rounded, 99) : rounded}%`.replace(/^0%$/, part > 0 ? "1%" : "0%");
}

export function share(part: number, wholeAmount: number): number | null {
  return wholeAmount > 0 ? part / wholeAmount : null;
}

/** Share of measured files that were rewritten. */
export function rewriteRate(r: RewriteTotals | null | undefined): number | null {
  return r ? share(r.files_rewritten, r.files_measured) : null;
}

/** Share of the agent's lines that are still there. */
export function linesKept(r: RewriteTotals | null | undefined): number | null {
  return r ? share(r.lines_surviving, r.lines_added) : null;
}

/**
 * Share of the agent's lines that were still there at a fixed age, over the
 * sessions measured at that age: "91%", or a dash when none was.
 */
export function keptAt(k: KeptAt | null | undefined): string {
  return k && k.sessions_reached > 0 ? percent(share(k.lines_surviving, k.lines_added)) : "–";
}

/** How many sessions that figure is of: "12 of 40 sessions". */
export function keptOf(k: Pick<KeptAt, "sessions_reached" | "sessions_total"> | null | undefined): string {
  if (!k) return "";
  return `${count(k.sessions_reached)} of ${count(k.sessions_total)} ${k.sessions_total === 1 ? "session" : "sessions"}`;
}

/**
 * Of the sessions counted at an age, the share a later fix commit changed
 * lines of by then ("changed by a fix"), or a dash when none was counted.
 */
export function fixedAt(o: OutcomesAt | null | undefined): string {
  return o && o.sessions_reached > 0 ? percent(share(o.sessions_with_fix, o.sessions_reached)) : "–";
}

/** Of the sessions counted at an age, the share reverted by then and not relanded, or a dash. */
export function revertedAt(o: OutcomesAt | null | undefined): string {
  return o && o.sessions_reached > 0 ? percent(share(o.sessions_reverted, o.sessions_reached)) : "–";
}

/**
 * Of an age's fix commits, the ones other agents' sessions made, by agent, and
 * the rest; empty when no agent's session made any. Only sessions on the same
 * machine are known, so the rest may be a teammate's agent as well as a person.
 */
export function fixesBy(o: { fix_commits?: number; by_agent?: readonly { source?: string; fix_commits?: number }[] | null }): string {
  const by = (o.by_agent ?? []).filter((b) => (b.fix_commits ?? 0) > 0);
  if (by.length === 0) return "";
  const rest = Math.max(0, (o.fix_commits ?? 0) - by.reduce((n, b) => n + (b.fix_commits ?? 0), 0));
  const parts = by.map((b) => `${count(b.fix_commits ?? 0)} by ${toolName(b.source ?? "")}`);
  if (rest > 0) parts.push(`${count(rest)} by no agent known`);
  return parts.join(", ");
}

/** What later commits did to a session's lines by one age, in a few words. */
export function laterWords(o: OutcomeCheckpoint): string {
  const parts: string[] = [];
  if ((o.revert_commits ?? 0) > 0) parts.push(o.relanded ? "reverted, relanded" : "reverted");
  const fixes = o.fix_commits ?? 0;
  const by = fixesBy(o);
  if (fixes > 0) parts.push(`${count(fixes)} ${fixes === 1 ? "fix" : "fixes"}${by ? ` (${by})` : ""}`);
  const rework = o.rework_commits ?? 0;
  if (rework > 0) parts.push(`${count(rework)} rework`);
  return parts.length ? parts.join(", ") : "nothing";
}

/**
 * What later commits did to a session's lines at each fixed age: a dash for
 * an age not counted, and the day it was counted on when that was late.
 */
export function laterAges(outcomes: readonly OutcomeCheckpoint[] | null | undefined): { name: string; words: string; later: string; late: number | null; counted: boolean }[] {
  return KEPT_AGES.map(({ name, days, words }) => {
    // Of what a server sends, the counts only: a server from before them may have kept anything.
    const o = (Array.isArray(outcomes) ? outcomes : []).find((one) => one && typeof one === "object" && one.checkpoint === name);
    if (!o) return { name, words, later: "–", late: null, counted: false };
    return { name, words, later: laterWords(o), late: takenLate(o.age_seconds ?? 0, days), counted: true };
  });
}

/** The ages a measurement is kept at, with each in days and in words. */
export const KEPT_AGES = [
  { name: "1d", days: 1, words: "1 day" },
  { name: "7d", days: 7, words: "7 days" },
  { name: "30d", days: 30, words: "30 days" },
] as const;

/** The day a measurement was taken on, when that was a day or more after the age it stands for; else null. */
export function takenLate(ageSeconds: number, days: number): number | null {
  const day = Math.floor(ageSeconds / 86_400);
  return day > days ? day : null;
}

/**
 * A session's lines at each fixed age after it ended: the share still
 * there, or a dash for an age it has not reached or was not measured at,
 * and the day it was measured on when that was later than the age.
 */
export function keptAges(checkpoints: readonly RewriteCheckpoint[] | null | undefined): { name: string; words: string; kept: string; late: number | null; lines: number | null }[] {
  return KEPT_AGES.map(({ name, days, words }) => {
    const c = (checkpoints ?? []).find((one) => one.checkpoint === name);
    if (!c) return { name, words, kept: "–", late: null, lines: null };
    return {
      name,
      words,
      kept: percent(share(c.surviving ?? 0, c.added ?? 0)),
      late: takenLate(c.age_seconds ?? 0, days),
      lines: c.added ?? 0,
    };
  });
}

/** "github.com/acme/web" -> "acme/web"; "~/src/thing" -> "src/thing" */
export function repoName(repo: string | null): string {
  if (!repo) return "–";
  if (repo === "~") return "home directory";
  const parts = repo.split("/").filter((p) => p && p !== "~");
  return parts.slice(-2).join("/") || repo;
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "–" : dateTimeFormat.format(date);
}

/** "2026-11-13" -> "Nov 13" (the key is a UTC day; no time zone shift) */
export function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export interface Bucket {
  /** First day of the bucket, YYYY-MM-DD. */
  start: string;
  /** "day" or "week" */
  span: "day" | "week";
  cost_usd: number;
  sessions: number;
}

const DAY_MS = 86_400_000;

/**
 * A continuous series for the cost chart: every day from the first to the
 * last with data, including days with nothing. Long ranges are grouped into
 * weeks (starting Monday) so the bars stay readable.
 */
export function costSeries(
  days: { key: string; cost_usd: number; sessions: number }[],
  maxBars = 92,
): Bucket[] {
  const dated = days
    .map((d) => ({ ...d, t: Date.parse(`${d.key}T00:00:00Z`) }))
    .filter((d) => !Number.isNaN(d.t))
    .sort((a, b) => a.t - b.t);
  if (dated.length === 0) return [];
  const first = dated[0]!.t;
  const last = dated[dated.length - 1]!.t;
  const weekly = (last - first) / DAY_MS + 1 > maxBars;
  const step = weekly ? 7 * DAY_MS : DAY_MS;
  // Monday of the first week: 1970-01-01 was a Thursday.
  const origin = weekly ? first - ((Math.floor(first / DAY_MS) + 3) % 7) * DAY_MS : first;
  const buckets: Bucket[] = [];
  for (let t = origin; t <= last; t += step) {
    buckets.push({
      start: new Date(t).toISOString().slice(0, 10),
      span: weekly ? "week" : "day",
      cost_usd: 0,
      sessions: 0,
    });
  }
  for (const d of dated) {
    const bucket = buckets[Math.floor((d.t - origin) / step)]!;
    bucket.cost_usd += d.cost_usd;
    bucket.sessions += d.sessions;
  }
  return buckets;
}

/** Round tick values from 0 up to at least `max`: [0, 50, 100, 150]. */
export function ticks(max: number, target = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / target;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough)!;
  const out: number[] = [];
  for (let v = 0; v < max + step - 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}
