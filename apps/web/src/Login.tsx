import { useState } from "react";

export function Login({ problem, onToken }: { problem: string | null; onToken: (token: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <main className="center">
      <form
        className="card login"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onToken(value.trim());
        }}
      >
        <h1>Sessionly</h1>
        <label>
          Access token
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            autoFocus
          />
        </label>
        {problem && <p role="alert">{problem}</p>}
        <button type="submit" disabled={!value.trim()}>
          Sign in
        </button>
        <p className="muted">
          Use the token you were given for this server. It is kept in this browser only.
        </p>
      </form>
    </main>
  );
}
