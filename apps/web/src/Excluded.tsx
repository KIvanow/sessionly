import { parseRepo, repoCovered, type ExcludedRepo, type ExcludedRepos } from "@sessionly/schema";
import { useState } from "react";
import { api } from "./api.ts";
import { useApi } from "./useApi.ts";

/**
 * Stop submitting one repository, or allow one again. Stopping deletes the
 * sessions this person already submitted from it. Other people's stay.
 */
export function Excluded({
  token,
  repo,
  onChange,
  onSignOut,
}: {
  token: string;
  /** The repository chosen in the filter, or "" for all of them. */
  repo: string;
  /** Sessions were deleted or may be submitted again: reload what lists them. */
  onChange: () => void;
  onSignOut: () => void;
}) {
  const list = useApi<ExcludedRepos>(token, "/repos/excluded", onSignOut);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const stopped = list.data?.repos ?? [];
  const covering = repo ? stopped.find((rule) => repoCovered(repo, rule)) : undefined;

  async function stop() {
    if (!repo) return;
    const parsed = parseRepo(repo);
    const covers = parsed.ok && parsed.name.coversFolders;
    const lines = [
      `Stop submitting ${repo}?`,
      "This deletes the sessions you submitted from it, and stops further ones.",
      covers ? "Directories inside it are stopped too, and so is a repository cloned into one." : "",
      "Sessions other people submitted are left as they are.",
      "The copy on each machine that captured them stays there, and is not sent again until you allow this repository.",
    ].filter((line) => line !== "");
    if (!window.confirm(lines.join("\n"))) return;
    setBusy(true);
    setProblem(null);
    try {
      await api<ExcludedRepo>(token, "/repos/excluded", { method: "PUT", body: { repo } });
      list.reload();
      onChange();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function allow(name: string) {
    const sure = window.confirm(
      `Allow ${name} again? The next upload from each machine that still has the sessions will send them. What was deleted stays gone until then.`,
    );
    if (!sure) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(token, `/repos/excluded?repo=${encodeURIComponent(name)}`, { method: "DELETE" });
      list.reload();
      onChange();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const showStop = Boolean(repo && list.data);
  if (!problem && !list.error && !showStop && stopped.length === 0) return null;

  return (
    <section className="submission" aria-label="Submission">
      {problem && <p role="alert">{problem}</p>}
      {list.error && <p role="alert">{list.error}</p>}
      {showStop &&
        (covering ? (
          <p>
            {covering === repo ? (
              <>
                Sessions from <code>{repo}</code> are not submitted.
              </>
            ) : (
              <>
                Sessions from <code>{repo}</code> are not submitted, because <code>{covering}</code> is stopped.
              </>
            )}
          </p>
        ) : (
          <p className="row">
            <button type="button" onClick={stop} disabled={busy}>
              Stop submitting
            </button>
            <span className="muted">
              Deletes the sessions you submitted from <code>{repo}</code> and stops further ones.
            </span>
          </p>
        ))}
      {stopped.length > 0 && (
        <>
          <span className="label">Stopped</span>
          <ul>
            {stopped.map((name) => (
              <li key={name}>
                <code>{name}</code>
                <button type="button" className="quiet" onClick={() => allow(name)} disabled={busy}>
                  Allow again
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
