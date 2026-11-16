import type { Arrival, AuthOptions, FilterOptions, Me, SignedIn } from "@sessionly/schema";
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
import { arrive, doors, landingOf } from "./arrival.ts";
import { Arrived } from "./Arrived.tsx";
import { Brand } from "./Brand.tsx";
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

export function App() {
  const [token, setToken] = useState<string | null>(savedToken);
  const [me, setMe] = useState<Me | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [options, setOptions] = useState<AuthOptions | null>(null);
  const [arriving, setArriving] = useState(() => landingOf(window.location.hash)?.arrived === true);
  const [back, setBack] = useState<Arrival | null>(null);
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
      // A server from before signing in with Google or GitHub names no providers.
      .then((offered) => setOptions({ ...offered, providers: offered.providers ?? [] }))
      // An older server, or none: a token is the way in.
      .catch(() => setOptions({ hosted: false, providers: [], signup: false, inviteCode: false }));
  }, []);

  /** Signed in: this browser keeps the session, and shows the organisation. */
  const signedIn = (signed: SignedIn) => {
    keepSession({ org: signed.org.id, name: signed.org.name, token: signed.token });
    setProblem(null);
    setBack(null);
    use(signed.token);
    window.location.hash = signed.created ? "#/connect" : "#/";
  };

  // Back from Google or GitHub. The address says only that: the sign-in is
  // in a cookie the server gave this browser, and a link to this page has
  // nothing in it for anyone else. First the server is asked where this
  // person can sign in. Someone in one organisation, which they have signed
  // in to before, goes straight there, unless this browser is signed in
  // somewhere already. Anyone else is shown what there is and asked: being
  // added to an organisation is someone else's doing, and must not sign
  // anyone in to a place they did not choose.
  useEffect(() => {
    const land = () => {
      const landing = landingOf(window.location.hash);
      if (!landing) return;
      window.history.replaceState(null, "", window.location.pathname);
      if (landing.arrived) setArriving(true);
      void arrive(landing)
        .then((outcome) => {
          if (outcome.kind === "entered") signedIn(outcome.signed);
          else if (outcome.kind === "ask") (setProblem(null), setBack(outcome.arrival));
          else if (outcome.kind === "problem") setProblem(outcome.text);
        })
        .finally(() => setArriving(false));
    };
    land();
    window.addEventListener("hashchange", land);
    return () => window.removeEventListener("hashchange", land);
  }, []);

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
        <Brand />
        <p>{leaving ? "Signing out…" : "Signing in…"}</p>
      </main>
    );
  }
  // Not until the server has said what it offers: whether an organisation
  // may be created here decides which page this is.
  if (back && !options) {
    return (
      <main className="center">
        <p>Signing in…</p>
      </main>
    );
  }
  if (back) {
    return (
      <Arrived
        arrival={back}
        options={options}
        enter={(where) => doors.enter(where).then(signedIn)}
        onMore={() =>
          doors.check(back.orgs.filter((org) => org.first_time).length).then((next) =>
            setBack({ ...back, orgs: [...back.orgs, ...next.orgs], more: next.more }),
          )
        }
        onCancel={() => {
          // Over on the server too. If it cannot be told, it runs out by itself in minutes.
          void doors.cancel().catch(() => {});
          setBack(null);
        }}
      />
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
        <Brand />
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
      people={(options?.providers.length ?? 0) > 0}
      address={options?.publicUrl || window.location.origin}
      hosted={options?.hosted === true}
      sessions={savedSessions()}
      onSwitch={use}
      onSignOut={signOut}
      onLeave={leave}
    />
  );
}

/** What each page is, said at its top. A single session names itself. */
const HEADINGS: Record<string, { title: string; about: string }> = {
  "": { title: "Overview", about: "What the agents did, what it cost, and how much of what they wrote is still there." },
  sessions: { title: "Sessions", about: "Every session that was uploaded, newest first." },
  pulls: { title: "Pull requests", about: "How much of each pull request agents wrote, and how those lines fared in review." },
  team: { title: "Team", about: "Who can sign in, and the tokens for what cannot." },
  connect: { title: "Connect", about: "A token for each of your machines, and how to capture sessions elsewhere." },
};

function Shell({
  token,
  me,
  people,
  address,
  hosted,
  sessions,
  onSwitch,
  onSignOut,
  onLeave,
}: {
  token: string;
  me: Me;
  /** Whether people can be added, to sign in with Google or GitHub. */
  people: boolean;
  /** Where people sign in: what someone who was added is told. */
  address: string;
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
    if (page === "team" && isAdmin) {
      return <Team token={token} people={people} address={address} myEmail={me.email} hosted={hosted} onSignOut={onSignOut} />;
    }
    if (page === "connect") return <Connect token={token} me={me} onSignOut={onSignOut} />;
    if (page === "pulls" && isAdmin) {
      return (
        <Pulls token={token} scope={scope} setScope={setScope} repos={options.data?.repos ?? []} onSignOut={onSignOut} />
      );
    }
    return <Overview token={token} scope={scope} showUsers={isAdmin} onSignOut={onSignOut} />;
  }, [page, rest.join("/"), token, scope, isAdmin, options.data, people, address, hosted, me]);

  const scoped = page === "" || page === "sessions";
  const orgName = me.org !== "default" && me.org_name ? me.org_name : null;
  const heading = HEADINGS[page === "team" || page === "pulls" ? (isAdmin ? page : "") : (page ?? "")];
  const link = (target: string, label: string) => (
    <a href={`#/${target}`} aria-current={page === target ? "page" : undefined}>
      {label}
    </a>
  );

  return (
    <>
      <header className="top">
        <div>
          <Brand />
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
              orgName && <span className="org">{orgName}</span>
            )}
            <span>
              {me.email} · {me.role}
            </span>
            <button onClick={onLeave}>Sign out</button>
          </span>
        </div>
      </header>
      <main>
        {heading && (
          <div className="page-head">
            <p className="eyebrow">{orgName ?? "Your team"}</p>
            <h1>{heading.title}</h1>
            <p>{heading.about}</p>
          </div>
        )}
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
