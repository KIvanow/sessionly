import type { CreatedToken, Me, TokenInfo } from "@sessionly/schema";
import { useState } from "react";
import { api } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { dateTime } from "./format.ts";
import { Loader } from "./Loader.tsx";
import { useApi } from "./useApi.ts";

/**
 * Getting sessions in: a token of your own for each machine, and for admins
 * where to go for cloud agents and pull requests.
 */
export function Connect({ token, me, onSignOut }: { token: string; me: Me; onSignOut: () => void }) {
  const list = useApi<{ tokens: TokenInfo[] }>(token, "/me/tokens", onSignOut);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const origin = window.location.origin;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setProblem(null);
    try {
      setCreated(await api<CreatedToken>(token, "/me/tokens", { method: "POST", body: { name } }));
      setName("");
      list.reload();
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  async function revoke(t: TokenInfo) {
    if (!window.confirm(`Revoke ${t.name ?? "this token"}? Uploads from that machine will stop.`)) return;
    try {
      await api(token, `/me/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      list.reload();
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  const active = (list.data?.tokens ?? []).filter((t) => !t.revoked_at);

  return (
    <>
      <section className="card">
        <h2>Connect a machine</h2>
        <p className="muted">
          Each machine gets a token of yours. Sessions it uploads are filed under {me.email}; the token can
          upload them and read only yours. Install the <code>sessionly</code> binary first (
          <a href="https://github.com/KIvanow/sessionly#install">how</a>).
        </p>
        <form className="inline" onSubmit={create}>
          <label>
            Name of the machine (optional)
            <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="laptop" />
          </label>
          <button type="submit">Create a token</button>
        </form>
        {problem && <p role="alert">{problem}</p>}
        {created && (
          <div className="created" role="status">
            <p>Run this on the machine. The token is shown only now.</p>
            <pre className="command">
              {`sessionly install\nsessionly connect ${origin} --token ${created.token}\nsessionly upload`}
            </pre>
            <CopyButton
              text={`sessionly connect ${origin} --token ${created.token}`}
              copiedLabel="Command copied"
            >
              Copy the connect command
            </CopyButton>
            <button className="quiet" onClick={() => setCreated(null)}>
              Done
            </button>
            <p className="muted">
              After that, sessions upload on their own when a turn ends. By default an upload carries counts,
              timings and file paths, and no text from prompts or commands.
            </p>
          </div>
        )}
        {!list.data && !list.error && <Loader label="Loading machines" />}
        {active.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Your machines</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col"></th>
                </tr>
              </thead>
              <tbody>
                {active.map((t) => (
                  <tr key={t.id}>
                    <th scope="row">{t.name ?? "unnamed"}</th>
                    <td className="nowrap">{dateTime(t.created_at)}</td>
                    <td className="nowrap">{t.last_used_at ? dateTime(t.last_used_at) : "never"}</td>
                    <td>
                      <button className="quiet" onClick={() => revoke(t)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {me.role === "admin" && (
        <>
          <section className="card">
            <h2>Cloud agents</h2>
            <p className="muted">
              Claude Code on the web, Cursor's cloud agents and Codex's cloud tasks run in a sandbox, so capture
              is set up in the repository and the server is named in the cloud environment. Of a Codex cloud
              task only the files and lines each turn changed are recorded.
            </p>
            <ol className="steps">
              <li>
                In the repository: <code>sessionly install --repo</code>, then commit the four files it writes.
              </li>
              <li>
                On the <a href="#/team">Team page</a>, create a token with the role "Cloud environment".
              </li>
              <li>
                In the cloud environment's secrets, set <code>SESSIONLY_URL={origin}</code> and{" "}
                <code>SESSIONLY_TOKEN</code> to that token (for Codex, as environment variables). For Claude Code
                and Codex, also add this server's host to the environment's allowed domains.
              </li>
            </ol>
            <p>
              <a href="https://github.com/KIvanow/sessionly#cloud-sessions">The cloud sessions guide</a>
            </p>
          </section>
          <section className="card">
            <h2>Pull requests</h2>
            <p className="muted">
              A GitHub Action reports each pull request here, and the server works out how many of its lines
              agents wrote. It needs a token with the role "CI", from the <a href="#/team">Team page</a>, kept as
              a repository secret, and line hashes switched on where sessions are captured (
              <code>sessionly settings --line-hashes on</code>, or <code>SESSIONLY_LINE_HASHES=on</code> in a
              cloud environment).
            </p>
            <p>
              <a href="https://github.com/KIvanow/sessionly#pull-requests">How to add the Action</a>
            </p>
          </section>
        </>
      )}
    </>
  );
}
