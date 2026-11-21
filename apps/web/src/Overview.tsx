import type { FileList, GroupBy, Summary, Totals } from "@sessionly/schema";
import { Fragment, useId, useState, type ReactNode } from "react";
import { query } from "./api.ts";
import { scopeParams, type Pick, type Scope } from "./App.tsx";
import { CostChart } from "./CostChart.tsx";
import { activeTime, compact, count, dateTime, duration, groupCost, keptAt, keptOf, linesKept, modelName, percent, repoName, rewriteRate, share, toolName, usd, usdCompact } from "./format.ts";
import { Loader } from "./Loader.tsx";
import { useApi } from "./useApi.ts";

interface Props {
  token: string;
  scope: Scope;
  /** Whether to break totals down by person (admins). */
  showUsers: boolean;
  /** Narrow everything but the cost chart to one of its columns, or back to the whole period. */
  onPick: (pick: Pick | null) => void;
  onSignOut: () => void;
}

export function Overview({ token, scope, showUsers, onPick, onSignOut }: Props) {
  const path = (by: GroupBy) => `/summary${query({ by, ...scopeParams(scope) })}`;
  // The chart shows the whole period, so another column can be picked.
  const byDay = useApi<Summary>(token, `/summary${query({ by: "day", ...scopeParams(scope, true) })}`, onSignOut);
  const byUser = useApi<Summary>(token, showUsers ? path("user") : null, onSignOut);
  const byRepo = useApi<Summary>(token, path("repo"), onSignOut);
  const byModel = useApi<Summary>(token, path("model"), onSignOut);
  const byTool = useApi<Summary>(token, path("tool"), onSignOut);

  if (byDay.error) return <p role="alert">{byDay.error}</p>;
  if (!byDay.data) return <Loader />;
  if (byDay.data.total.sessions === 0) {
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
  // With a column picked, the headline is that column's, from a summary of the
  // narrowed scope. Until that summary is in, or if it fails, there is no
  // headline: the whole period's figures under a picked day would be wrong.
  const picked = scope.pick ? byTool : null;
  let headline: ReactNode;
  if (picked?.error) {
    headline = <p role="alert">{picked.error}</p>;
  } else if (picked && (picked.loading || !picked.data)) {
    headline = <Loader />;
  } else {
    const total = picked?.data ? picked.data.total : byDay.data.total;
    headline =
      total.sessions === 0 ? (
        <section className="card">
          <h2>No sessions {scope.pick?.span === "week" ? "in this week" : "on this day"}</h2>
          <p className="muted">
            Nothing in the picked {scope.pick?.span ?? "range"} matches these filters.{" "}
            <button className="quiet" onClick={() => onPick(null)}>
              Show the whole period
            </button>
          </p>
        </section>
      ) : (
        <Headline total={total} />
      );
  }
  return (
    <>
      {headline}
      <CostChart days={byDay.data.groups} picked={scope.pick} onPick={onPick} />
      {/* Worth a table only once there is more than one agent to compare. */}
      {(byTool.data?.groups.length ?? 0) > 1 && (
        <Breakdown title="By tool" heading="Tool" summary={byTool.data} name={toolName} models kept />
      )}
      {showUsers && <Breakdown title="By person" heading="Person" summary={byUser.data} tools />}
      <Breakdown
        title="By repository"
        heading="Repository"
        summary={byRepo.data}
        name={repoName}
        tools
        models
        hint="Open a repository to see the agents that worked in it and the files they changed."
        detail={(g) => <RepoDetail token={token} scope={scope} repo={g.key} tools={g.tools} onSignOut={onSignOut} />}
      />
      <Breakdown title="By model" heading="Model" summary={byModel.data} name={modelName} kept />
    </>
  );
}

/** The figures at the top: the cost on a sheet of its own, the rest beside it. */
function Headline({ total }: { total: Totals }) {
  const estimated = total.sessions_with_estimated_cost;
  const why = useId();
  // Where the cost went, once any of it is in a pull request: before the Action reports one, all of it is in none.
  const inPulls = total.in_pr_usd > 0 || total.closed_unmerged_usd > 0;
  return (
    <section className="headline" aria-label="Totals">
      <div className="hero">
        <div>
          <span className="label">Cost</span>
          <span className="value" title={usd(total.cost_usd)}>{usdCompact(total.cost_usd)}</span>
        </div>
        <dl className="facts">
          <dt>A session</dt>
          <dd>{usd(total.cost_usd / total.sessions)}</dd>
          {total.active_ms > 0 && (
            <>
              <dt>An active hour</dt>
              <dd>{usd(total.cost_usd / (total.active_ms / 3_600_000))}</dd>
            </>
          )}
        </dl>
        {inPulls && (
          <dl className="facts where" aria-label="Where the cost went">
            <dt>Merged or open pull requests</dt>
            <dd>{usd(total.in_pr_usd)}</dd>
            <dt>Closed without merging</dt>
            <dd>{usd(total.closed_unmerged_usd)}</dd>
            <dt>
              {/* Focusable, so that a keyboard or a tap opens what it means too. */}
              <span className="explained" tabIndex={0} aria-describedby={why}>
                <span>Not in a pull request</span>
                <span className="explanation" role="tooltip" id={why}>
                  Sessions whose work hasn't reached a pull request yet: exploration, abandoned branches, or work whose PR isn't open yet.
                </span>
              </span>
            </dt>
            <dd>{usd(total.not_in_pr_usd)}</dd>
          </dl>
        )}
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
          label="Tokens"
          value={compact(total.input_tokens + total.output_tokens)}
          note={`${compact(total.input_tokens)} in, ${compact(total.output_tokens)} out`}
        />
        <Tile
          label="Files changed"
          value={compact(total.files_changed)}
          note={`+${compact(total.lines_added)} −${compact(total.lines_removed)} lines`}
        />
        <Tile
          label="Files rewritten since"
          value={percent(rewriteRate(total.rewrite))}
          part={rewriteRate(total.rewrite)}
          note={`${count(total.rewrite.files_rewritten)} of ${count(total.rewrite.files_measured)} measured`}
        />
        {/* At a fixed age the sessions are compared like for like. Until one has reached it, the latest measurement of each. */}
        {total.kept_7d?.sessions_reached > 0 ? (
          <Tile
            label="Agent lines kept at 7 days"
            value={keptAt(total.kept_7d)}
            part={share(total.kept_7d.lines_surviving, total.kept_7d.lines_added)}
            note={`${keptOf(total.kept_7d)} measured then; ${percent(linesKept(total.rewrite))} as last measured`}
          />
        ) : (
          <Tile
            label="Agent lines still there"
            value={percent(linesKept(total.rewrite))}
            part={linesKept(total.rewrite)}
            note={`of ${compact(total.rewrite.lines_added)} tracked lines, as last measured; none at 7 days yet`}
          />
        )}
      </div>
    </section>
  );
}

export function Tile(props: {
  label: string;
  value: string;
  note?: string;
  /** If the figure is a share of a whole (0 to 1), a bar shows it as well. */
  part?: number | null;
  /** A figure beside the note, with what it means on hover or focus. */
  aside?: { text: string; why: string } | null;
  /** Something more under the note. */
  children?: ReactNode;
}) {
  const { label, value, note, part, aside } = props;
  const why = useId();
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
      {part != null && Number.isFinite(part) && (
        <span className="track" aria-hidden="true">
          <i style={{ width: `${Math.max(0, Math.min(1, part)) * 100}%` }} />
        </span>
      )}
      {note && <span className="note">{note}</span>}
      {aside && (
        <span className="note">
          {/* Focusable, so that a keyboard or a tap opens what it means too. */}
          <span className="explained" tabIndex={0} aria-describedby={why}>
            <span>{aside.text}</span>
            <span className="explanation" role="tooltip" id={why}>
              {aside.why}
            </span>
          </span>
        </span>
      )}
      {props.children}
    </div>
  );
}

/** Names side by side: the agents or models behind a row. */
export function Names({ list }: { list: string[] }) {
  if (list.length === 0) return <>–</>;
  return (
    <span className="chips">
      {list.map((name) => (
        <span className="chip" key={name}>
          {name}
        </span>
      ))}
    </span>
  );
}

const INITIAL_ROWS = 8;

const FILES_SHOWN = 25;

interface RepoProps {
  token: string;
  scope: Scope;
  repo: string;
  /** The agents with sessions in the repository. */
  tools: string[];
  onSignOut: () => void;
}

/** What opens under a repository: its agents side by side, then its files. */
function RepoDetail(props: RepoProps) {
  return (
    <>
      {props.tools.length > 1 && <RepoTools {...props} />}
      <RepoFiles {...props} />
    </>
  );
}

/** The agents that worked in one repository, compared. */
function RepoTools(props: RepoProps) {
  const { user, since, until, tool, model_is } = scopeParams(props.scope);
  const summary = useApi<Summary>(
    props.token,
    `/summary${query({ by: "tool", repo_is: props.repo, user, since, until, tool, model_is })}`,
    props.onSignOut,
  );
  if (summary.error) return <p role="alert">{summary.error}</p>;
  if (!summary.data) return <Loader label="Loading tools" />;
  return (
    <div className="files">
      <table>
        <thead>
          <tr>
            <th scope="col">Tool</th>
            <th scope="col">Models</th>
            <th scope="col" className="num">Sessions</th>
            <th scope="col" className="num">Cost</th>
            <th scope="col" className="num">Active</th>
            <th scope="col" className="num">Prompts</th>
            <th scope="col" className="num">Files changed</th>
            <th scope="col" className="num">Lines</th>
            <th scope="col" className="num">Files rewritten</th>
            <th scope="col" className="num">Lines kept</th>
            <KeptHeads />
          </tr>
        </thead>
        <tbody>
          {summary.data.groups.map((g) => (
            <tr key={g.key}>
              <th scope="row" className="plain">{toolName(g.key)}</th>
              <td><Names list={g.models.map(modelName)} /></td>
              <td className="num">{count(g.sessions)}</td>
              <td className="num">{groupCost(g)}</td>
              <td className="num">{activeTime(g.active_ms)}</td>
              <td className="num">{count(g.prompts)}</td>
              <td className="num">{count(g.files_changed)}</td>
              <td className="num">+{compact(g.lines_added)} −{compact(g.lines_removed)}</td>
              <td className="num">
                {g.rewrite.files_measured > 0
                  ? `${percent(rewriteRate(g.rewrite))} (${count(g.rewrite.files_rewritten)}/${count(g.rewrite.files_measured)})`
                  : "–"}
              </td>
              <td className="num">{percent(linesKept(g.rewrite))}</td>
              <KeptCells group={g} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The files agents changed in one repository, most lines added first. */
function RepoFiles(props: RepoProps) {
  const [all, setAll] = useState(false);
  const { user, since, until, tool, model_is } = scopeParams(props.scope);
  const several = props.tools.length > 1;
  const list = useApi<FileList>(
    props.token,
    `/files${query({ repo_is: props.repo, user, since, until, tool, model_is, limit: all ? 2000 : FILES_SHOWN })}`,
    props.onSignOut,
  );
  if (list.error) return <p role="alert">{list.error}</p>;
  if (!list.data) return <Loader label="Loading files" />;
  if (list.data.total === 0) {
    return <p className="muted">No files were changed through an agent's file tools in these sessions.</p>;
  }
  return (
    <div className="files">
      <table>
        <thead>
          <tr>
            <th scope="col">File</th>
            {several && <th scope="col">Tools</th>}
            <th scope="col" className="num">Sessions</th>
            <th scope="col" className="num">Added</th>
            <th scope="col" className="num">Removed</th>
            <th scope="col" className="num">Agent lines still there</th>
            <th scope="col">Last changed</th>
          </tr>
        </thead>
        <tbody>
          {list.data.files.map((f) => (
            <tr key={f.path}>
              <th scope="row">
                {f.path}
                {f.created ? " (new)" : ""}
              </th>
              {several && <td><Names list={f.tools.map(toolName)} /></td>}
              <td className="num">{count(f.sessions)}</td>
              <td className="num">+{count(f.lines_added)}</td>
              <td className="num">−{count(f.lines_removed)}</td>
              <td className="num">
                {!f.rewrite
                  ? "–"
                  : !f.rewrite.exists
                    ? "file deleted"
                    : `${percent(share(f.rewrite.lines_surviving, f.rewrite.lines_added))} of ${count(f.rewrite.lines_added)}`}
              </td>
              <td className="nowrap">{dateTime(f.last_changed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.data.total > list.data.files.length && (
        <button className="quiet" onClick={() => setAll(true)}>
          Show all {count(list.data.total)} files
        </button>
      )}
    </div>
  );
}

/** The headings of the two columns of what was kept at a fixed age. */
function KeptHeads() {
  const title = (days: number) =>
    `Of the agent's lines, the share still in the files ${days} days after each session ended. ` +
    "Only sessions measured at that age count, and the line below says how many of the sessions with measured lines that is.";
  return (
    <>
      <th scope="col" className="num" title={title(7)}>Kept @7d</th>
      <th scope="col" className="num" title={title(30)}>Kept @30d</th>
    </>
  );
}

/** What a group's sessions kept at 7 and at 30 days, each with how many sessions that is of. */
function KeptCells({ group }: { group: Totals }) {
  return (
    <>
      {[group.kept_7d, group.kept_30d].map((kept, i) => (
        <td className="num" key={i}>
          {keptAt(kept)}
          <span className="under">{keptOf(kept)}</span>
        </td>
      ))}
    </>
  );
}

function Breakdown(props: {
  title: string;
  heading: string;
  summary: Summary | null;
  name?: (key: string) => string;
  /** Show the agents, or the models, behind each row. */
  tools?: boolean;
  models?: boolean;
  /** Show what was kept at 7 and at 30 days: where agents or models are compared. */
  kept?: boolean;
  /** If given, each row can be opened to show this below it. */
  detail?: (group: Totals) => ReactNode;
  hint?: string;
}) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => {
    const next = new Set(open);
    if (!next.delete(key)) next.add(key);
    setOpen(next);
  };
  const { summary } = props;
  if (!summary) return null;
  const rows = all ? summary.groups : summary.groups.slice(0, INITIAL_ROWS);
  const largest = Math.max(...summary.groups.map((g) => g.cost_usd), 0);
  const label = (g: Totals) => (props.name ? props.name(g.key) : g.key);
  const row = (g: Totals) => (
    <Fragment key={g.key}>
    <tr>
      <th scope="row" className="name" title={g.key}>
        {props.detail ? (
          <button className="disclosure" aria-expanded={open.has(g.key)} onClick={() => toggle(g.key)}>
            <span aria-hidden="true">{open.has(g.key) ? "▾" : "▸"}</span> {label(g)}
          </button>
        ) : (
          label(g)
        )}
      </th>
      {props.tools && <td className="names"><Names list={g.tools.map(toolName)} /></td>}
      {props.models && <td className="names"><Names list={g.models.map(modelName)} /></td>}
      <td className="num">{count(g.sessions)}</td>
      <td className="num">
        {/* The bar repeats the number beside it: its length is cost relative to the largest row. */}
        <span className="with-bar">
          <span className="bar-track" aria-hidden="true">
            {g.cost_usd > 0 && (
              <span className="bar-fill" style={{ width: `${largest > 0 ? (g.cost_usd / largest) * 100 : 0}%` }} />
            )}
          </span>
          <span className="amount">{groupCost(g)}</span>
        </span>
      </td>
      <td className="num">{activeTime(g.active_ms)}</td>
      <td className="num">{count(g.prompts)}</td>
      <td className="num">{percent(share(g.tool_failures, g.tool_calls))}</td>
      <td className="num">{count(g.files_changed)}</td>
      <td className="num">
        {g.rewrite.files_measured > 0
          ? `${percent(rewriteRate(g.rewrite))} (${count(g.rewrite.files_rewritten)}/${count(g.rewrite.files_measured)})`
          : "–"}
      </td>
      <td className="num">{percent(linesKept(g.rewrite))}</td>
      {props.kept && <KeptCells group={g} />}
    </tr>
    {props.detail && open.has(g.key) && (
      <tr className="detail">
        <td colSpan={9 + (props.tools ? 1 : 0) + (props.models ? 1 : 0) + (props.kept ? 2 : 0)}>{props.detail(g)}</td>
      </tr>
    )}
    </Fragment>
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
      {props.hint && <p className="muted hint">{props.hint}</p>}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{props.heading}</th>
              {props.tools && <th scope="col">Tools</th>}
              {props.models && <th scope="col">Models</th>}
              <th scope="col" className="num">Sessions</th>
              <th scope="col" className="num">Cost</th>
              <th scope="col" className="num">Active</th>
              <th scope="col" className="num">Prompts</th>
              <th scope="col" className="num">Tool calls failed</th>
              <th scope="col" className="num">Files changed</th>
              <th scope="col" className="num">Files rewritten</th>
              <th scope="col" className="num">Lines kept</th>
              {props.kept && <KeptHeads />}
            </tr>
          </thead>
          <tbody>{rows.map(row)}</tbody>
        </table>
      </div>
    </section>
  );
}
