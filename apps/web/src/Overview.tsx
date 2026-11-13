import type { FileList, GroupBy, Summary, Totals } from "@sessionly/schema";
import { Fragment, useState, type ReactNode } from "react";
import { query } from "./api.ts";
import { scopeParams, type Scope } from "./App.tsx";
import { CostChart } from "./CostChart.tsx";
import { activeTime, compact, count, dateTime, duration, groupCost, linesKept, modelName, percent, repoName, rewriteRate, share, toolName, usd, usdCompact } from "./format.ts";
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
  const byTool = useApi<Summary>(token, path("tool"), onSignOut);

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
      {/* Worth a table only once there is more than one agent to compare. */}
      {(byTool.data?.groups.length ?? 0) > 1 && (
        <Breakdown title="By tool" heading="Tool" summary={byTool.data} name={toolName} models />
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
      <Breakdown title="By model" heading="Model" summary={byModel.data} name={modelName} />
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

/** Names side by side: the agents or models behind a row. */
function Names({ list }: { list: string[] }) {
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
  const { user, since, tool } = scopeParams(props.scope);
  const summary = useApi<Summary>(
    props.token,
    `/summary${query({ by: "tool", repo_is: props.repo, user, since, tool })}`,
    props.onSignOut,
  );
  if (summary.error) return <p role="alert">{summary.error}</p>;
  if (!summary.data) return <p className="muted">Loading tools…</p>;
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
  const { user, since, tool } = scopeParams(props.scope);
  const several = props.tools.length > 1;
  const list = useApi<FileList>(
    props.token,
    `/files${query({ repo_is: props.repo, user, since, tool, limit: all ? 2000 : FILES_SHOWN })}`,
    props.onSignOut,
  );
  if (list.error) return <p role="alert">{list.error}</p>;
  if (!list.data) return <p className="muted">Loading files…</p>;
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

function Breakdown(props: {
  title: string;
  heading: string;
  summary: Summary | null;
  name?: (key: string) => string;
  /** Show the agents, or the models, behind each row. */
  tools?: boolean;
  models?: boolean;
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
    </tr>
    {props.detail && open.has(g.key) && (
      <tr className="detail">
        <td colSpan={9 + (props.tools ? 1 : 0) + (props.models ? 1 : 0)}>{props.detail(g)}</td>
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
            </tr>
          </thead>
          <tbody>{rows.map(row)}</tbody>
        </table>
      </div>
    </section>
  );
}
