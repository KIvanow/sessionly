import type { LinesBy, PullList, PullRow, PullSummary } from "@sessionly/schema";
import { useEffect, useState } from "react";
import { query } from "./api.ts";
import { scopeParams, type Scope } from "./App.tsx";
import { average, count, dateTime, modelName, percent, repoName, share, shareOf, toolName } from "./format.ts";
import { Names, Tile } from "./Overview.tsx";
import { useApi } from "./useApi.ts";

const PAGE = 50;

interface Props {
  token: string;
  scope: Scope;
  setScope: (scope: Scope) => void;
  /** Repositories to offer in the filter. */
  repos: string[];
  onSignOut: () => void;
}

const writer = (by: LinesBy) => `${toolName(by.tool)}${by.model ? ` · ${modelName(by.model)}` : ""}`;

/** Pull requests the GitHub Action reported: how much agents wrote, and how it fared in review. */
export function Pulls({ token, scope, setScope, repos, onSignOut }: Props) {
  const [state, setState] = useState("merged");
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [state, scope]);
  const params = { since: scopeParams(scope).since, repo: scope.repo || undefined, state: state || undefined };
  const summary = useApi<PullSummary>(token, `/prs/summary${query(params)}`, onSignOut);
  const list = useApi<PullList>(token, `/prs${query({ ...params, limit: PAGE, offset })}`, onSignOut);
  const everything = useApi<PullList>(token, "/prs?limit=1", onSignOut);
  const total = summary.data?.total;

  return (
    <>
      <form className="filters" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
        <label>
          Period
          <select value={scope.period} onChange={(e) => setScope({ ...scope, period: e.target.value })}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="all">All time</option>
          </select>
        </label>
        <label>
          Repository
          <select value={scope.repo} onChange={(e) => setScope({ ...scope, repo: e.target.value })}>
            <option value="">All repositories</option>
            {repos.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label>
          Pull requests
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="merged">Merged</option>
            <option value="open">Open</option>
            <option value="closed">Closed without merging</option>
            <option value="">All</option>
          </select>
        </label>
      </form>
      {summary.error && <p role="alert">{summary.error}</p>}
      {everything.data?.total === 0 && <Setup />}
      {total && total.pulls === 0 && everything.data && everything.data.total > 0 && (
        <section className="card">
          <h2>No pull requests match</h2>
          <p className="muted">Try a longer period, or another kind of pull request.</p>
        </section>
      )}
      {total && total.pulls > 0 && (
        <>
          <section className="tiles" aria-label="Totals">
            <Tile
              label="Pull requests"
              value={count(total.pulls)}
              note={`${count(total.pulls_with_agent_lines)} with lines an agent wrote`}
            />
            <Tile
              label="Lines written by agents"
              value={percent(share(total.agent_lines, total.lines))}
              note={`${count(total.agent_lines)} of ${count(total.lines)} added lines`}
            />
            <Tile
              label="Agent lines that survived review"
              value={shareOf(total.agent_lines_surviving, total.opened_agent_lines)}
              note={`${count(total.agent_lines_surviving)} of ${count(total.opened_agent_lines)}, in ${count(total.pulls_from_open)} pull requests reported since they were opened`}
            />
          </section>
          <ByModel summary={summary.data!} />
        </>
      )}
      {list.data && list.data.total > 0 && (
        <section className="card" aria-label="Pull requests">
          <div className="card-head">
            <h2>Pull requests</h2>
          </div>
          <div className="scroll">
            <table className="rows">
              <thead>
                <tr>
                  <th scope="col">Pull request</th>
                  <th scope="col">Opened by</th>
                  <th scope="col">Created</th>
                  <th scope="col" className="num">Lines added</th>
                  <th scope="col" className="num">By agents</th>
                  <th scope="col">Written with</th>
                  <th scope="col" className="num">Agent lines that survived review</th>
                  <th scope="col" className="num">Review rounds</th>
                  <th scope="col" className="num">Review comments</th>
                </tr>
              </thead>
              <tbody>{list.data.pulls.map((p) => <Row key={`${p.repo}#${p.number}`} p={p} />)}</tbody>
            </table>
          </div>
          {total && total.cloud_pulls_without_session > 0 && (
            <p className="muted hint">
              {count(total.cloud_pulls_without_session)} of these pull requests were worked on by a cloud agent
              whose session was not captured, so its lines count as not an agent's. Running{" "}
              <code>sessionly install --repo</code> in the repository captures them.
            </p>
          )}
          <div className="pager">
            <span className="muted">
              {count(offset + 1)}–{count(Math.min(offset + PAGE, list.data.total))} of {count(list.data.total)}
            </span>
            <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Newer
            </button>
            <button disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>
              Older
            </button>
          </div>
        </section>
      )}
    </>
  );
}

function ByModel({ summary }: { summary: PullSummary }) {
  if (summary.by_model.length === 0) {
    return (
      <section className="card">
        <h2>By model</h2>
        <p className="muted">
          None of these pull requests has lines matched to an agent session. Lines are matched only for
          people who run <code>sessionly settings --line-hashes on</code>.
        </p>
      </section>
    );
  }
  return (
    <section className="card" aria-label="By model">
      <div className="card-head">
        <h2>By model: how agent-written lines fared in review</h2>
      </div>
      <p className="muted hint">
        Lines of these pull requests that an agent wrote. Survived review: of the agent's lines a pull
        request had when it was opened, how many were still in it at the end; only pull requests reported
        from the moment they were opened count. Review rounds and comments are the pull request's: one with
        lines from two models counts under both. Small numbers say little.
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Model</th>
              <th scope="col" className="num">Pull requests</th>
              <th scope="col" className="num">Agent lines</th>
              <th scope="col" className="num">Survived review</th>
              <th scope="col" className="num">Review rounds per pull request</th>
              <th scope="col" className="num">Changes requested</th>
              <th scope="col" className="num">Comments per pull request, by people</th>
              <th scope="col" className="num">by bots</th>
            </tr>
          </thead>
          <tbody>
            {summary.by_model.map((m) => {
              const kept = share(m.surviving, m.opened_lines);
              return (
                <tr key={`${m.tool} ${m.model}`}>
                  <th scope="row" className="name">{toolName(m.tool)}</th>
                  <td className="nowrap">{m.model ? modelName(m.model) : "not known"}</td>
                  <td className="num">{count(m.pulls)}</td>
                  <td className="num">{count(m.lines)}</td>
                  <td className="num">
                    {/* The bar repeats the percentage beside it: a full track is every line. */}
                    <span className="with-bar">
                      <span className="bar-track share" aria-hidden="true">
                        {kept != null && kept > 0 && <span className="bar-fill" style={{ width: `${kept * 100}%` }} />}
                      </span>
                      <span className="amount">
                        {kept == null ? "–" : `${shareOf(m.surviving, m.opened_lines)} of ${count(m.opened_lines)}`}
                      </span>
                    </span>
                  </td>
                  <td className="num">{average(m.review_rounds, m.pulls)}</td>
                  <td className="num">{count(m.changes_requested)}</td>
                  <td className="num">{average(m.review_comments, m.pulls)}</td>
                  <td className="num">{average(m.bot_review_comments, m.pulls)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Row({ p }: { p: PullRow }) {
  const a = p.attribution;
  const surviving = a.by.reduce((sum, by) => sum + by.surviving, 0);
  const name = `${repoName(p.repo)} #${p.number}`;
  return (
    <tr>
      <td className="title">
        {p.url ? <a href={p.url} target="_blank" rel="noreferrer">{name}</a> : name}
        {p.title && <span className="muted"> {p.title}</span>}
        {p.state !== "merged" && <span className="muted"> ({p.state})</span>}
      </td>
      <td className="nowrap">{p.author}</td>
      <td className="nowrap">{dateTime(p.created_at)}</td>
      <td className="num">{count(a.now.lines)}</td>
      <td className="num">
        {a.now.agent_lines > 0 ? `${percent(share(a.now.agent_lines, a.now.lines))} (${count(a.now.agent_lines)})` : "–"}
      </td>
      <td className="names">
        {a.cloud && a.cloud.sessions === 0 ? (
          <>
            {a.now.by.length > 0 && <Names list={a.now.by.map(writer)} />}{" "}
            <span className="muted">
              {a.cloud.agents.map(toolName).join(", ")} in the cloud, session not captured
            </span>
          </>
        ) : (
          <Names list={a.now.by.map(writer)} />
        )}
      </td>
      <td className="num" title={p.first_event === "opened" ? undefined : "Not known: first reported after it was opened"}>
        {p.first_event === "opened" && a.first.agent_lines > 0
          ? `${shareOf(surviving, a.first.agent_lines)} of ${count(a.first.agent_lines)}`
          : "–"}
      </td>
      <td className="num">{count(p.review_rounds)}</td>
      <td className="num" title="By people, then by bots">
        {count(p.review_comments)} + {count(p.bot_review_comments)}
      </td>
    </tr>
  );
}

function Setup() {
  return (
    <section className="card">
      <h2>No pull requests reported yet</h2>
      <p className="muted">
        This page shows how much of each pull request coding agents wrote, with which models, and how many
        of those lines made it through review. To fill it:
      </p>
      <ol className="steps">
        <li>
          Create a token with the role <strong>CI</strong> on the Team page and save it as a secret in the
          repository.
        </li>
        <li>
          Add the Sessionly Action to a workflow that runs on <code>pull_request</code> and{" "}
          <code>pull_request_review</code>, with this server's address and that token.
        </li>
        <li>
          Have the people whose sessions should count run{" "}
          <code>sessionly settings --line-hashes on</code>. It uploads hashes of the lines their agents
          add, not the lines.
        </li>
      </ol>
    </section>
  );
}
