import type { CreatedToken, Role, TokenInfo } from "@sessionly/schema";
import { useState } from "react";
import { api } from "./api.ts";
import { dateTime } from "./format.ts";
import { useApi } from "./useApi.ts";

/** What the Business and Enterprise server says about its license. */
interface LicenseView {
  status: "missing" | "active" | "grace" | "expired";
  readOnlyAt: string | null;
  org: string | null;
  people: number;
  license: {
    id: string;
    edition: string;
    features: string[];
    seats: number;
    expiresAt: string;
  } | null;
}

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "?");

/** License status, and installing one. The core server has no license at all. */
function License({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const found = useApi<LicenseView>(token, "/license", onSignOut);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [installed, setInstalled] = useState<LicenseView | null>(null);

  if (found.errorStatus === 404) {
    return (
      <section className="card">
        <h2>License</h2>
        <p className="muted">
          This is the core server (Apache-2.0). It needs no license. Business and Enterprise features
          run on the ee server.
        </p>
      </section>
    );
  }
  const view = installed ?? found.data;
  if (!view) return found.error ? <p role="alert">{found.error}</p> : null;
  const l = view.license;
  const status =
    view.status === "active"
      ? `Active until ${day(l?.expiresAt)}`
      : view.status === "grace"
        ? `Expired on ${day(l?.expiresAt)}; its features turn read-only on ${day(view.readOnlyAt)}`
        : view.status === "expired"
          ? `Expired on ${day(l?.expiresAt)}; its features have been read-only since ${day(view.readOnlyAt)}`
          : "No license installed: core features only";

  async function install(e: React.FormEvent) {
    e.preventDefault();
    setProblem(null);
    try {
      setInstalled(await api<LicenseView>(token, "/license", { method: "POST", body: { license: text } }));
      setText("");
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  return (
    <section className="card">
      <h2>License</h2>
      <dl className="facts">
        <dt>Status</dt>
        <dd>{status}</dd>
        <dt>Org</dt>
        <dd>{view.org ?? "not set (SESSIONLY_ORG)"}</dd>
        {l && (
          <>
            <dt>Edition</dt>
            <dd>
              {l.edition}, {l.seats} seats ({view.people} people have access now)
            </dd>
            <dt>Features</dt>
            <dd>{l.features.join(", ") || "none"}</dd>
          </>
        )}
      </dl>
      <form className="license-form" onSubmit={install}>
        <label>
          Install a license: paste the contents of the license file
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} spellCheck={false} />
        </label>
        <button type="submit" disabled={!text.trim()}>
          Install license
        </button>
      </form>
      {problem && <p role="alert">{problem}</p>}
    </section>
  );
}

/** People and their access tokens (admins only). */
export function Team({ token, onSignOut }: { token: string; onSignOut: () => void }) {
  const list = useApi<{ tokens: TokenInfo[] }>(token, "/tokens", onSignOut);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setProblem(null);
    try {
      setCreated(await api<CreatedToken>(token, "/tokens", { method: "POST", body: { email, name, role } }));
      setEmail("");
      setName("");
      list.reload();
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  async function revoke(t: TokenInfo) {
    if (!window.confirm(`Revoke the token for ${t.email}? Uploads from it will stop.`)) return;
    try {
      await api(token, `/tokens/${encodeURIComponent(t.id)}`, { method: "DELETE" });
      list.reload();
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  return (
    <>
      <section className="card">
        <h2>Give someone access</h2>
        <p className="muted">
          A token belongs to one person. Members upload their sessions and see their own; admins see
          everyone's. On their machine they run <code>sessionly connect {window.location.origin}</code>{" "}
          and paste the token.
        </p>
        <form className="inline" onSubmit={create}>
          <label>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            Name (optional)
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="ci">CI (reports pull requests, nothing else)</option>
            </select>
          </label>
          <button type="submit">Create token</button>
        </form>
        {problem && <p role="alert">{problem}</p>}
        {created && (
          <div className="created" role="status">
            <p>
              Token for <strong>{created.email}</strong>. Copy it now: it is not shown again.
            </p>
            <code>{created.token}</code>
            <button onClick={() => navigator.clipboard?.writeText(created.token)}>Copy</button>
            <button className="quiet" onClick={() => setCreated(null)}>Done</button>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Tokens</h2>
        {list.error && <p role="alert">{list.error}</p>}
        {list.data && list.data.tokens.length === 0 && (
          <p className="muted">No tokens yet. You are signed in with the server's built-in admin token.</p>
        )}
        {list.data && list.data.tokens.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Role</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col">State</th>
                </tr>
              </thead>
              <tbody>
                {list.data.tokens.map((t) => (
                  <tr key={t.id}>
                    <th scope="row">{t.name ? `${t.name} (${t.email})` : t.email}</th>
                    <td>{t.role}</td>
                    <td className="nowrap">{dateTime(t.created_at)}</td>
                    <td className="nowrap">{t.last_used_at ? dateTime(t.last_used_at) : "never"}</td>
                    <td>
                      {t.revoked_at ? (
                        `revoked ${dateTime(t.revoked_at)}`
                      ) : (
                        <button className="quiet" onClick={() => revoke(t)}>Revoke</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <License token={token} onSignOut={onSignOut} />
    </>
  );
}
