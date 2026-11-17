// Which repository name stops which sessions. The server, the dashboard and
// the CLI (crates/sessionly/src/upload.rs, which cannot import this) must
// agree, so the rule lives here and the other two follow it.

const MAX_LENGTH = 1024;

export interface RepoName {
  /** As stored: no trailing slash, backslashes written as slashes. */
  repo: string;
  /**
   * A path (`~`, `~/…` or `/…`) also stops directories inside it.
   * A remote such as `github.com/owner/name` is only itself.
   */
  coversFolders: boolean;
}

/** `input` as a repository name, or a reason it is not one. */
export function parseRepo(input: unknown): { ok: true; name: RepoName } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "name the repository" };
  let repo = input.trim().replaceAll("\\", "/");
  while (repo.length > 1 && repo.endsWith("/")) repo = repo.slice(0, -1);
  if (repo === "" || repo === "/") return { ok: false, error: "name the repository" };
  if (repo.length > MAX_LENGTH) return { ok: false, error: "that repository name is too long" };
  if (/[\u0000-\u001f\u007f]/.test(repo)) return { ok: false, error: "that repository name is not valid" };
  const coversFolders = repo === "~" || repo.startsWith("~/") || repo.startsWith("/");
  return { ok: true, name: { repo, coversFolders } };
}

/**
 * Whether sessions filed under `repo` are stopped by `rule`.
 * `~/Downloads` covers `~/Downloads/notes` and not `~/Downloads-backup`.
 */
export function repoCovered(repo: string, rule: string): boolean {
  const left = repo.replaceAll("\\", "/");
  let right = rule.trim().replaceAll("\\", "/");
  while (right.length > 1 && right.endsWith("/")) right = right.slice(0, -1);
  if (right === "" || right === "/") return false;
  if (left === right) return true;
  const path = right === "~" || right.startsWith("~/") || right.startsWith("/");
  return path && left.startsWith(`${right}/`);
}
