import type { AuthOptions, SignInProvider } from "@sessionly/schema";
import { useState } from "react";
import { Brand } from "./Brand.tsx";

type Mode = "sign-in" | "token" | "create";

/** The providers as they call themselves. */
export const PROVIDERS: Record<SignInProvider, string> = { google: "Google", github: "GitHub" };

/**
 * Getting in: with Google or GitHub where the server offers that, or with a
 * token. Where anyone may sign up, creating an organisation starts here too:
 * the same way, and the organisation is named on the way back.
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
  const providers = options?.providers ?? [];
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode: Mode = chosen ?? (providers.length ? "sign-in" : "token");
  const [token, setToken] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "token" && token.trim()) onToken(token.trim());
  }

  return (
    <main className="center">
      <Brand />
      <p>A ledger of AI coding agent sessions</p>
      <form className="card login" onSubmit={submit}>
        <h1>{mode === "create" ? "Create an organisation" : mode === "token" ? "Sign in with a token" : "Sign in"}</h1>
        {mode !== "token" &&
          providers.map((provider) => (
            // A link, not a request: the browser itself goes there and comes back.
            <a key={provider} className="button" href={`/api/v1/auth/${provider}${mode === "create" ? "?create" : ""}`}>
              {mode === "create" ? "Continue" : "Sign in"} with {PROVIDERS[provider]}
            </a>
          ))}
        {mode === "token" && (
          <label>
            Access token
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" autoFocus />
          </label>
        )}
        {problem && <p role="alert">{problem}</p>}
        {problem && onRetry && (
          <button type="button" className="quiet" onClick={onRetry}>
            Try again to end them
          </button>
        )}
        {mode === "token" && (
          <button type="submit" disabled={!token.trim()}>
            Sign in
          </button>
        )}
        {mode === "sign-in" && (
          <p className="muted">
            No password is kept here. What is asked of {providers.map((p) => PROVIDERS[p]).join(" or ")} is which
            account this is and which email addresses are its.
          </p>
        )}
        {mode === "create" && (
          <p className="muted">You name the organisation once you are back, and become its owner.</p>
        )}
        {mode === "token" && (
          <p className="muted">Use the token you were given for this server. It is kept in this browser only.</p>
        )}
        <p className="ways">
          {providers.length > 0 && mode !== "sign-in" && (
            <button type="button" className="quiet" onClick={() => setChosen("sign-in")}>
              Sign in
            </button>
          )}
          {options?.signup && mode !== "create" && (
            <button type="button" className="quiet" onClick={() => setChosen("create")}>
              Create an organisation
            </button>
          )}
          {mode !== "token" && (
            <button type="button" className="quiet" onClick={() => setChosen("token")}>
              I have a token
            </button>
          )}
        </p>
      </form>
    </main>
  );
}
