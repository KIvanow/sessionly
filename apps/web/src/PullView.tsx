import type { PullAfterMerge, PullDetail, PullHistory, PullHistoryNamedSession, PullSession } from "@sessionly/schema";
import { useState } from "react";
import { api, ApiError, query } from "./api.ts";
import { ActionNotice } from "./ActionNotice.tsx";
import { afterMergeLine, afterMergeName, afterMergeTile, timeline, type By, byOf, countFeedback, feedbackLabel, figureShift, historyEvent, matchedLine, pullCost, pullCostNote, sessionShare, web } from "./pull.ts";
import { cost, count, dateTime, modelName, percent, repoName, share, shareOf, toolName } from "./format.ts";
import { Loader } from "./Loader.tsx";
import { Tile } from "./Overview.tsx";
import { sessionHref } from "./Sessions.tsx";
import { useApi } from "./useApi.ts";

const BY: Record<By, string> = { people: "People", bots: "Bots", author: "The author" };

/** One pull request: what agents wrote of it, in which sessions, and how review went. */
export function PullView({
  token,
  repo,
  number,
  readOnly = false,
  onSignOut,
}: {
  token: string;
  repo: string;
  number: number;
  /** For a viewer, who can look and change nothing. */
  readOnly?: boolean;
  onSignOut: () => void;
}) {
  const [show, setShow] = useState<"all" | By>("all");
  const [matching, setMatching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const found = useApi<PullDetail>(token, `/prs/detail${query({ repo, number })}`, onSignOut);
  async function matchAgain() {
    setMatching(true);
    setProblem(null);
    try {
      await api(token, "/prs/match", { method: "POST", body: { repo, number } });
      found.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      setProblem((err as Error).message);
    } finally {
      setMatching(false);
    }
  }
  if (found.error) return <p role="alert">{found.error}</p>;
  if (!found.data) return <Loader label="Loading the pull request" />;
  const p = found.data;
  const a = p.attribution;
  const surviving = a.by.reduce((sum, by) => sum + by.surviving, 0);
  const fromOpen = p.first_event === "opened" && a.first.agent_lines > 0;
  const github = web(p.url);
  // What became of its agent lines on the branch it was merged into.
  const afterMerge = p.state === "merged" && a.now.agent_lines > 0 ? afterMergeTile(p.after_merge, p.merged_at, shareOf, count) : null;
  const state = p.state === "merged" ? `merged${p.merged_at ? ` ${dateTime(p.merged_at)}` : ""}` : p.state === "closed" ? `closed${p.closed_at ? ` ${dateTime(p.closed_at)}` : ""}` : p.draft ? "open, a draft" : "open";
  // Comments on the diff, per file: where review looked.
  const comments = new Map<string, number>();
  for (const f of p.feedback ?? []) {
    if (f.kind === "inline" && f.path) comments.set(f.path, (comments.get(f.path) ?? 0) + 1);
  }

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">
          <a href="#/pulls">← Pull requests</a>
        </p>
        <h1>{p.title || `Pull request #${p.number}`}</h1>
        <p>
          {github ? <a href={github} target="_blank" rel="noreferrer">{repoName(p.repo)} #{p.number}</a> : `${repoName(p.repo)} #${p.number}`}
          , opened by {p.author} {dateTime(p.created_at)}, {state}
          {p.head_ref && <>, from <code>{p.head_ref}</code>{p.base_ref && <> into <code>{p.base_ref}</code></>}</>}
        </p>
        <p>
          {matchedLine(p)}{" "}
          {p.matchable && !readOnly && (
            <button type="button" className="quiet" disabled={matching} onClick={matchAgain}>
              {matching ? "Matching…" : "Match again"}
            </button>
          )}
        </p>
        {problem && <p role="alert">{problem}</p>}
      </div>
      <ReporterNotice
        reported={p.reporter_version}
        repoReported={p.repo_reporter_version}
        current={p.reporter_current}
        repoOlder={p.repo_reporter_older}
        older={p.reporter_older}
      />
      <section className={`tiles ${afterMerge ? "six" : "five"}`} aria-label="Totals">
        <Tile label="Lines added" value={count(a.now.lines)} note={`in ${count(p.commits)} ${p.commits === 1 ? "commit" : "commits"}`} />
        <Tile
          label="Written by agents"
          value={shareOf(a.now.agent_lines, a.now.lines)}
          part={share(a.now.agent_lines, a.now.lines)}
          note={agentNote(a.now.agent_lines, a.now.lines, figureShift(p.history, dateTime, count))}
        />
        <Tile
          label="Agent lines that survived review"
          value={fromOpen ? shareOf(surviving, a.first.agent_lines) : "–"}
          part={fromOpen ? share(surviving, a.first.agent_lines) : null}
          note={
            fromOpen
              ? `${count(surviving)} of the ${count(a.first.agent_lines)} it had when it was opened`
              : p.first_event === "opened"
                ? "it had no agent lines when it was opened"
                : "not known: first reported after it was opened"
          }
        />
        <Tile
          label="Review comments"
          value={count(p.review_comments + p.bot_review_comments)}
          note={`${count(p.review_comments)} by people, ${count(p.bot_review_comments)} by bots, in ${count(p.review_rounds)} ${p.review_rounds === 1 ? "round" : "rounds"} of review`}
        />
        <Tile label="Agent cost" value={pullCost(p.cost)} note={pullCostNote(p.cost)} />
        {afterMerge && <Tile label="Kept @30d after merge" value={afterMerge.value} part={afterMerge.part} note={afterMerge.note} />}
      </section>

      <History history={p.history} counts={p.after_merge} />

      {a.now.by.length > 0 && (
        <section className="card" aria-label="By model">
          <h2>Written with</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">Model</th>
                  <th scope="col" className="num">Lines now</th>
                  <th scope="col" className="num">Share of the pull request</th>
                </tr>
              </thead>
              <tbody>
                {a.now.by.map((by) => (
                  <tr key={`${by.tool} ${by.model}`}>
                    <th scope="row" className="name">{toolName(by.tool)}</th>
                    <td className="nowrap">{by.model ? modelName(by.model) : "not known"}</td>
                    <td className="num">{count(by.lines)}</td>
                    <td className="num">{shareOf(by.lines, a.now.lines)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card" aria-label="Sessions">
        <h2>Sessions that wrote it</h2>
        {p.cost?.usd != null && (
          <p className="muted hint">
            A session's cost here is its share of what the whole session cost: as many of the lines it
            uploaded hashes of as are in this pull request. A line that is in other pull requests too
            is shared out between them. Their sum is the agent cost above: what the matched sessions
            cost, not what making the pull request did.
          </p>
        )}
        {p.sessions == null ? (
          <Earlier what="Which sessions wrote its lines" dependsOnAction={false} />
        ) : p.sessions.length === 0 ? (
          <p className="muted">
            {a.cloud && a.cloud.sessions === 0
              ? `A cloud agent worked on this pull request (${a.cloud.agents.map(toolName).join(", ")}), and no session of it was captured.`
              : "None of its lines were matched to a session that was uploaded with line hashes."}
          </p>
        ) : (
          <div className="scroll">
            <table className="rows">
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Person</th>
                  <th scope="col">Tool</th>
                  <th scope="col">Model</th>
                  <th scope="col">Started</th>
                  <th scope="col" className="num">Cost in this pull request</th>
                  <th scope="col" className="num">Lines in this pull request</th>
                </tr>
              </thead>
              <tbody>{p.sessions.map((s) => <SessionRow key={`${s.machine_id} ${s.source} ${s.session_id}`} s={s} lines={a.now.lines} />)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" aria-label="Files">
        <h2>Files</h2>
        {p.files == null ? (
          <Earlier what="Its lines file by file" dependsOnAction={false} />
        ) : p.files.length === 0 ? (
          <p className="muted">It adds no lines to track.</p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col" className="num">Lines added</th>
                  <th scope="col" className="num">By agents</th>
                  <th scope="col" className="num">Comments on it</th>
                </tr>
              </thead>
              <tbody>
                {p.files.map((f) => {
                  const part = share(f.agent_lines, f.lines);
                  return (
                    <tr key={f.path}>
                      <th scope="row" className="path">{f.path}</th>
                      <td className="num">{count(f.lines)}</td>
                      <td className="num">
                        <span className="with-bar">
                          <span className="bar-track share" aria-hidden="true">
                            {part != null && part > 0 && <span className="bar-fill" style={{ width: `${part * 100}%` }} />}
                          </span>
                          <span className="amount">{f.agent_lines > 0 ? `${shareOf(f.agent_lines, f.lines)} (${count(f.agent_lines)})` : "–"}</span>
                        </span>
                      </td>
                      <td className="num">{p.feedback == null ? "–" : count(comments.get(f.path) ?? 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {p.files_without_diff > 0 && (
          <p className="muted hint">
            {p.files_without_diff === 1
              ? "1 changed file was too large for GitHub to give a diff for, and is not counted."
              : `${count(p.files_without_diff)} changed files were too large for GitHub to give a diff for, and are not counted.`}
          </p>
        )}
      </section>

      <section className="card" aria-label="Reviews and comments">
        <h2>Reviews and comments</h2>
        <p className="muted hint">
          Who reviewed and commented, when, and on which line, with a link to each on GitHub. What they wrote
          stays on GitHub: Sessionly does not store it.
        </p>
        {p.feedback == null ? (
          <Earlier what="Its reviews and comments" dependsOnAction={p.reporter_older} />
        ) : p.feedback.length === 0 ? (
          <p className="muted">Nobody has reviewed it or commented on it.</p>
        ) : (
          <>
          {(p.feedback_total ?? 0) > p.feedback.length && (
            <p className="muted hint">
              This pull request has {count(p.feedback_total!)} reviews and comments. Only the latest{" "}
              {count(p.feedback.length)} are kept, so the counts here leave out the {count(p.feedback_total! - p.feedback.length)}{" "}
              before them.
            </p>
          )}
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">By</th>
                  <th scope="col">Who</th>
                  <th scope="col" className="num">Reviews</th>
                  <th scope="col" className="num">Asking for changes</th>
                  <th scope="col" className="num">Comments on the diff</th>
                  <th scope="col" className="num">Comments in the conversation</th>
                </tr>
              </thead>
              <tbody>
                {countFeedback(p.feedback, p.author).map((row) => (
                  <tr key={row.by}>
                    <th scope="row" className="name">{BY[row.by]}</th>
                    <td className="who">{row.names.join(", ") || "–"}</td>
                    <td className="num">{count(row.reviews)}</td>
                    <td className="num">{count(row.changes_requested)}</td>
                    <td className="num">{count(row.inline)}</td>
                    <td className="num">{count(row.conversation)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pick" role="group" aria-label="Show">
            {(["all", "people", "bots", "author"] as const).map((by) => {
              const n = by === "all" ? p.feedback!.length : p.feedback!.filter((f) => byOf(f, p.author) === by).length;
              return (
                <button key={by} aria-pressed={show === by} disabled={n === 0} onClick={() => setShow(by)}>
                  {by === "all" ? "All" : BY[by]} <span className="muted">{count(n)}</span>
                </button>
              );
            })}
          </div>
          <div className="scroll">
            <table className="rows">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">On GitHub</th>
                </tr>
              </thead>
              <tbody>
                {p.feedback.filter((f) => show === "all" || byOf(f, p.author) === show).map((f, i) => (
                  <tr key={`${show} ${i}`}>
                    <td className="nowrap">{dateTime(f.at)}</td>
                    <td className="nowrap">
                      {f.author}
                      {f.bot ? <span className="chip">bot</span> : f.author === p.author && <span className="chip">author</span>}
                    </td>
                    <td className="title">{feedbackLabel(f)}</td>
                    <td className="nowrap">
                      {web(f.url) && <a href={web(f.url)} target="_blank" rel="noreferrer" aria-label={`${feedbackLabel(f)}, by ${f.author}, on GitHub`}>View</a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </section>
    </>
  );
}

/** The agent tile's note: the count, and, when that count moved, what it was until this report. */
function agentNote(agentLines: number, lines: number, shift: string | null): string {
  const now = `${count(agentLines)} of ${count(lines)} lines`;
  return shift ? `${now}. ${shift}` : now;
}

function History({ history, counts }: { history: PullHistory[]; counts: PullAfterMerge[] | undefined }) {
  const rows = timeline(history, counts);
  return (
    <section className="card" aria-label="History">
      <h2>History</h2>
      <p className="muted hint">
        Each time the figures moved, and when a newer Action reported them as they were. Once merged, its agent lines are
        counted again on the branch it was merged into, 7 and 30 days after.
      </p>
      {rows.length === 0 ? (
        <p className="muted">No earlier figures were kept.</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">What</th>
                <th scope="col" className="num">Figures</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ at, report, count: counted }, i) =>
                counted ? (
                  <tr key={`${at} ${i}`}>
                    <td className="nowrap">{dateTime(at)}</td>
                    <td className="nowrap">{afterMergeName(counted)}</td>
                    <td className="num nowrap">{count(counted.surviving)} of {count(counted.agent_lines)}</td>
                    <td>{afterMergeLine(counted, count)}</td>
                  </tr>
                ) : (
                  <tr key={`${at} ${i}`}>
                    <td className="nowrap">{dateTime(at)}</td>
                    <td className="nowrap">{historyEvent(report.event)}</td>
                    <td className="num nowrap">{count(report.agent_lines)} of {count(report.lines)}</td>
                    <td>
                      {report.change.reason ?? "–"}
                      <HistorySessions change={report.change} />
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Sessions a change names, each a link to the session, as the sessions table links them. */
function HistorySessions({ change }: { change: PullHistory["change"] }) {
  const named: { key: string; s: PullHistoryNamedSession; note: string }[] = [
    ...change.sessions_added.map((s) => ({ key: `added ${sessionKey(s)}`, s, note: "uploaded" })),
    ...change.sessions_gone.map((s) => ({ key: `gone ${sessionKey(s)}`, s, note: "no longer matched" })),
    ...change.sessions_changed.map((s) => ({
      key: `changed ${sessionKey(s)}`,
      s,
      note: `was ${count(s.lines_before)}`,
    })),
  ];
  if (named.length === 0) return null;
  return (
    <>
      {" · "}
      {named.map((item, i) => (
        <span key={item.key}>
          {i > 0 && ", "}
          <HistorySession s={item.s} /> ({item.note})
        </span>
      ))}
    </>
  );
}

function sessionKey(s: { machine_id: string; source: string; session_id: string }): string {
  return `${s.machine_id} ${s.source} ${s.session_id}`;
}

function HistorySession({ s }: { s: PullHistoryNamedSession }) {
  const name = s.session?.title || `Session ${s.session_id.slice(0, 8)}`;
  const label = `${name}, ${count(s.lines)} ${s.lines === 1 ? "line" : "lines"}`;
  if (!s.session) return <span className="muted">{label} (deleted since)</span>;
  return <a href={sessionHref(s)}>{label}</a>;
}

function SessionRow({ s, lines }: { s: PullSession; lines: number }) {
  const known = s.session;
  const name = known?.title || `Session ${s.session_id.slice(0, 8)}`;
  const its = sessionShare(s);
  return (
    <tr>
      <td className="title">
        {known ? <a href={sessionHref(s)}>{name}</a> : <span className="muted">{name} (deleted since)</span>}
        {known?.runtime === "cloud" && <span className="muted"> (cloud)</span>}
      </td>
      <td className="nowrap">{known?.owner_email ?? "–"}</td>
      <td className="nowrap">{toolName(s.source)}</td>
      <td className="nowrap">{known?.primary_model ? modelName(known.primary_model) : "–"}</td>
      <td className="nowrap">{dateTime(known?.started_at)}</td>
      <td className="num" title={its.why ?? undefined}>
        {its.text != null ? (
          <>
            {its.text} <span className="muted">of {cost(known?.cost_usd ?? null, known?.cost_source ?? null)}</span>
          </>
        ) : s.uncounted ? (
          <span className="muted">not known yet</span>
        ) : (
          "–"
        )}
      </td>
      <td className="num">
        {count(s.lines)} <span className="muted">({percent(share(s.lines, lines))})</span>
      </td>
    </tr>
  );
}

/** What this pull request's report is missing, and why a fresh run is needed when the Action was old. */
function ReporterNotice({
  reported,
  repoReported,
  current,
  repoOlder,
  older,
}: {
  reported: string | null;
  /** The version the repository's most recent judged report named. */
  repoReported: string | null;
  current: string;
  repoOlder: boolean;
  older: boolean;
}) {
  if (!repoOlder && !older) return null;
  const phrase = (version: string | null) => (version ? `${version}; current is ${current}` : `current is ${current}`);
  if (repoOlder) {
    return (
      <p className="muted">
        This repository reports with an older version of the Sessionly Action ({phrase(repoReported)}).{" "}
        <ActionNotice pull="this" rerun={older} />
      </p>
    );
  }
  return (
    <p className="muted">
      This pull request was last reported by an older version of the Sessionly Action ({phrase(reported)}).{" "}
      <ActionNotice pull="this" rerun move={false} />
    </p>
  );
}

/** For a pull request last reported before this was kept. */
function Earlier({ what, dependsOnAction }: { what: string; dependsOnAction: boolean }) {
  if (dependsOnAction) {
    return (
      <p className="muted">
        {what} were not kept when this pull request was last reported. The notice above says why.
      </p>
    );
  }
  return (
    <p className="muted">
      {what} were not kept when this pull request was last reported. They appear with its next report from
      the current version of the Action: push to it, or run the Action's workflow for it by hand.
    </p>
  );
}
