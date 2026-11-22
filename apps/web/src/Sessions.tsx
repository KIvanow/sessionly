import type { SessionList, SessionRow } from "@sessionly/schema";
import { useEffect, useState } from "react";
import { query } from "./api.ts";
import { scopeParams, type Scope } from "./App.tsx";
import { activeTime, cost, count, dateTime, modelName, repoName, toolName } from "./format.ts";
import { Loader } from "./Loader.tsx";
import { useApi } from "./useApi.ts";

const PAGE = 50;

export function sessionHref(s: { machine_id: string; source: string; session_id: string }): string {
  return `#/session/${[s.machine_id, s.source, s.session_id].map(encodeURIComponent).join("/")}`;
}

export function Sessions({ token, scope, onSignOut }: { token: string; scope: Scope; onSignOut: () => void }) {
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  // Search as you type, after a short pause.
  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  useEffect(() => setOffset(0), [q, scope]);

  const list = useApi<SessionList>(
    token,
    `/sessions${query({ ...scopeParams(scope), q, limit: PAGE, offset })}`,
    onSignOut,
  );
  const total = list.data?.total ?? 0;
  // Shown where a session on the page has one.
  const reviews = (list.data?.sessions ?? []).some((s) => (s.review_runs ?? 0) > 0);

  return (
    <section className="card" aria-label="Sessions">
      <div className="card-head">
        <h2>Sessions</h2>
        <label className="search">
          <span className="sr-only">Search</span>
          <input
            type="search"
            placeholder="Search titles, repositories, files…"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
      </div>
      {list.error && <p role="alert">{list.error}</p>}
      {list.data && total === 0 && <p className="muted">No sessions match.</p>}
      {list.data && total > 0 && (
        <>
          <div className="scroll">
            <table className="rows">
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Person</th>
                  <th scope="col">Repository</th>
                  <th scope="col">Session</th>
                  <th scope="col">Tool</th>
                  <th scope="col">Model</th>
                  <th scope="col" className="num">Active</th>
                  <th scope="col" className="num">Cost</th>
                  <th scope="col" className="num">Files</th>
                  <th scope="col" className="num">Lines</th>
                  <th scope="col" className="num">Rewritten</th>
                  {reviews && (
                    <th scope="col" className="num" title="Review runs: /code-review and the like">
                      Reviews
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>{list.data.sessions.map((s) => <Row key={sessionHref(s)} s={s} reviews={reviews} />)}</tbody>
            </table>
          </div>
          <div className="pager">
            <span className="muted">
              {count(offset + 1)}–{count(Math.min(offset + PAGE, total))} of {count(total)}
            </span>
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Newer
            </button>
            <button disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
              Older
            </button>
          </div>
        </>
      )}
      {!list.data && !list.error && <Loader />}
    </section>
  );
}

function Row({ s, reviews }: { s: SessionRow; reviews: boolean }) {
  const name = s.title || s.first_prompt || `${s.session_id.slice(0, 8)}…`;
  return (
    <tr>
      <td className="nowrap">{dateTime(s.started_at)}</td>
      <td>{s.owner_email}</td>
      <td title={s.repo ?? undefined}>{repoName(s.repo)}</td>
      <td className="title">
        <a href={sessionHref(s)}>{name}</a>
      </td>
      <td className="nowrap">
        {toolName(s.source)}
        {s.runtime === "cloud" && ", cloud"}
      </td>
      <td className="nowrap">{s.primary_model ? modelName(s.primary_model) : "–"}</td>
      <td className="num">{activeTime(s.active_ms)}</td>
      <td className="num" title={s.cost_source === "recorded" ? undefined : "An estimate, or includes one"}>
        {cost(s.cost_usd, s.cost_source)}
      </td>
      <td className="num">{count(s.files_changed)}</td>
      <td className="num nowrap">
        +{count(s.lines_added)} −{count(s.lines_removed)}
      </td>
      <td className="num">
        {s.rewrite && s.rewrite.files_measured > 0
          ? `${count(s.rewrite.files_rewritten)}/${count(s.rewrite.files_measured)}`
          : "–"}
      </td>
      {reviews && (
        <td className="num" title={s.review_runs == null ? "Not known: captured by an older Sessionly, which did not count reviews" : undefined}>
          {s.review_runs == null ? "?" : s.review_runs > 0 ? count(s.review_runs) : "–"}
        </td>
      )}
    </tr>
  );
}
