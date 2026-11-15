import type { AuthOptions } from "@sessionly/schema";
import { useState } from "react";
import { open } from "./api.ts";

type Mode = "email" | "token" | "signup";

/**
 * Getting in: by a link sent to an email address where the server offers
 * that, or with a token. Where anyone may sign up, creating an organisation
 * starts here too.
 */
export function Login({
  options,
  problem,
  onRetry,
  onToken,
}: {
  options: AuthOptions | null;
  problem: string | null;
  /** Something to try again about `problem`, if there is. */
  onRetry?: () => void;
  onToken: (token: string) => void;
}) {
  const byEmail = options?.emailSignIn === true;
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode: Mode = chosen ?? (byEmail ? "email" : "token");
  const [email, setEmail] = useState("");
  const [orgName, setOrgName] = useState("");
  const [invite, setInvite] = useState("");
  const [token, setToken] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = (next: Mode) => {
    setChosen(next);
    setSent(null);
    setFailed(null);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFailed(null);
    if (mode === "token") {
      if (token.trim()) onToken(token.trim());
      return;
    }
    setBusy(true);
    try {
      if (mode === "email") {
        await open("/auth/email", { email });
        setSent(
          `If ${email.trim()} has an account here, a link to sign in is on its way. If one was sent in the last 15 minutes it still works, and no second one is sent.`,
        );
      } else {
        await open("/auth/signup", { email, org_name: orgName, invite_code: invite || undefined });
        setSent(`A link to finish creating ${orgName.trim()} is on its way to ${email.trim()}.`);
      }
    } catch (err) {
      setFailed((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <main className="center">
        <div className="card login" role="status">
          <h1>Check your inbox</h1>
          <p>{sent}</p>
          <p className="muted">The link works once, for 15 minutes, in this browser or any other.</p>
          <button className="quiet" onClick={() => setSent(null)}>
            Use another address
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="center">
      <form className="card login" onSubmit={submit}>
        <h1>{mode === "signup" ? "Create an organisation" : "Sessionly"}</h1>
        {mode !== "token" && (
          <label>
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              autoFocus
            />
          </label>
        )}
        {mode === "signup" && (
          <>
            <label>
              Organisation
              <input
                required
                minLength={2}
                maxLength={60}
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                autoComplete="organization"
              />
            </label>
            {options?.inviteCode && (
              <label>
                Invitation code
                <input required value={invite} onChange={(e) => setInvite(e.target.value)} autoComplete="off" />
              </label>
            )}
          </>
        )}
        {mode === "token" && (
          <label>
            Access token
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" autoFocus />
          </label>
        )}
        {(failed ?? problem) && <p role="alert">{failed ?? problem}</p>}
        {!failed && problem && onRetry && (
          <button type="button" className="quiet" onClick={onRetry}>
            Try again to end them
          </button>
        )}
        <button type="submit" disabled={busy || (mode === "token" ? !token.trim() : !email.trim())}>
          {mode === "email" ? "Email me a link" : mode === "signup" ? "Create it" : "Sign in"}
        </button>
        {mode === "email" && <p className="muted">No password: a link is sent to your address.</p>}
        {mode === "signup" && (
          <p className="muted">
            Letters, digits, spaces and & ' , ( ) + - in the name. Nothing is created until you use the link sent to
            your address; you then become the organisation's owner.
          </p>
        )}
        {mode === "token" && (
          <p className="muted">Use the token you were given for this server. It is kept in this browser only.</p>
        )}
        <p className="ways">
          {byEmail && mode !== "email" && (
            <button type="button" className="quiet" onClick={() => choose("email")}>
              Sign in by email
            </button>
          )}
          {options?.signup && mode !== "signup" && (
            <button type="button" className="quiet" onClick={() => choose("signup")}>
              Create an organisation
            </button>
          )}
          {mode !== "token" && (
            <button type="button" className="quiet" onClick={() => choose("token")}>
              I have a token
            </button>
          )}
        </p>
      </form>
    </main>
  );
}
