// How numbers, times and names are shown. Pure functions, tested in test/.
import type { RewriteTotals } from "@sessionly/schema";

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
  // Under a cent, as many places as say something: what one line cost is often a hundredth of one.
  if (n > 0 && n < 0.01) return `$${n.toFixed(Math.min(8, Math.max(4, 1 - Math.floor(Math.log10(n)))))}`;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Dollars for a headline or an axis: "$4.20", "$1,284", "$12.9K". */
export function usdCompact(n: number): string {
  if (Math.abs(n) < 100) return usd(n);
  return `$${compact(n)}`;
}

/** A cost that may be missing, or an estimate (marked with ~). */
export function cost(value: number | null, source: string | null): string {
  if (value == null) return "–";
  return source === "recorded" ? usd(value) : `~${usd(value)}`;
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

const TOOL_NAMES: Record<string, string> = { "claude-code": "Claude Code", cursor: "Cursor", grok: "Grok", codex: "Codex" };

/** "claude-code" -> "Claude Code"; an agent this dashboard doesn't know keeps its id. */
export function toolName(source: string): string {
  return TOOL_NAMES[source] ?? source;
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
