import type { CreatedToken, Role, TokenInfo, UserInfo } from "@sessionly/schema";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, api } from "./api.ts";
import { CopyButton } from "./CopyButton.tsx";
import { dateTime } from "./format.ts";
import { Loader } from "./Loader.tsx";
import { PROVIDERS } from "./Login.tsx";
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
  if (!view) {
    if (found.error) return <p role="alert">{found.error}</p>;
    return (
      <section className="card">
        <h2>License</h2>
        <Loader label="Loading license" />
      </section>
    );
  }
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

/** The people who can sign in. Adding one sends them nothing: they sign in, and are shown the organisation. */
function People({
  token,
  address,
  myEmail,
  onSignOut,
}: {
  token: string;
  /** Where people sign in. */
  address: string;
  /** Who is looking: nobody does for themselves what lets someone in anew. */
  myEmail: string;
  onSignOut: () => void;
}) {
  const list = useApi<{ users: UserInfo[] }>(token, "/users", onSignOut);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [added, setAdded] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setProblem(null);
    setAdded(null);
    try {
      const user = await api<UserInfo>(token, "/users", { method: "POST", body: { email, role } });
      setAdded(user.email);
      setEmail("");
      list.reload();
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  const [removing, setRemoving] = useState<{ user: UserInfo; sessions: number | null } | null>(null);
  const [also, setAlso] = useState(false);
  const [counting, setCounting] = useState(false);
  const removeAsk = useRef<AbortController | null>(null);

  async function askRemove(user: UserInfo) {
    removeAsk.current?.abort();
    const controller = new AbortController();
    removeAsk.current = controller;
    setProblem(null);
    setAlso(false);
    setCounting(true);
    let sessions: number | null = null;
    try {
      const page = await api<{ total: number }>(token, `/sessions?user_is=${encodeURIComponent(user.email)}&limit=1`, {
        signal: controller.signal,
      });
      sessions = page.total;
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof ApiError && err.status === 401) {
        onSignOut();
        return;
      }
    } finally {
      if (removeAsk.current === controller) setCounting(false);
    }
    if (removeAsk.current !== controller) return;
    setRemoving({ user, sessions });
  }

  async function confirmRemove() {
    if (!removing) return;
    const id = removing.user.id;
    const data = also ? "?data=true" : "";
    setRemoving(null);
    try {
      await api(token, `/users/${encodeURIComponent(id)}${data}`, { method: "DELETE" });
      list.reload();
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  async function forget(user: UserInfo) {
    const sure = window.confirm(
      `Let ${user.email} sign in with another account? Do this if the ${user.signed_in_with ? PROVIDERS[user.signed_in_with] : ""} account they signed in with is gone, or was not theirs. ` +
        `Whoever next signs in with a Google or GitHub account that has ${user.email} is asked, and is then that person here. ` +
        "Their sessions end now; uploads from their machines go on.",
    );
    if (!sure) return;
    setProblem(null);
    try {
      await api(token, `/users/${encodeURIComponent(user.id)}/forget-account`, { method: "POST", body: {} });
      list.reload();
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  const people = (list.data?.users ?? []).filter((u) => !u.removed_at);
  return (
    <section className="card">
      <h2>People</h2>
      <p className="muted">
        People sign in with a Google or GitHub account that has the address they were added under, and connect
        their own machines from the Connect page. The account someone first signs in with is from then on the
        only one that gets in as them here. If that account is gone, let them in with another from the list below;
        nobody can do that for themselves.
        Members see their own sessions; admins see everyone's and manage this page.
      </p>
      <form className="inline" onSubmit={add}>
        <label>
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button type="submit">Add</button>
      </form>
      {problem && <p role="alert">{problem}</p>}
      {added && (
        <p role="status">
          {added} can now sign in at {address} with a Google or GitHub account that has this address.
          Nothing is sent to them: let them know.
        </p>
      )}
      {list.error && <p role="alert">{list.error}</p>}
      {!list.data && !list.error && <Loader label="Loading people" />}
      {people.length > 0 && (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Signs in with</th>
                <th scope="col">Added</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {people.map((u) => (
                <tr key={u.id}>
                  <th scope="row">{u.email}</th>
                  <td>{u.role}</td>
                  <td>{u.signed_in_with ? PROVIDERS[u.signed_in_with] : <span className="muted">has not signed in</span>}</td>
                  <td className="nowrap">{dateTime(u.created_at)}</td>
                  <td>
                    {u.signed_in_with && u.email !== myEmail && (
                      <button className="quiet" onClick={() => forget(u)}>
                        Let in with another account
                      </button>
                    )}{" "}
                    {u.role !== "owner" && (
                      <button className="quiet" onClick={() => askRemove(u)} disabled={counting}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {removing && (
        <Confirm title={`Remove ${removing.user.email}?`} onClose={() => setRemoving(null)}>
          <p>
            They can no longer sign in, and uploads from their machines stop. A CI token made under their address keeps
            reporting pull requests. A session a cloud token files under this address is not stored. Revoke either token
            below if it should stop too.
          </p>
          <label className="check">
            <input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} />
            <span>
              Also delete their{" "}
              {removing.sessions === null ? "sessions" : `${removing.sessions} ${removing.sessions === 1 ? "session" : "sessions"}`}{" "}
              and the repositories they stopped
            </span>
          </label>
          <p className="muted">
            Pull requests stay. A session that was removed is shown as “(deleted since)” on a pull request. While they
            stay removed, a session filed under this address is not stored. Adding them again lets a session in.{" "}
            {also
              ? "A repository they had stopped is no longer stopped."
              : "The repositories they stopped stay stopped."}
          </p>
          <div className="ask-actions">
            <button type="button" onClick={confirmRemove}>
              Remove
            </button>
            <button type="button" className="quiet" onClick={() => setRemoving(null)}>
              Cancel
            </button>
          </div>
        </Confirm>
      )}
    </section>
  );
}

/** A small dialog. Escape and Cancel both leave it. */
function Confirm({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="ask"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}

/** Download the organisation, and on a hosted service delete it. The owner only. */
function OrganisationData({
  token,
  orgName,
  hosted,
  onSignOut,
}: {
  token: string;
  orgName: string;
  /** Deleting is not offered on a server of one team. */
  hosted: boolean;
  onSignOut: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  async function removeOrg(e: React.FormEvent) {
    e.preventDefault();
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setProblem(null);
    try {
      await api(token, "/org", { method: "DELETE", body: { name: typed.trim() } });
      onSignOut();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignOut();
      else setProblem((err as Error).message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function download() {
    setProblem(null);
    setBusy(true);
    try {
      const response = await fetch("/api/v1/export", { headers: { authorization: `Bearer ${token}` } });
      if (response.status === 401) {
        onSignOut();
        return;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `The download failed (HTTP ${response.status}).`);
      }
      const blob = await response.blob();
      const named =
        /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "sessionly.jsonl";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = named;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Organisation data</h2>
      <p className="muted">
        One file with the organisation, its people, sessions, pull requests, stopped repositories and tokens. A
        token's secret is not in it.
      </p>
      <div className="ask-actions">
        <button type="button" onClick={download} disabled={busy}>
          {busy ? "Preparing the file…" : "Download everything (JSONL)"}
        </button>
        {hosted && (
          <button type="button" className="quiet" onClick={() => (setTyped(""), setDeleting(true), setProblem(null))}>
            Delete this organisation
          </button>
        )}
      </div>
      {problem && <p role="alert">{problem}</p>}
      {deleting && (
        <Confirm
          title="Delete this organisation?"
          onClose={() => {
            if (!pendingRef.current) setDeleting(false);
          }}
        >
          <p>Everyone is signed out now. Everything is deleted for good in 7 days. Backups rotate out 7 days after that.</p>
          <form onSubmit={removeOrg}>
            <label>
              Type {orgName} to confirm
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </label>
            {problem && <p role="alert">{problem}</p>}
            <div className="ask-actions">
              <button type="submit" disabled={pending || typed.trim() !== orgName}>
                {pending ? "Deleting…" : "Delete this organisation"}
              </button>
              <button
                type="button"
                className="quiet"
                disabled={pending}
                onClick={() => {
                  if (!pendingRef.current) setDeleting(false);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        </Confirm>
      )}
    </section>
  );
}

/** People and access tokens (admins only). */
export function Team({
  token,
  people,
  address,
  myEmail,
  orgName,
  owner,
  hosted,
  onSignOut,
}: {
  token: string;
  /** Whether people sign in here, with Google or GitHub. */
  people: boolean;
  /** Where people sign in. */
  address: string;
  /** The address of whoever is looking. */
  myEmail: string;
  /** The organisation's name, which deleting it asks to be typed. */
  orgName: string;
  /** The person signed in is the owner. The card below is theirs. */
  owner: boolean;
  /** A hosted service: its organisations have no license files to install. */
  hosted: boolean;
  onSignOut: () => void;
}) {
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
      {people && <People token={token} address={address} myEmail={myEmail} onSignOut={onSignOut} />}
      <section className="card">
        <h2>{people ? "Tokens for machines and services" : "Give someone access"}</h2>
        <p className="muted">
          {people
            ? "For what cannot sign in: a cloud environment, CI, or a machine set up for someone. People make the tokens for their own machines on the Connect page."
            : "A token belongs to one person. Members upload their sessions and see their own; admins see everyone's."}{" "}
          A machine is connected with <code>sessionly connect {window.location.origin} --token …</code>
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
              <option value="env">Cloud environment (uploads its sessions, nothing else)</option>
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
            {created.role === "env" && (
              <p>
                Give it to the cloud environment as the secret <code>SESSIONLY_TOKEN</code>, with{" "}
                <code>SESSIONLY_URL</code> set to <code>{location.origin}</code>. Anyone holding it can upload a
                session in anyone's name, so keep it there and nowhere else.
              </p>
            )}
            <CopyButton text={created.token} copiedLabel="Token copied">Copy</CopyButton>
            <button className="quiet" onClick={() => setCreated(null)}>Done</button>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Tokens</h2>
        {list.error && <p role="alert">{list.error}</p>}
        {!list.data && !list.error && <Loader label="Loading tokens" />}
        {list.data && list.data.tokens.length === 0 && (
          <p className="muted">
            No tokens yet.{!people && " You are signed in with the server's built-in admin token."}
          </p>
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
      {owner && <OrganisationData token={token} orgName={orgName} hosted={hosted} onSignOut={onSignOut} />}
      {!hosted && <License token={token} onSignOut={onSignOut} />}
    </>
  );
}
