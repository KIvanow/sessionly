import type { GroupBy, Summary, Totals } from "@sessionly/schema";
import { useState } from "react";
import { query } from "./api.ts";
import { scopeParams, type Scope } from "./App.tsx";
import { CostChart } from "./CostChart.tsx";
import { compact, count, duration, linesKept, percent, repoName, rewriteRate, share, usd, usdCompact } from "./format.ts";
import { useApi } from "./useApi.ts";

interface Props {
  token: string;
  scope: Scope;
  /** Whether to break totals down by person (admins). */
  showUsers: boolean;
  onSignOut: () => void;
}

export function Overview({ token, scope, showUsers, onSignOut }: Props) {
  const path = (by: GroupBy) => `/summary${query({ by, ...scopeParams(scope) })}`;
  const byDay = useApi<Summary>(token, path("day"), onSignOut);
  const byUser = useApi<Summary>(token, showUsers ? path("user") : null, onSignOut);
  const byRepo = useApi<Summary>(token, path("repo"), onSignOut);
  const byModel = useApi<Summary>(token, path("model"), onSignOut);

  if (byDay.error) return <p role="alert">{byDay.error}</p>;
  if (!byDay.data) return <p className="muted">Loading…</p>;
  const total = byDay.data.total;
  if (total.sessions === 0) {
    return (
      <section className="card">
        <h2>No sessions in this range</h2>
        <p className="muted">
          Sessions appear here after a developer runs <code>sessionly connect</code> with a token for
          this server. Try a longer period if you expected some.
        </p>
      </section>
    );
  }
  const estimated = total.sessions_with_estimated_cost;
  return (
    <>
      <section className="headline" aria-label="Totals">
        <div className="hero">
          <span className="label">Cost</span>
          <span className="value" title={usd(total.cost_usd)}>{usdCompact(total.cost_usd)}</span>
          <span className="note">
            {estimated > 0 && `${count(estimated)} of ${count(total.sessions)} sessions are estimates. `}
            {total.sessions_without_cost > 0 && `${count(total.sessions_without_cost)} have no cost figure.`}
          </span>
        </div>
        <div className="tiles">
          <Tile label="Sessions" value={compact(total.sessions)} />
          <Tile label="Active time" value={duration(total.active_ms)} note="time the agent spent working" />
          <Tile label="Prompts" value={compact(total.prompts)} />
          <Tile
            label="Tool calls"
            value={compact(total.tool_calls)}
            note={`${percent(share(total.tool_failures, total.tool_calls))} failed`}
          />
          <Tile
            label="Files changed"
            value={compact(total.files_changed)}
            note={`+${compact(total.lines_added)} −${compact(total.lines_removed)} lines`}
          />
          <Tile
            label="Files rewritten since"
            value={percent(rewriteRate(total.rewrite))}
            note={`${count(total.rewrite.files_rewritten)} of ${count(total.rewrite.files_measured)} measured`}
          />
          <Tile
            label="Agent lines still there"
            value={percent(linesKept(total.rewrite))}
            note={`of ${compact(total.rewrite.lines_added)} tracked lines`}
          />
        </div>
      </section>
      <CostChart days={byDay.data.groups} />
      {showUsers && <Breakdown title="By person" heading="Person" summary={byUser.data} />}
      <Breakdown title="By repository" heading="Repository" summary={byRepo.data} name={repoName} />
      <Breakdown title="By model" heading="Model" summary={byModel.data} />
    </>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {note && <span className="note">{note}</span>}
    </div>
  );
}

const INITIAL_ROWS = 8;

function Breakdown(props: {
  title: string;
  heading: string;
  summary: Summary | null;
  name?: (key: string) => string;
}) {
  const [all, setAll] = useState(false);
  const { summary } = props;
  if (!summary) return null;
  const rows = all ? summary.groups : summary.groups.slice(0, INITIAL_ROWS);
  const largest = Math.max(...summary.groups.map((g) => g.cost_usd), 0);
  const row = (g: Totals) => (
    <tr key={g.key}>
      <th scope="row" title={g.key}>{props.name ? props.name(g.key) : g.key}</th>
      <td className="num">{count(g.sessions)}</td>
      <td className="num">
        {/* The bar repeats the number beside it: its length is cost relative to the largest row. */}
        <span className="with-bar">
          <span className="bar-track" aria-hidden="true">
            {g.cost_usd > 0 && (
              <span className="bar-fill" style={{ width: `${largest > 0 ? (g.cost_usd / largest) * 100 : 0}%` }} />
            )}
          </span>
          <span className="amount">{usd(g.cost_usd)}</span>
        </span>
      </td>
      <td className="num">{duration(g.active_ms)}</td>
      <td className="num">{count(g.prompts)}</td>
      <td className="num">{percent(share(g.tool_failures, g.tool_calls))}</td>
      <td className="num">{count(g.files_changed)}</td>
      <td className="num">
        {g.rewrite.files_measured > 0
          ? `${percent(rewriteRate(g.rewrite))} (${count(g.rewrite.files_rewritten)}/${count(g.rewrite.files_measured)})`
          : "–"}
      </td>
      <td className="num">{percent(linesKept(g.rewrite))}</td>
    </tr>
  );
  return (
    <section className="card" aria-label={props.title}>
      <div className="card-head">
        <h2>{props.title}</h2>
        {summary.groups.length > INITIAL_ROWS && (
          <button className="quiet" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${summary.groups.length}`}
          </button>
        )}
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{props.heading}</th>
              <th scope="col" className="num">Sessions</th>
              <th scope="col" className="num">Cost</th>
              <th scope="col" className="num">Active</th>
              <th scope="col" className="num">Prompts</th>
              <th scope="col" className="num">Tool calls failed</th>
              <th scope="col" className="num">Files changed</th>
              <th scope="col" className="num">Files rewritten</th>
              <th scope="col" className="num">Lines kept</th>
            </tr>
          </thead>
          <tbody>{rows.map(row)}</tbody>
        </table>
      </div>
    </section>
  );
}
