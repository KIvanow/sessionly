import type { LinesBy, PullList, PullMatches, PullOutcomesBy, PullOutcomesSummary, PullRow, PullSummary, ReviewerSummary } from "@sessionly/schema";
import { useEffect, useState } from "react";
import { api, ApiError, query, samePullFilters } from "./api.ts";
import { scopeParams, type Scope } from "./App.tsx";
import { average, count, dateTime, modelName, percent, repoName, share, shareOf, toolName } from "./format.ts";
import { Loader } from "./Loader.tsx";
import { Names, Tile } from "./Overview.tsx";
import { ActionNotice } from "./ActionNotice.tsx";
import { costIsFloor, costText, matchAll, MIN_PULLS, nameSome, outcomeRows, perThousand, pullCost, pullHref, pullsCostNote, reachedOf, revertedShare, roundsTitle, survivingOnce, web } from "./pull.ts";
import { useApi } from "./useApi.ts";

const PAGE = 50;

interface Props {
  token: string;
  scope: Scope;
  setScope: (scope: Scope) => void;
  /** Repositories to offer in the filter. */
  repos: string[];
  /** For a viewer, who can look and change nothing. */
  readOnly?: boolean;
  onSignOut: () => void;
}

const writer = (by: LinesBy) => `${toolName(by.tool)}${by.model ? ` · ${modelName(by.model)}` : ""}`;

/** Pull requests the GitHub Action reported: how much agents wrote, and how it fared in review. */
export function Pulls({ token, scope, setScope, repos, readOnly = false, onSignOut }: Props) {
  const [state, setState] = useState("merged");
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [state, scope]);
  const params = { since: scopeParams(scope, true).since, repo: scope.repo || undefined, state: state || undefined };
  const filters = query(params);
  const summaryPath = `/prs/summary${filters}`;
  const summary = useApi<PullSummary>(token, summaryPath, onSignOut);
  const list = useApi<PullList>(token, `/prs${query({ ...params, limit: PAGE, offset })}`, onSignOut);
  // The summary can arrive before the list. The notice waits until the rows
  // on screen are for these filters too, so it does not name one repository
  // above another's pull requests. Another page of the same list still counts.
  const older =
    summary.dataPath === summaryPath && samePullFilters(list.dataPath, filters)
      ? (summary.data?.older_actions ?? [])
      : [];
  const everything = useApi<PullList>(token, "/prs?limit=1", onSignOut);
  const total = summary.data?.total;
  // Matching the listed pull requests again: how many are done, then what came of it.
  const [matching, setMatching] = useState<number | null>(null);
  const [matched, setMatched] = useState<string | null>(null);
  useEffect(() => setMatched(null), [state, scope]);
  // The filters stay as they are meanwhile: what comes of it is about these.
  const busy = matching !== null;
  async function matchAgain() {
    setMatching(0);
    setMatched(null);
    try {
      const done = await matchAll((body) => api<PullMatches>(token, "/prs/match", { method: "POST", body }), params, setMatching);
      const waiting = done.needs_report
        ? ` ${count(done.needs_report)} ${done.needs_report === 1 ? "was" : "were"} last reported before that could be done, and ${done.needs_report === 1 ? "waits" : "wait"} for the Action to report ${done.needs_report === 1 ? "it" : "them"} once more.`
        : "";
      const not = done.failed ? ` ${count(done.failed)} could not be matched; the server's log says why.` : "";
      setMatched(`Matched ${count(done.matched)} ${done.matched === 1 ? "pull request" : "pull requests"} against the sessions held now.${waiting}${not}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      setMatched((err as Error).message);
    } finally {
      setMatching(null);
      // Also after a failure: the ones before it were matched.
      summary.reload();
      list.reload();
    }
  }

  return (
    <>
      <form className="filters" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
        <label>
          Period
          <select value={scope.period} disabled={busy} onChange={(e) => setScope({ ...scope, period: e.target.value, pick: null })}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="all">All time</option>
          </select>
        </label>
        <label>
          Repository
          <select value={scope.repo} disabled={busy} onChange={(e) => setScope({ ...scope, repo: e.target.value })}>
            <option value="">All repositories</option>
            {repos.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label>
          Pull requests
          <select value={state} disabled={busy} onChange={(e) => setState(e.target.value)}>
            <option value="merged">Merged</option>
            <option value="open">Open</option>
            <option value="closed">Closed without merging</option>
            <option value="">All</option>
          </select>
        </label>
      </form>
      {summary.error && <p role="alert">{summary.error}</p>}
      {!summary.data && !everything.data && !summary.error && <Loader label="Loading pull requests" />}
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
              part={share(total.agent_lines, total.lines)}
              note={`${count(total.agent_lines)} of ${count(total.lines)} added lines`}
            />
            <Tile
              label="Agent lines that survived review"
              value={shareOf(total.agent_lines_surviving, total.opened_agent_lines)}
              part={share(total.agent_lines_surviving, total.opened_agent_lines)}
              note={`${count(total.agent_lines_surviving)} of ${count(total.opened_agent_lines)}, in ${count(total.pulls_from_open)} pull requests reported since they were opened`}
              aside={survivingOnce(total)}
            />
            <Tile
              label="Agent cost"
              value={costText(total.cost_usd, total.cost_estimated, total.pulls_with_cost_missing > 0)}
              note={pullsCostNote(total)}
            />
          </section>
          <ByModel summary={summary.data!} />
          {/* Of merged ones only: the others have no later commits. */}
          {state !== "open" && state !== "closed" && (
            <Outcomes token={token} repo={params.repo} since={params.since} onSignOut={onSignOut} />
          )}
          {/* A server from before this sends none. */}
          <ReviewBots rows={summary.data!.by_reviewer ?? []} pending={summary.data!.reviewers_pending ?? 0} />
        </>
      )}
      {/* Apart from the list: one that could not be read again does not take this with it. */}
      {matched && <p className="muted hint" role="status">{matched}</p>}
      {list.data && list.data.total > 0 && (
        <section className="card" aria-label="Pull requests">
          <div className="card-head">
            <h2>Pull requests</h2>
            {!readOnly && (
              <button
                type="button"
                className="quiet"
                disabled={matching !== null}
                title="Count sessions that were uploaded after a pull request was last reported"
                onClick={matchAgain}
              >
                {matching === null ? "Match these to sessions again" : `Matching… ${count(matching)} done`}
              </button>
            )}
          </div>
          <OlderActions repos={older} />
          <div className="scroll">
            <table className="rows">
              {/* The column groups the grouped headings name: six columns, Review, Cost, Comments. */}
              <colgroup span={6} />
              <colgroup span={3} />
              <colgroup />
              <colgroup span={2} />
              <thead>
                {/* Short headings on one line, grouped: what each is in full is in its title and under the table. */}
                <tr>
                  <th scope="col" rowSpan={2}>Pull request</th>
                  <th scope="col" rowSpan={2}>Author</th>
                  <th scope="col" rowSpan={2}>Created</th>
                  <th scope="col" rowSpan={2} className="num" title="Lines the pull request adds">Lines</th>
                  <th scope="col" rowSpan={2} className="num" title="Of those lines, written by a coding agent">By agents</th>
                  <th scope="col" rowSpan={2}>Written with</th>
                  <th scope="colgroup" colSpan={3} className="group">Review</th>
                  <th scope="col" rowSpan={2} className="num" title="What was spent on it by the sessions that gave it lines">Cost</th>
                  <th scope="colgroup" colSpan={2} className="group">Comments</th>
                </tr>
                <tr>
                  <th scope="col" className="num" title="Agent lines that survived review, of those it was opened with">Kept</th>
                  <th scope="col" className="num" title="Times review feedback was followed by a new commit">Rounds</th>
                  <th scope="col" className="num" title="Review commands (/code-review and the like) run in its sessions">Local</th>
                  <th scope="col" className="num" title="Comments on the diff by people other than the author">People</th>
                  <th scope="col" className="num" title="Comments on the diff by review bots">Bots</th>
                </tr>
              </thead>
              <tbody>{list.data.pulls.map((p) => <Row key={`${p.repo}#${p.number}`} p={p} />)}</tbody>
            </table>
          </div>
          <p className="muted hint">
            Kept: agent lines that survived review, of those the pull request was opened with. Rounds: times
            review feedback was followed by a new commit. Local: review commands (/code-review and the like)
            run in its sessions. Comments are those on the diff, by people other than the author and by review
            bots.
          </p>
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

const OUTCOME_BY: Record<PullOutcomesBy, string> = { tool: "Tool", model: "Model", user: "Person", repo: "Repository", day: "Day merged" };
const AGES = { "1d": "1 day", "7d": "7 days", "30d": "30 days" } as const;

/**
 * What later commits on the base branch did to merged pull requests' agent
 * lines, by tool, model, person or repository, at 1, 7 or 30 days after
 * merging: the merge clock, of pull requests the Action reads them for.
 * Hidden on a server from before this.
 */
function Outcomes({ token, repo, since, onSignOut }: { token: string; repo?: string; since?: string; onSignOut: () => void }) {
  const [by, setBy] = useState<PullOutcomesBy>("tool");
  const [age, setAge] = useState<keyof typeof AGES>("7d");
  const path = `/prs/outcomes/summary${query({ by, repo, since })}`;
  const found = useApi<PullOutcomesSummary>(token, path, onSignOut);
  if (found.errorStatus === 404 || (!found.data && !found.loading && !found.error)) return null;
  // Only what came for this grouping, repository and period: until it comes, the one before is not shown under it.
  const data = found.dataPath === path ? found.data : null;
  const error = found.dataPath === path ? found.error : null;
  // What a server sent, as counts: hidden when it is no answer.
  const rows = data ? outcomeRows(data, age) : null;
  if (data && !rows) return null;
  const total = rows?.total;
  const name = (key: string) => (by === "tool" ? toolName(key) : by === "model" ? modelName(key) : by === "repo" ? repoName(key) : key);
  return (
    <section className="card" aria-label="Later commits">
      <div className="card-head">
        <h2>Later commits: what happened to agent lines after merging</h2>
      </div>
      <p className="muted hint">
        Merge clock: of merged pull requests with agent lines, those whose first {AGES[age]} after merging the Action has
        read on the branch they went into. A pull request counts under each group whose sessions had lines in it, and so
        does a commit that changed them; lines are split by session, so they add up. "Changed by a fix" is linked, not
        caused: mostly the fix was of something else, and a careful team has more of them. Rates are per 1,000 agent lines,
        shown from {MIN_PULLS} pull requests reached; below that a group is too few to compare. The model is a session's main one.
      </p>
      <div className="pick" role="group" aria-label="Group by">
        {(Object.keys(OUTCOME_BY) as PullOutcomesBy[]).map((key) => (
          <button key={key} aria-pressed={by === key} onClick={() => setBy(key)}>{OUTCOME_BY[key]}</button>
        ))}
      </div>
      <div className="pick" role="group" aria-label="After merging">
        {(Object.keys(AGES) as (keyof typeof AGES)[]).map((key) => (
          <button key={key} aria-pressed={age === key} onClick={() => setAge(key)}>{AGES[key]}</button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <Loader label="Loading later commits" />}
      {data && total && total.pulls_total === 0 && (
        <p className="muted">None of these merged pull requests has agent lines whose later commits are read.</p>
      )}
      {data && total && total.pulls_total > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{OUTCOME_BY[by]}</th>
                <th scope="col" className="num" title="Pull requests that reached this age and were read up to it, of all of them">Reached</th>
                <th scope="col" className="num">Agent lines</th>
                <th scope="col" className="num" title="Reverted by then, and not relanded">Reverted</th>
                <th scope="col" className="num" title="Fix commits that changed agent lines, per 1,000 agent lines">Changed by a fix /1k</th>
                <th scope="col" className="num" title="Of those, at least half of what they removed was the agents'">Likely fixes</th>
                <th scope="col" className="num" title="Commits that changed agent lines and say neither, per 1,000 agent lines">Rework /1k</th>
              </tr>
            </thead>
            <tbody>
              {[...rows!.groups, { key: null, at: total }].map(({ key, at }) => (
                <tr key={key ?? "total"} className={key === null ? "total" : undefined}>
                  <th scope="row" className="name">{key === null ? "All" : name(key)}</th>
                  <td className="num">{reachedOf(at)}</td>
                  <td className="num">{count(at.agent_lines)}</td>
                  <td className="num">{revertedShare(at)}</td>
                  <td className="num">{perThousand(at.fix_commits, at)}</td>
                  <td className="num">{at.pulls_reached > 0 ? count(at.likely_fix_commits) : "–"}</td>
                  <td className="num">{perThousand(at.rework_commits, at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
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
          <colgroup span={6} />
          <colgroup span={4} />
          <thead>
            <tr>
              <th scope="col" rowSpan={2}>Tool</th>
              <th scope="col" rowSpan={2}>Model</th>
              <th scope="col" rowSpan={2} className="num">Pull requests</th>
              <th scope="col" rowSpan={2} className="num">Agent lines</th>
              <th scope="col" rowSpan={2} className="num" title="Agent lines that survived review, of those the pull requests were opened with">Survived review</th>
              <th scope="col" rowSpan={2} className="num" title="Reviews that asked for changes">Changes requested</th>
              <th scope="colgroup" colSpan={4} className="group">Per pull request</th>
            </tr>
            <tr>
              <th scope="col" className="num" title="Review rounds per pull request">Rounds</th>
              <th scope="col" className="num" title="Comments on the diff per pull request, by people">Comments</th>
              <th scope="col" className="num" title="Comments on the diff per pull request, by review bots">By bots</th>
              <th scope="col" className="num" title="Review commands run in its sessions per pull request, of those where all of its sessions counted them">Local reviews</th>
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
                  <td className="num">{count(m.changes_requested)}</td>
                  <td className="num">{average(m.review_rounds, m.pulls)}</td>
                  <td className="num">{average(m.review_comments, m.pulls)}</td>
                  <td className="num">{average(m.bot_review_comments, m.pulls)}</td>
                  <td className="num">{average(m.local_reviews, m.local_reviews_pulls)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Review bots over these pull requests: what each commented, and how many
 * rounds followed its feedback; and all people together as one row beside
 * them. Not shown where no bot reviewed; where that is not known of all of
 * them yet (`pending`), it says so in place of the table.
 */
export function ReviewBots({ rows, pending = 0 }: { rows: ReviewerSummary[]; pending?: number }) {
  const pulls = (n: number) => (n === 1 ? "pull request" : "pull requests");
  if (!rows.some((r) => r.author != null)) {
    if (pending === 0) return null;
    return (
      <section className="card" aria-label="Review bots">
        <div className="card-head">
          <h2>Review bots: what each commented, and the rounds that followed</h2>
        </div>
        <p className="muted hint">
          No bot is known to have reviewed these pull requests yet: who reviewed {count(pending)} of them is still
          being worked out. Look again in a few minutes.
        </p>
      </section>
    );
  }
  const unknown = rows.filter((r) => r.pulls_with_rounds_known < r.pulls);
  return (
    <section className="card" aria-label="Review bots">
      <div className="card-head">
        <h2>Review bots: what each commented, and the rounds that followed</h2>
      </div>
      <p className="muted hint">
        Each bot that reviewed these pull requests on GitHub (a review, or a comment on the diff), and all people
        together. Comments on the diff are those that start a thread; replies are left out. A round is review
        feedback followed by a new commit: alone when nobody else gave feedback before it (for people: only
        people did), shared when someone else did too. More comments or rounds do not mean worse code: read them
        beside what survived review.
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Reviewer</th>
              <th scope="col" className="num" title="Pull requests it reviewed">Pull requests</th>
              <th scope="col" className="num" title="Comments on the diff that start a thread">Comments on the diff</th>
              <th scope="col" className="num" title="Comments on the diff per pull request it reviewed">Per pull request</th>
              <th scope="col" className="num" title="Rounds that followed its feedback and no one else's">Rounds alone</th>
              <th scope="col" className="num" title="Rounds that followed its feedback and someone else's">Rounds shared</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const known = r.pulls_with_rounds_known;
              const partly = known < r.pulls ? `Known for ${count(known)} of its ${count(r.pulls)} ${pulls(r.pulls)}` : undefined;
              return (
                <tr key={r.author ?? ""}>
                  <th scope="row" className="name">{r.author ?? "People (all together)"}</th>
                  <td className="num">{count(r.pulls)}</td>
                  <td className="num">{count(r.inline)}</td>
                  <td className="num">{average(r.inline, r.pulls)}</td>
                  <td className="num" title={partly}>{known > 0 ? count(r.rounds_alone) : "–"}</td>
                  <td className="num" title={partly}>{known > 0 ? count(r.rounds_shared) : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pending > 0 && (
        <p className="muted hint">
          Not all of them yet: who reviewed {count(pending)} of these {pulls(pending)} is still being worked out,
          and {pending === 1 ? "it is" : "they are"} not counted here. Look again in a few minutes.
        </p>
      )}
      {unknown.length > 0 && (
        <p className="muted hint">
          Rounds are counted only where it is known whose feedback each followed: for{" "}
          {unknown.map((r) => `${count(r.pulls_with_rounds_known)} of ${count(r.pulls)} ${pulls(r.pulls)} of ${r.author ?? "people"}`).join(", ")}.
          A report from version 0.4.0 of the Action or later says it; one from before does not, and the rounds of a
          pull request last reported by one are known only where there are none.
        </p>
      )}
    </section>
  );
}

/** Repositories in this filter that report with an older Action, and what to change. */
function OlderActions({ repos }: { repos: string[] }) {
  if (repos.length === 0) return null;
  return (
    <p className="muted hint">
      {nameSome(repos.map(repoName))} {repos.length === 1 ? "reports" : "report"} with an older version of the Sessionly Action.{" "}
      <ActionNotice pull="the" rerun />
    </p>
  );
}

function Row({ p }: { p: PullRow }) {
  const a = p.attribution;
  const surviving = a.by.reduce((sum, by) => sum + by.surviving, 0);
  const name = `${repoName(p.repo)} #${p.number}`;
  return (
    <tr>
      <td className="title">
        <a href={pullHref(p)}>{name}</a>
        {p.title && <span className="muted"> {p.title}</span>}
        {p.state !== "merged" && <span className="muted"> ({p.state})</span>}
        {web(p.url) && (
          <>
            {" "}
            <a className="out" href={web(p.url)} target="_blank" rel="noreferrer" aria-label={`${name} on GitHub`} title="On GitHub">
              ↗
            </a>
          </>
        )}
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
      <td className="num" title={roundsTitle(p)}>{count(p.review_rounds)}</td>
      <td
        className="num"
        title={p.local_reviews && p.local_reviews.sessions_unknown > 0 ? "Not all known: some of its sessions were deleted since, captured by an older Sessionly, which did not count reviews, or a Codex session whose own record of them was not there to read" : undefined}
      >
        {p.local_reviews == null ? "–" : `${count(p.local_reviews.runs)}${p.local_reviews.sessions_unknown > 0 ? "+?" : ""}`}
      </td>
      <td
        className="num nowrap"
        title={p.cost && p.cost.usd != null && costIsFloor(p.cost) ? "At least: a session of it has no cost figure, or one that leaves requests out" : undefined}
      >
        {pullCost(p.cost, "≥ ")}
      </td>
      <td className="num">{count(p.review_comments)}</td>
      <td className="num">{count(p.bot_review_comments)}</td>
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
