import { useEffect, useRef, useState } from "react";
import type { Pick } from "./App.tsx";
import { costSeries, count, dayLabel, ticks, usd, usdCompact, type Bucket } from "./format.ts";

const HEIGHT = 220;
const MARGIN = { top: 12, right: 8, bottom: 26, left: 52 };
const MAX_BAR = 24;

function label(bucket: Bucket): string {
  return bucket.span === "week" ? `Week of ${dayLabel(bucket.start)}` : dayLabel(bucket.start);
}

/** A column standing on the baseline: square, like everything else on the sheet. */
function column(x: number, y: number, width: number, height: number): string {
  return `M${x},${y + height} V${y} H${x + width} V${y + height} Z`;
}

/**
 * Cost over time: one column per day, or per week for long ranges. One
 * series, so no legend; the heading names it. Every value is also in the
 * table view. Clicking a column narrows the rest of the page to it; clicking
 * it again goes back to the whole period.
 */
export function CostChart({
  days,
  picked,
  onPick,
}: {
  days: { key: string; cost_usd: number; sessions: number }[];
  picked: Pick | null;
  onPick: (pick: Pick | null) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(320, entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const buckets = costSeries(days);
  const undated = days.filter((d) => Number.isNaN(Date.parse(`${d.key}T00:00:00Z`)));
  const span = buckets[0]?.span ?? "day";
  const yTicks = ticks(Math.max(0, ...buckets.map((b) => b.cost_usd)));
  const top = yTicks[yTicks.length - 1]!;
  const plot = { width: width - MARGIN.left - MARGIN.right, height: HEIGHT - MARGIN.top - MARGIN.bottom };
  const band = buckets.length ? plot.width / buckets.length : plot.width;
  // A 2px gap between neighbours, and never thicker than MAX_BAR.
  const bar = Math.max(1, Math.min(MAX_BAR, band - 2));
  const y = (value: number) => MARGIN.top + plot.height * (1 - value / top);
  const everyNth = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(plot.width / 80))));
  const shown = active == null ? null : buckets[active];
  const isPicked = (b: Bucket) => picked?.start === b.start && picked.span === b.span;
  // A column with no sessions has nothing to narrow to.
  const pick = (b: Bucket) => b.sessions > 0 && onPick(isPicked(b) ? null : { start: b.start, span: b.span });

  return (
    <section className="card" aria-labelledby="cost-chart-title">
      <div className="card-head">
        <h2 id="cost-chart-title">Cost per {span}</h2>
        <span className="card-actions">
          {picked ? (
            <button className="quiet" onClick={() => onPick(null)}>
              Show the whole period
            </button>
          ) : (
            buckets.length > 0 && <span className="muted">Click a {span} to filter by it</span>
          )}
          <button className="quiet" onClick={() => setAsTable(!asTable)} aria-pressed={asTable}>
            {asTable ? "Show chart" : "Show as table"}
          </button>
        </span>
      </div>
      {buckets.length === 0 ? (
        <p className="muted">No dated sessions in this range.</p>
      ) : asTable ? (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{span === "week" ? "Week starting" : "Day"}</th>
                <th scope="col" className="num">Cost</th>
                <th scope="col" className="num">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.start} className={isPicked(b) ? "picked" : undefined}>
                  <th scope="row">
                    {b.sessions > 0 ? (
                      <button className="quiet" aria-pressed={isPicked(b)} onClick={() => pick(b)}>
                        {b.start}
                      </button>
                    ) : (
                      b.start
                    )}
                  </th>
                  <td className="num">{usd(b.cost_usd)}</td>
                  <td className="num">{count(b.sessions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart" ref={frame} onPointerLeave={() => setActive(null)}>
          <svg width={width} height={HEIGHT} role="group" aria-label={`Cost per ${span}, in dollars`}>
            {yTicks.map((tick) => (
              <g key={tick}>
                <line className={tick === 0 ? "axis" : "grid"} x1={MARGIN.left} x2={width - MARGIN.right} y1={y(tick)} y2={y(tick)} />
                <text className="tick" x={MARGIN.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
                  {usdCompact(tick).replace(/\.00$/, "")}
                </text>
              </g>
            ))}
            {buckets.map((b, i) => {
              const x = MARGIN.left + i * band;
              const height = plot.height * (b.cost_usd / top);
              return (
                <g key={b.start}>
                  {height > 0 && (
                    <path
                      className={
                        active === i ? "bar active" : picked && !isPicked(b) ? "bar dim" : "bar"
                      }
                      d={column(x + (band - bar) / 2, y(b.cost_usd), bar, height)}
                    />
                  )}
                  {/* The hit target is the whole band, not only the painted bar. */}
                  <rect
                    className="hit"
                    x={x}
                    y={MARGIN.top}
                    width={band}
                    height={plot.height}
                    tabIndex={0}
                    role={b.sessions > 0 ? "button" : "img"}
                    aria-pressed={b.sessions > 0 ? isPicked(b) : undefined}
                    aria-label={`${label(b)}: ${usd(b.cost_usd)}, ${count(b.sessions)} sessions`}
                    style={b.sessions > 0 ? { cursor: "pointer" } : undefined}
                    onClick={() => pick(b)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        pick(b);
                      }
                    }}
                    onPointerEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                  />
                  {i % everyNth === 0 && (
                    <text className="tick" x={x + band / 2} y={HEIGHT - 8} textAnchor="middle">
                      {dayLabel(b.start)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {shown && active != null && (
            <div
              className="tooltip"
              style={{
                left: Math.min(Math.max(MARGIN.left + (active + 0.5) * band, 70), width - 70),
                top: Math.max(0, y(shown.cost_usd) - 8),
              }}
            >
              <strong>{usd(shown.cost_usd)}</strong>
              <span>{label(shown)}</span>
              <span>
                {count(shown.sessions)} {shown.sessions === 1 ? "session" : "sessions"}
              </span>
            </div>
          )}
        </div>
      )}
      {undated.length > 0 && (
        <p className="muted">
          Not shown: {count(undated.reduce((n, d) => n + d.sessions, 0))} sessions without a start time (
          {usd(undated.reduce((n, d) => n + d.cost_usd, 0))}).
        </p>
      )}
    </section>
  );
}
