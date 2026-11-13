import type { FilterOptions, Me } from "@sessionly/schema";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, savedToken, saveToken } from "./api.ts";
import { Login } from "./Login.tsx";
import { Overview } from "./Overview.tsx";
import { SessionView } from "./SessionView.tsx";
import { Sessions } from "./Sessions.tsx";
import { Team } from "./Team.tsx";
import { toolName } from "./format.ts";
import { useApi } from "./useApi.ts";

export interface Scope {
  /** "7", "30", "90" days back, or "all". */
  period: string;
  user: string;
  repo: string;
  /** An agent (`claude-code`, `cursor`, `grok`), or "" for all. */
  tool: string;
}

/** The scope as query parameters for the API. */
export function scopeParams(scope: Scope): Record<string, string | undefined> {
  const days = Number(scope.period);
  // Rounded to the hour so the same scope gives the same request.
  const since = Number.isFinite(days)
    ? new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - days * 86_400_000).toISOString()
    : undefined;
  return { since, user: scope.user || undefined, repo: scope.repo || undefined, tool: scope.tool || undefined };
}

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#\/?/, "");
}

export function App() {
  const [token, setToken] = useState<string | null>(savedToken);
  const [me, setMe] = useState<Me | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const signOut = () => {
    saveToken(null);
    setToken(null);
    setMe(null);
  };

  useEffect(() => {
    if (!token) return;
    let current = true;
    api<Me>(token, "/me")
      .then((who) => current && (setMe(who), setProblem(null)))
      .catch((err: Error) => {
        if (!current) return;
        if (err instanceof ApiError && err.status === 401) {
          signOut();
          setProblem("That token is not accepted.");
        } else {
          setProblem(err.message);
        }
      });
    return () => {
      current = false;
    };
  }, [token]);

  if (!token) {
    return (
      <Login
        problem={problem}
        onToken={(value) => {
          saveToken(value);
          setProblem(null);
          setToken(value);
        }}
      />
    );
  }
  if (!me) {
    return (
      <main className="center">
        {problem ? (
          <p role="alert">
            {problem} <button onClick={signOut}>Use another token</button>
          </p>
        ) : (
          <p>Loading…</p>
        )}
      </main>
    );
  }
  return <Shell token={token} me={me} onSignOut={signOut} />;
}

function Shell({ token, me, onSignOut }: { token: string; me: Me; onSignOut: () => void }) {
  const route = useHash();
  const [scope, setScope] = useState<Scope>({ period: "30", user: "", repo: "", tool: "" });
  const options = useApi<FilterOptions>(token, "/filters", onSignOut);
  const [page, ...rest] = route.split("/");
  const isAdmin = me.role === "admin";

  const view = useMemo(() => {
    if (page === "sessions") return <Sessions token={token} scope={scope} onSignOut={onSignOut} />;
    if (page === "session" && rest.length === 3) {
      return <SessionView token={token} address={rest.join("/")} onSignOut={onSignOut} />;
    }
    if (page === "team" && isAdmin) return <Team token={token} onSignOut={onSignOut} />;
    return <Overview token={token} scope={scope} showUsers={isAdmin} onSignOut={onSignOut} />;
  }, [page, rest.join("/"), token, scope, isAdmin]);

  const scoped = page === "" || page === "sessions";
  const link = (target: string, label: string) => (
    <a href={`#/${target}`} aria-current={page === target ? "page" : undefined}>
      {label}
    </a>
  );

  return (
    <>
      <header className="top">
        <strong className="brand">Sessionly</strong>
        <nav aria-label="Main">
          {link("", "Overview")}
          {link("sessions", "Sessions")}
          {isAdmin && link("team", "Team")}
        </nav>
        <span className="who">
          {me.email} · {me.role}
          <button className="quiet" onClick={onSignOut}>
            Sign out
          </button>
        </span>
      </header>
      <main>
        {scoped && (
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
            {isAdmin && (
              <label>
                Person
                <select value={scope.user} onChange={(e) => setScope({ ...scope, user: e.target.value })}>
                  <option value="">Everyone</option>
                  {options.data?.users.map((u) => <option key={u}>{u}</option>)}
                </select>
              </label>
            )}
            <label>
              Repository
              <select value={scope.repo} onChange={(e) => setScope({ ...scope, repo: e.target.value })}>
                <option value="">All repositories</option>
                {options.data?.repos.map((r) => <option key={r}>{r}</option>)}
              </select>
            </label>
            {(options.data?.tools.length ?? 0) > 1 && (
              <label>
                Tool
                <select value={scope.tool} onChange={(e) => setScope({ ...scope, tool: e.target.value })}>
                  <option value="">All tools</option>
                  {options.data?.tools.map((t) => (
                    <option key={t} value={t}>
                      {toolName(t)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </form>
        )}
        {view}
      </main>
    </>
  );
}
