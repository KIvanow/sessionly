import type { SessionDetail } from "@sessionly/schema";
import { compact, cost, count, dateTime, duration, keptAges, percent, repoName, share, toolName, usd } from "./format.ts";
import { Loader } from "./Loader.tsx";
import { Tile } from "./Overview.tsx";
import { useApi } from "./useApi.ts";

/** One session, as it was uploaded. */
export function SessionView({ token, address, onSignOut }: { token: string; address: string; onSignOut: () => void }) {
  const found = useApi<SessionDetail>(token, `/sessions/${address}`, onSignOut);
  if (found.error) return <p role="alert">{found.error}</p>;
  if (!found.data) return <Loader />;
  const s = found.data.upload.session ?? {};
  const rewrite = found.data.upload.rewrite ?? null;
  // What was there 1, 7 and 30 days after it ended, beside what is there now.
  const ages = keptAges(found.data.upload.checkpoints);
  const measuredAt = ages.filter((age) => age.lines != null);
  const counts = s.counts ?? {};
  const hasText = s.content === "previews";
  // Cursor records the end of only some turns: its absence says nothing.
  const noEnd = s.source === "cursor" ? "–" : "no end recorded";
  // Usage seen only through hooks covers only the turns that ran while they were installed.
  const covered =
    s.cost?.prompts_covered == null
      ? ""
      : `; covers ${count(s.cost.prompts_covered)} of ${count(counts.prompts ?? 0)} prompts, the ones the hooks saw`;

  const tools = new Map<string, { calls: number; notOk: number; ms: number }>();
  for (const call of s.tool_calls ?? []) {
    const row = tools.get(call.tool ?? "?") ?? { calls: 0, notOk: 0, ms: 0 };
    row.calls += 1;
    row.notOk += call.status === "ok" ? 0 : 1;
    row.ms += call.duration_ms ?? 0;
    tools.set(call.tool ?? "?", row);
  }
  const toolRows = [...tools.entries()].sort((a, b) => b[1].calls - a[1].calls);
  const changed = (s.files ?? []).filter((f) => (f.writes ?? 0) > 0);
  const kept = new Map((rewrite?.files ?? []).map((f) => [f.path, f]));

  return (
    <>
      <div className="page-head">
        <p className="eyebrow">
          <a href="#/sessions">← Sessions</a>
        </p>
        <h1>{s.title || (hasText && s.prompts?.find((p) => p.text?.preview)?.text?.preview) || `Session ${s.session_id?.slice(0, 8)}`}</h1>
        <p>
          {found.data.owner_email}, with {toolName(s.source ?? "")}, {dateTime(s.started_at)}
        </p>
      </div>
      <section className="tiles" aria-label="Totals">
        <Tile
          label="Cost"
          value={s.cost ? cost(s.cost.total_usd ?? 0, s.cost.source ?? null) : "–"}
          note={s.cost ? (s.cost.source ?? "").replaceAll("_", " ") : "unknown"}
        />
        <Tile
          label="Active time"
          value={(s.active_ms ?? 0) > 0 ? duration(s.active_ms ?? 0) : "–"}
          note={`${duration(s.duration_ms ?? 0)} from first to last activity`}
        />
        <Tile
          label="Tool calls"
          value={count(counts.tool_calls ?? 0)}
          note={`${count(counts.tool_failures ?? 0)} failed, in ${count(counts.prompts ?? 0)} prompts`}
        />
        {rewrite ? (
          <Tile
            label="Agent lines still there"
            value={percent(share(rewrite.lines_surviving ?? 0, rewrite.lines_added ?? 0))}
            part={share(rewrite.lines_surviving ?? 0, rewrite.lines_added ?? 0)}
            note={`of ${count(rewrite.lines_added ?? 0)} tracked lines`}
          >
            <dl className="ages" aria-label="Still there after the session ended">
              {ages.map((age) => (
                <div key={age.name} title={age.lines == null ? `Not measured ${age.words} after it ended` : age.late ? `Measured on day ${age.late}` : undefined}>
                  <dt>{age.name}</dt>
                  <dd>{age.kept}</dd>
                </div>
              ))}
              <div>
                <dt>now</dt>
                <dd>{percent(share(rewrite.lines_surviving ?? 0, rewrite.lines_added ?? 0))}</dd>
              </div>
            </dl>
          </Tile>
        ) : (
          <Tile
            label="Lines"
            value={`+${compact(counts.lines_added ?? 0)}`}
            note={`−${count(counts.lines_removed ?? 0)}, in ${count(counts.files_changed ?? 0)} ${counts.files_changed === 1 ? "file" : "files"}`}
          />
        )}
      </section>
      <section className="card">
        <h2>The session</h2>
        <dl className="facts">
          <Fact label="Person" value={found.data.owner_email} />
          <Fact label="Tool" value={toolName(s.source ?? "")} />
          {s.runtime && (
            <Fact
              label="Ran in"
              value={`the cloud${s.runtime.id ? ` (${s.runtime.id})` : ""}${s.entrypoint ? `, started from ${s.entrypoint}` : ""}`}
            />
          )}
          <Fact label="Repository" value={`${repoName(s.repo?.remote ?? s.repo?.root ?? s.cwd ?? null)}${s.repo?.branch ? ` (${s.repo.branch})` : ""}`} />
          <Fact label="Started" value={dateTime(s.started_at)} />
          <Fact label="Time" value={`${(s.active_ms ?? 0) > 0 ? `${duration(s.active_ms ?? 0)} active, ` : ""}${duration(s.duration_ms ?? 0)} from first to last activity`} />
          <Fact
            label="Cost"
            value={
              s.cost
                ? `${cost(s.cost.total_usd ?? 0, s.cost.source ?? null)} (${(s.cost.source ?? "").replaceAll("_", " ")}${covered})`
                : s.source === "cursor" && s.runtime
                  ? "unknown: Cursor's cloud agents do not report usage to hooks"
                  : s.source === "cursor"
                    ? "unknown: Cursor reports usage only to hooks, and they saw none of this session"
                    : s.source === "codex"
                      ? "unknown: Codex records tokens, not what they cost"
                      : "unknown"
            }
          />
          <Fact label="Models" value={(s.models ?? []).join(", ") || "–"} />
          <Fact
            label="Activity"
            value={`${count(counts.prompts ?? 0)} prompts, ${count(counts.tool_calls ?? 0)} tool calls (${count(counts.tool_failures ?? 0)} failed), ${count(counts.subagents ?? 0)} subagents`}
          />
          <Fact
            label="Files"
            value={`${count(counts.files_changed ?? 0)} changed (+${count(counts.lines_added ?? 0)} −${count(counts.lines_removed ?? 0)}), ${count(counts.files_read ?? 0)} read`}
          />
          {rewrite && (
            <Fact
              label="Rewritten since"
              value={`${count(rewrite.files_rewritten ?? 0)} of ${count(rewrite.files_measured ?? 0)} changed files; ${percent(share(rewrite.lines_surviving ?? 0, rewrite.lines_added ?? 0))} of the agent's lines still there (measured ${dateTime(rewrite.measured_at)}${rewrite.branch ? ` on ${rewrite.branch}` : ""})`}
            />
          )}
          {measuredAt.length > 0 && (
            <Fact
              label="After it ended"
              value={measuredAt
                .map((age) => `${age.words}: ${age.kept} of ${count(age.lines ?? 0)} lines still there${age.late ? ` (measured on day ${age.late})` : ""}`)
                .join("; ")}
            />
          )}
          <Fact label="Captured" value={`from ${s.captured_by === "transcript" ? "the transcript" : "hooks"}, uploaded as ${s.content}`} />
        </dl>
        {s.cost && (s.cost.unpriced_requests ?? 0) > 0 && (
          <p className="muted">The cost leaves out {count(s.cost.unpriced_requests ?? 0)} requests to models without a known price.</p>
        )}
        {s.cost && s.source === "cursor" && (
          <p className="muted">The cost is the turns' tokens at API list prices, not what Cursor bills.</p>
        )}
        {s.captured_from_start === false && (
          <p className="muted">Capture began partway through: activity covers the captured part, cost covers the whole session.</p>
        )}
      </section>

      {(s.usage ?? []).length > 0 && (
        <section className="card">
          <h2>Tokens by model</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  {/* Cursor reports tokens per turn, not per request. */}
                  <th scope="col" className="num">{s.source === "cursor" ? "Turns" : "Requests"}</th>
                  <th scope="col" className="num">Input</th>
                  <th scope="col" className="num">Output</th>
                  <th scope="col" className="num">Cache read</th>
                  <th scope="col" className="num">Cache written</th>
                  <th scope="col" className="num">Estimated cost</th>
                </tr>
              </thead>
              <tbody>
                {(s.usage ?? []).map((u) => (
                  <tr key={u.model}>
                    <th scope="row">{u.model}</th>
                    <td className="num">{count(u.requests ?? 0)}</td>
                    <td className="num">{compact(u.input_tokens ?? 0)}</td>
                    <td className="num">{compact(u.output_tokens ?? 0)}</td>
                    <td className="num">{compact(u.cache_read_tokens ?? 0)}</td>
                    <td className="num">{compact((u.cache_write_5m_tokens ?? 0) + (u.cache_write_1h_tokens ?? 0))}</td>
                    <td className="num">{u.estimated_cost_usd == null ? "–" : usd(u.estimated_cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(s.prompts ?? []).length > 0 && (
        <section className="card">
          <h2>Prompts</h2>
          {!hasText && <p className="muted">This session was uploaded without text, so prompts show only their length.</p>}
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">{hasText ? "Prompt (first 200 characters)" : "Length"}</th>
                  <th scope="col" className="num">Took</th>
                  <th scope="col">Ended</th>
                </tr>
              </thead>
              <tbody>
                {(s.prompts ?? []).map((p, i) => (
                  <tr key={i}>
                    <td className="nowrap">{dateTime(p.at)}</td>
                    <td className="title">
                      {hasText && p.text?.preview
                        ? p.text.preview
                        : // A cloud agent's opening prompt may never reach a hook.
                          i === 0 && s.captured_from_start === false && !p.text?.chars
                          ? "not captured"
                          : `${count(p.text?.chars ?? 0)} characters`}
                    </td>
                    <td className="num">{p.at && p.ended_at ? duration(Date.parse(p.ended_at) - Date.parse(p.at)) : "–"}</td>
                    <td>{p.outcome === "completed" ? "completed" : p.outcome === "api_error" ? `API error${p.error ? `: ${p.error}` : ""}` : noEnd}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {changed.length > 0 && (
        <section className="card">
          <h2>Files changed</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col" className="num">Added</th>
                  <th scope="col" className="num">Removed</th>
                  <th scope="col" className="num">Agent lines still there</th>
                </tr>
              </thead>
              <tbody>
                {changed.map((f) => {
                  const k = kept.get(f.path ?? "");
                  return (
                    <tr key={f.path}>
                      <th scope="row">{f.path}{f.created ? " (new)" : ""}</th>
                      <td className="num">+{count(f.lines_added ?? 0)}</td>
                      <td className="num">−{count(f.lines_removed ?? 0)}</td>
                      <td className="num">
                        {!k ? "–" : k.exists === false ? "file deleted" : `${percent(share(k.lines_surviving ?? 0, k.lines_added ?? 0))} of ${count(k.lines_added ?? 0)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {toolRows.length > 0 && (
        <section className="card">
          <h2>Tools</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col" className="num">Calls</th>
                  <th scope="col" className="num">Without a successful result</th>
                  <th scope="col" className="num">Total time</th>
                </tr>
              </thead>
              <tbody>
                {toolRows.map(([tool, row]) => (
                  <tr key={tool}>
                    <th scope="row">{tool}</th>
                    <td className="num">{count(row.calls)}</td>
                    <td className="num">{count(row.notOk)}</td>
                    <td className="num">{duration(row.ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(s.subagents ?? []).length > 0 && (
        <section className="card">
          <h2>Subagents</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  {hasText && <th scope="col">Task</th>}
                  <th scope="col" className="num">Tool calls</th>
                  <th scope="col" className="num">Output tokens</th>
                  <th scope="col" className="num">Estimated cost</th>
                </tr>
              </thead>
              <tbody>
                {(s.subagents ?? []).map((a) => (
                  <tr key={a.agent_id}>
                    <th scope="row">{a.agent_type || "–"}</th>
                    {hasText && <td className="title">{a.description ?? ""}</td>}
                    <td className="num">{count(a.tool_calls ?? 0)}</td>
                    <td className="num">{compact(a.output_tokens ?? 0)}</td>
                    <td className="num">{a.estimated_cost_usd == null ? "–" : usd(a.estimated_cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
