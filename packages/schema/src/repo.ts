// Which repository name stops which sessions. The server, the dashboard and
// the CLI (crates/sessionly/src/upload.rs, which cannot import this) must
// agree, so the rule lives here and the other two follow it.

/** Counted in characters, as the CLI counts them. */
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

/** The names one session goes by: what it is filed under, and where it ran. */
export interface SessionPlace {
  /** What the server files it under: the remote, else the root, else the working directory. */
  repo?: string | null;
  root?: string | null;
  cwd?: string | null;
}

/** A name as rules are written: trimmed, slashes one way, no trailing slash. `/` and nothing are no name. */
function written(text: string): string {
  let name = text.trim().replaceAll("\\", "/");
  while (name.length > 1 && name.endsWith("/")) name = name.slice(0, -1);
  return name === "/" ? "" : name;
}

/** A path, which covers what is inside it. Anything else is a remote. */
function isPath(name: string): boolean {
  return name === "~" || name.startsWith("~/") || name.startsWith("/");
}

/** `input` as a repository name, or a reason it is not one. */
export function parseRepo(input: unknown): { ok: true; name: RepoName } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "name the repository" };
  const repo = written(input);
  if (repo === "") return { ok: false, error: "name the repository" };
  if ([...repo].length > MAX_LENGTH) return { ok: false, error: "that repository name is too long" };
  if (/\p{Cc}/u.test(repo)) return { ok: false, error: "that repository name is not valid" };
  return { ok: true, name: { repo, coversFolders: isPath(repo) } };
}

/**
 * Whether sessions filed under `repo` are stopped by `rule`.
 * `~/Downloads` covers `~/Downloads/notes` and not `~/Downloads-backup`.
 */
export function repoCovered(repo: string, rule: string): boolean {
  const name = repo.replaceAll("\\", "/");
  const stopped = written(rule);
  if (stopped === "") return false;
  return name === stopped || (isPath(stopped) && name.startsWith(`${stopped}/`));
}

/**
 * Whether one session is stopped by `rule`. A path also stops a session that
 * ran inside it and is filed under something else: a clone with a remote, in
 * a stopped folder.
 */
export function sessionCovered(place: SessionPlace, rule: string): boolean {
  const names = isPath(written(rule)) ? [place.repo, place.root, place.cwd] : [place.repo];
  return names.some((name) => typeof name === "string" && repoCovered(name, rule));
}
