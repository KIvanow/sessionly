import type { AuthOptions, FilterOptions, Me, SignedIn } from "@sessionly/schema";
import { useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  clearSessions,
  dropSession,
  keepSession,
  open,
  savedSessions,
  savedToken,
  saveToken,
  type Saved,
} from "./api.ts";
import { Connect } from "./Connect.tsx";
import { Login } from "./Login.tsx";
import { Overview } from "./Overview.tsx";
import { Pulls } from "./Pulls.tsx";
import { SessionView } from "./SessionView.tsx";
import { Sessions } from "./Sessions.tsx";
import { Team } from "./Team.tsx";
import { modelName, toolName } from "./format.ts";
import { useApi } from "./useApi.ts";

export interface Scope {
  /** "7", "30", "90" days back, or "all". */
  period: string;
  user: string;
  repo: string;
  /** An agent (`claude-code`, `cursor`, `grok`), or "" for all. */
  tool: string;
  /** A model id, or "" for all. */
  model: string;
  /** Where sessions ran: "local", "cloud", or "" for both. */
  where: string;
}

/** The scope as query parameters for the API. */
export function scopeParams(scope: Scope): Record<string, string | undefined> {
  const days = Number(scope.period);
  // Rounded to the hour so the same scope gives the same request.
  const since = Number.isFinite(days)
    ? new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - days * 86_400_000).toISOString()
    : undefined;
  return {
    since,
    user: scope.user || undefined,
    repo: scope.repo || undefined,
    tool: scope.tool || undefined,
    model_is: scope.model || undefined,
    runtime: scope.where || undefined,
  };
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

/** The code of a link someone signed in or signed up with: `#login=<code>`. */
function linkCode(): string | null {
  return /^#login=([\w-]+)$/.exec(window.location.hash)?.[1] ?? null;
}

/** A link someone arrived by, and what the server says it is for. */
interface Link {
  code: string;
  /** Asked for by the person, sent on being added, or to create an organisation. */
  purpose: "sign_in" | "invite" | "signup";
  email: string;
  org_name: string;
  /** The organisation's id, which unlike its name is its own. None yet when creating one. */
  org_id: string | null;
  /** The person has not signed in to this organisation before. */
  first_time: boolean;
  /** Who added them to it, if they have not signed in to it before. */
  invited_by: string | null;
}

/** Names as people read them: the same if they differ only in case, spacing or the form of a letter. */
const reads = (name: string) => name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * An organisation this browser is signed in to that has the name a link
 * shows and is not the one the link is for. Anyone can make an organisation
 * with any name, so a name alone does not say which one this is.
 */
function sameNameElsewhere(link: Link): Saved | undefined {
  return savedSessions().find((s) => s.org !== link.org_id && reads(s.name) === reads(link.org_name));
}

export function App() {
  const [token, setToken] = useState<string | null>(savedToken);
  const [me, setMe] = useState<Me | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [arriving, setArriving] = useState(() => linkCode() !== null);
  const [link, setLink] = useState<Link | null>(null);
  const [leaving, setLeaving] = useState(false);
  /** Sessions the server could not be told to end, kept (not stored) to try again. */
  const [unended, setUnended] = useState<string[]>([]);

  const use = (value: string | null) => {
    saveToken(value);
    setMe(null);
    setToken(value);
  };
  /** The server no longer accepts this session. If there is one in another organisation, that one is next. */
  const signOut = () => {
    const left = token ? dropSession(token) : savedSessions();
    use(left[0]?.token ?? null);
  };
  /** Tell the server to end these sessions. Returns the ones it could not be told about. */
  const end = async (tokens: string[]): Promise<string[]> => {
    const answers = await Promise.allSettled(tokens.map((each) => api(each, "/auth/session", { method: "DELETE" })));
    return tokens.filter((_, i) => {
      const answer = answers[i];
      // A session the server no longer accepts is ended already.
      return answer?.status === "rejected" && !(answer.reason instanceof ApiError && answer.reason.status === 401);
    });
  };
  const notEnded = (left: string[]) =>
    left.length
      ? `This browser has forgotten its sessions, but the server could not be told to end ${
          left.length === 1 ? "one of them" : `${left.length} of them`
        }. Until it is, a copy of that session would still work, for up to a week.`
      : null;
  /**
   * Sign out on purpose: of every organisation this browser is signed in to,
   * and on the server too. Leaving one and landing in another would be the
   * wrong thing on a computer someone else uses next. The browser forgets
   * the sessions whatever the server answers, and says so if the server did
   * not hear.
   */
  const leave = async () => {
    const all = new Set(savedSessions().map((s) => s.token));
    if (token && me?.signed_in) all.add(token);
    setLeaving(true);
    clearSessions();
    const left = await end([...all]);
    use(null);
    setUnended(left);
    setProblem(notEnded(left));
    setLeaving(false);
  };
  const endAgain = async () => {
    setLeaving(true);
    const left = await end(unended);
    setUnended(left);
    setProblem(notEnded(left));
    setLeaving(false);
  };

  useEffect(() => {
    open<AuthOptions>("/auth/options")
      .then(setOptions)
      // An older server, or none: a token is the way in.
      .catch(() => setOptions({ hosted: false, emailSignIn: false, signup: false, inviteCode: false }));
  }, []);

  // Arriving by a link. It may open a new page or only change the address of
  // this one. The link is not used yet: first the server is asked what it is
  // for, and the person is shown and asked. A link is whatever its sender
  // made it, and must not sign anyone in to a place they did not choose.
  useEffect(() => {
    const arrive = () => {
      const code = linkCode();
      if (!code) return;
      setArriving(true);
      // The code leaves the address bar and the history straight away.
      window.history.replaceState(null, "", window.location.pathname);
      open<Omit<Link, "code">>("/auth/check", { code })
        .then((what) => (setProblem(null), setLink({ code, ...what })))
        .catch((err: Error) => setProblem(err.message))
        .finally(() => setArriving(false));
    };
    arrive();
    window.addEventListener("hashchange", arrive);
    return () => window.removeEventListener("hashchange", arrive);
  }, []);

  /** The person said yes: now the link is used. */
  const follow = (chosen: Link) => {
    setArriving(true);
    setLink(null);
    open<SignedIn>("/auth/verify", { code: chosen.code })
      .then((signed) => {
        keepSession({ org: signed.org.id, name: signed.org.name, token: signed.token });
        setProblem(null);
        use(signed.token);
        window.location.hash = signed.created ? "#/connect" : "#/";
      })
      .catch((err: Error) => setProblem(err.message))
      .finally(() => setArriving(false));
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

  if (arriving || leaving) {
    return (
      <main className="center">
        <p>{leaving ? "Signing out…" : "Opening the link…"}</p>
      </main>
    );
  }
  if (link) {
    const creating = link.purpose === "signup";
    const twin = sameNameElsewhere(link);
    return (
      <main className="center">
        <div className="card login">
          <h1>{creating ? "Create this organisation?" : "Sign in here?"}</h1>
          <dl className="facts">
            <dt>Organisation</dt>
            <dd>{link.org_name}</dd>
            {link.org_id && (
              <>
                <dt>Its id</dt>
                <dd>
                  <code>{link.org_id}</code>
                </dd>
              </>
            )}
            <dt>{creating ? "Its owner" : "As"}</dt>
            <dd>{link.email}</dd>
            {!creating && link.first_time && (
              <>
                <dt>Added by</dt>
                <dd>{link.invited_by ?? "not recorded"}</dd>
              </>
            )}
          </dl>
          {twin && (
            <p role="alert">
              {creating
                ? `This browser is already signed in to an organisation called ${twin.name} (${twin.org}). This creates a second, separate one with the same name.`
                : `This is not the ${twin.name} this browser is signed in to: that one is ${twin.org}. Anyone can give an organisation any name. Go on only if you know who ${
                    link.invited_by ?? "sent this"
                  } is and expected this.`}
            </p>
          )}
          {!creating && link.first_time && !twin && (
            <p className="muted">
              You have not signed in to this organisation before. A name can be anyone's choice: check who added you.
            </p>
          )}
          <p className="muted">
            {creating
              ? "The organisation is created now, with this address as its owner."
              : "Sessions you upload after signing in here belong to this organisation."}{" "}
            If this is not what you expected, or the address is not yours, do not go on.
          </p>
          <button onClick={() => follow(link)}>{creating ? "Create it" : "Sign in"}</button>
          <button className="quiet" onClick={() => setLink(null)}>
            Not now
          </button>
        </div>
      </main>
    );
  }
  if (!token) {
    return (
      <Login
        options={options}
        problem={problem}
        onRetry={unended.length ? endAgain : undefined}
        onToken={(value) => {
          setProblem(null);
          use(value);
        }}
      />
    );
  }
  if (!me) {
    return (
      <main className="center">
        {problem ? (
          <p role="alert">
            {problem} <button onClick={signOut}>Sign in again</button>
          </p>
        ) : (
          <p>Loading…</p>
        )}
      </main>
    );
  }
  return (
    <Shell
      token={token}
      me={me}
      emailSignIn={options?.emailSignIn === true}
      hosted={options?.hosted === true}
      sessions={savedSessions()}
      onSwitch={use}
      onSignOut={signOut}
      onLeave={leave}
    />
  );
}

function Shell({
  token,
  me,
  emailSignIn,
  hosted,
  sessions,
  onSwitch,
  onSignOut,
  onLeave,
}: {
  token: string;
  me: Me;
  /** Whether people can be added to sign in by email. */
  emailSignIn: boolean;
  /** A service many organisations share: no license files there. */
  hosted: boolean;
  /** Sessions in other organisations, to switch to. */
  sessions: Saved[];
  onSwitch: (token: string) => void;
  /** The server no longer accepts the token. */
  onSignOut: () => void;
  /** The person chose to sign out. */
  onLeave: () => void;
}) {
  const route = useHash();
  const [scope, setScope] = useState<Scope>({ period: "30", user: "", repo: "", tool: "", model: "", where: "" });
  const options = useApi<FilterOptions>(token, "/filters", onSignOut);
  const [page, ...rest] = route.split("/");
  const isAdmin = me.role === "admin";

  const view = useMemo(() => {
    if (page === "sessions") return <Sessions token={token} scope={scope} onSignOut={onSignOut} />;
    if (page === "session" && rest.length === 3) {
      return <SessionView token={token} address={rest.join("/")} onSignOut={onSignOut} />;
    }
    if (page === "team" && isAdmin) return <Team token={token} emailSignIn={emailSignIn} hosted={hosted} onSignOut={onSignOut} />;
    if (page === "connect") return <Connect token={token} me={me} onSignOut={onSignOut} />;
    if (page === "pulls" && isAdmin) {
      return (
        <Pulls token={token} scope={scope} setScope={setScope} repos={options.data?.repos ?? []} onSignOut={onSignOut} />
      );
    }
    return <Overview token={token} scope={scope} showUsers={isAdmin} onSignOut={onSignOut} />;
  }, [page, rest.join("/"), token, scope, isAdmin, options.data, emailSignIn, hosted, me]);

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
          {isAdmin && link("pulls", "Pull requests")}
          {isAdmin && link("team", "Team")}
          {link("connect", "Connect")}
        </nav>
        <span className="who">
          {sessions.length > 1 ? (
            <select aria-label="Organisation" value={token} onChange={(e) => onSwitch(e.target.value)}>
              {sessions.map((s) => (
                <option key={s.org} value={s.token}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : (
            me.org !== "default" && me.org_name
          )}
          <span>
            {me.email} · {me.role}
          </span>
          <button className="quiet" onClick={onLeave}>
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
            {(options.data?.runtimes?.length ?? 0) > 1 && (
              <label>
                Ran
                <select value={scope.where} onChange={(e) => setScope({ ...scope, where: e.target.value })}>
                  <option value="">Anywhere</option>
                  <option value="local">On people's machines</option>
                  <option value="cloud">In the cloud</option>
                </select>
              </label>
            )}
            <label>
              Model
              <select value={scope.model} onChange={(e) => setScope({ ...scope, model: e.target.value })}>
                <option value="">All models</option>
                {options.data?.models.map((m) => (
                  <option key={m} value={m}>
                    {modelName(m)}
                  </option>
                ))}
              </select>
            </label>
          </form>
        )}
        {view}
      </main>
    </>
  );
}
