// Reading a base branch's history with git, in the runner, as the sessionly
// binary reads a repository's: in three steps that nothing in a commit can
// be mistaken in. `rev-list` for the SHAs and times, `cat-file --batch` for
// the messages (each with its size), `diff-tree --stdin` for the changes.
import { lineHash } from "./lines.mjs";

/** How long one git command may take, and how much it may print. */
const GIT_DEADLINE = 120_000;
const GIT_MOST = 256 * 1024 * 1024;
/** How many times a reading follows lines to where a commit moved them. */
const MOST_PASSES = 3;
/** A commit that adds and removes more lines than this is not read whole, and not counted: a vendored, generated or moved tree. */
export const MOST_LINES_SHOWN = 100_000;
/** Commits read whole at a time. */
const SHOWN_AT_ONCE = 250;

const PATCH = ["-p", "-U0", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

/** A full commit SHA as git prints one. */
export const isSha = (text) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text);

/**
 * Git in `cwd`, for reading history: paths as they are, whatever the
 * environment says of pathspecs or of which repository; no prompt, no
 * signature checked. `spawn` is `spawnSync`. Returns what it printed, as a
 * Buffer; throws when it fails (with its exit code as `git`), prints too
 * much or takes too long.
 */
export function gitIn(cwd, spawn) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return (args, input) => {
    const done = spawn("git", ["-c", "core.quotepath=off", "-c", "log.showSignature=false", "--literal-pathspecs", ...args], {
      cwd,
      input,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: GIT_MOST,
      timeout: GIT_DEADLINE,
    });
    if (done.error) throw new Error(`git ${args[0]} could not be run: ${done.error.message}`);
    if (done.status !== 0) {
      throw Object.assign(new Error(`git ${args[0]} failed: ${String(done.stderr ?? "").trim().slice(0, 300)}`), { git: done.status });
    }
    return done.stdout;
  };
}

/** `rev-list --timestamp`: each commit's SHA and time, in the order given, once each. */
export function parseList(out) {
  const seen = new Set();
  const listed = [];
  for (const line of out.toString("utf8").split("\n")) {
    const [at, sha] = line.split(" ");
    if (!sha || !isSha(sha) || seen.has(sha) || !/^\d+$/.test(at)) continue;
    seen.add(sha);
    listed.push({ sha, at: Number(at) });
  }
  return listed;
}

/**
 * `cat-file --batch`: each commit's message, by SHA. An object comes with
 * its size, so nothing in a message can be taken for the next one. A
 * message whose commit says it is Latin-1 is read as that.
 */
export function parseBatch(out) {
  const messages = new Map();
  let at = 0;
  while (at < out.length) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) break;
    const [sha, kind, size] = out.subarray(at, end).toString("utf8").split(" ");
    at = end + 1;
    // `<sha> missing`: no object follows.
    if (size === undefined) continue;
    const n = Number(size);
    if (!Number.isSafeInteger(n) || at + n > out.length) break;
    const object = out.subarray(at, at + n);
    at += n + 1;
    if (kind !== "commit" || !isSha(sha)) continue;
    const split = object.indexOf("\n\n");
    const headers = split < 0 ? object : object.subarray(0, split);
    const body = split < 0 ? Buffer.alloc(0) : object.subarray(split + 2);
    const latin1 = headers
      .toString("latin1")
      .split("\n")
      .some((line) => /^encoding (?:iso-?8859-1|latin-?1|l1)\s*$/i.test(line));
    messages.set(sha, body.toString(latin1 ? "latin1" : "utf8").trim());
  }
  return messages;
}

/** `diff-tree --stdin --always` output, cut at each commit's SHA line, in the order the SHAs were given. */
export function splitTree(text, shas) {
  const parts = new Map();
  let next = 0;
  let open = null;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    if (next < shas.length && line.replace(/\n$/, "") === shas[next]) {
      if (open) parts.set(shas[open.i], text.slice(open.start, offset));
      open = { i: next, start: offset + line.length };
      next += 1;
    }
    offset += line.length;
  }
  if (open) parts.set(shas[open.i], text.slice(open.start));
  return parts;
}

/** Undo git's C quoting of a path: `\\`, `\"`, `\t`, … and octal bytes (`\303\251`). */
export function unquote(text) {
  const raw = Buffer.from(text, "utf8");
  const bytes = [];
  const escapes = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== 0x5c) {
      bytes.push(raw[i]);
      continue;
    }
    i += 1;
    if (i >= raw.length) {
      bytes.push(0x5c);
      break;
    }
    const c = String.fromCharCode(raw[i]);
    if (c in escapes) bytes.push(escapes[c]);
    else if (c >= "0" && c <= "7") {
      let value = raw[i] - 0x30;
      for (let k = 0; k < 2 && raw[i + 1] >= 0x30 && raw[i + 1] <= 0x37; k += 1) {
        i += 1;
        value = value * 8 + (raw[i] - 0x30);
      }
      bytes.push(value & 0xff);
    } else bytes.push(raw[i]);
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A path in a patch header, without its `a/` or `b/`; null for /dev/null. Git ends one with a space in it with a tab. */
function headerPath(rest, prefix) {
  const text = rest.endsWith("\t") ? rest.slice(0, -1) : rest;
  if (text === "/dev/null") return null;
  const path = text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? unquote(text.slice(1, -1)) : text;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * A diff's files with their removed and added lines, as hash counts. The
 * file headers (`---`/`+++`) come before a file's first hunk; after it, a
 * line `---x` is a removed `--x`.
 */
export function parseDiff(diff) {
  const files = new Map();
  let current = null;
  let header = false;
  let old = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      current = null;
      old = null;
      continue;
    }
    if (header) {
      if (line.startsWith("--- ")) old = headerPath(line.slice(4), "a/");
      else if (line.startsWith("+++ ")) current = headerPath(line.slice(4), "b/") ?? old;
      else if (line.startsWith("@@")) header = false;
      continue;
    }
    if (current === null || (line[0] !== "+" && line[0] !== "-")) continue;
    const hash = lineHash(line.slice(1));
    if (!hash) continue;
    const file = files.get(current) ?? { added: new Map(), removed: new Map() };
    const bag = line[0] === "+" ? file.added : file.removed;
    bag.set(hash, (bag.get(hash) ?? 0) + 1);
    files.set(current, file);
  }
  return files;
}

/**
 * A whole commit's files, less the lines it moved: each line removed and
 * added again, in that file or another, is taken out of both. With the
 * tracked lines it removed, less those, and each line moved to another
 * file: `[from, to, hash, copies]`.
 */
export function unmoved(files) {
  const added = new Map();
  const removed = new Map();
  for (const diff of files.values()) {
    for (const [hash, n] of diff.added) added.set(hash, (added.get(hash) ?? 0) + n);
    for (const [hash, n] of diff.removed) removed.set(hash, (removed.get(hash) ?? 0) + n);
  }
  const moved = new Map();
  for (const [hash, n] of removed) {
    const m = Math.min(n, added.get(hash) ?? 0);
    if (m > 0) moved.set(hash, m);
  }
  const paths = [...files.keys()].sort();
  const moves = [];
  for (const hash of [...moved.keys()].sort()) {
    const side = (bag) => paths.filter((p) => files.get(p)[bag].has(hash)).map((p) => [p, files.get(p)[bag].get(hash)]);
    const from = side("removed");
    const to = side("added");
    let [f, t, left] = [0, 0, moved.get(hash)];
    while (left > 0 && f < from.length && t < to.length) {
      const taken = Math.min(left, from[f][1], to[t][1]);
      if (from[f][0] !== to[t][0]) moves.push([from[f][0], to[t][0], hash, taken]);
      from[f][1] -= taken;
      to[t][1] -= taken;
      left -= taken;
      if (from[f][1] === 0) f += 1;
      if (to[t][1] === 0) t += 1;
    }
  }
  const left = { removed: new Map(moved), added: new Map(moved) };
  for (const path of paths) {
    const diff = files.get(path);
    for (const side of ["removed", "added"]) {
      for (const [hash, n] of [...diff[side]]) {
        const m = left[side].get(hash);
        if (!m) continue;
        const taken = Math.min(n, m);
        left[side].set(hash, m - taken);
        if (n - taken > 0) diff[side].set(hash, n - taken);
        else diff[side].delete(hash);
      }
    }
  }
  let total = 0;
  for (const diff of files.values()) for (const n of diff.removed.values()) total += n;
  return { files, removedTotal: total, moves };
}

/**
 * The commits on `tip` between `since` and `until` (seconds since 1970, by
 * committer date) that changed `paths`, parents first, with their messages
 * and changes there. One that removes any line there is read whole: a line
 * it adds back elsewhere was moved, not changed, and is taken out; one too
 * large for that is not counted (its removed lines are cleared). Lines
 * moved out of a path read go with the reading to their new path, which is
 * read too (up to `MOST_PASSES` readings).
 */
export function readHistory(git, tip, since, until, paths) {
  const tracked = new Set(paths);
  let commits = [];
  for (let pass = 1; pass <= MOST_PASSES; pass += 1) {
    commits = readOnce(git, tip, since, until, [...tracked].sort());
    let more = false;
    for (const commit of commits) {
      for (const [from, to] of commit.moves) {
        if (tracked.has(from) && !tracked.has(to)) {
          tracked.add(to);
          more = true;
        }
      }
    }
    if (!more) break;
  }
  return { commits, paths: [...tracked].sort() };
}

function readOnce(git, tip, since, until, paths) {
  if (paths.length === 0) return [];
  const listed = parseList(
    git(["rev-list", "--no-merges", "--full-history", "--topo-order", "--reverse", "--timestamp", `--max-age=${since}`, `--min-age=${until}`, tip, "--", ...paths]),
  );
  if (listed.length === 0) return [];
  const shas = listed.map((c) => c.sha);
  const input = shas.map((sha) => `${sha}\n`).join("");
  const messages = parseBatch(git(["cat-file", "--batch"], input));
  const diffs = splitTree(git(["diff-tree", "--stdin", "--always", "--root", ...PATCH, "--", ...paths], input).toString("utf8"), shas);
  const commits = listed.map(({ sha, at }) => ({
    sha,
    at,
    message: messages.get(sha) ?? "",
    files: parseDiff(diffs.get(sha) ?? ""),
    removedTotal: null,
    moves: [],
  }));
  const candidates = commits.filter((c) => [...c.files.values()].some((d) => d.removed.size > 0));
  if (candidates.length === 0) return commits;
  const asked = candidates.map((c) => c.sha);
  const numstat = git(["diff-tree", "--stdin", "--always", "--root", "--numstat", "--no-renames"], asked.map((s) => `${s}\n`).join(""));
  const sizes = splitTree(numstat.toString("utf8"), asked);
  const small = asked.filter((sha) => {
    const counts = (sizes.get(sha) ?? "").split("\n").flatMap((line) => line.split("\t").slice(0, 2)).filter((n) => /^\d+$/.test(n));
    return counts.reduce((sum, n) => sum + Number(n), 0) <= MOST_LINES_SHOWN;
  });
  const whole = new Map();
  for (let from = 0; from < small.length; from += SHOWN_AT_ONCE) {
    const some = small.slice(from, from + SHOWN_AT_ONCE);
    const out = git(["diff-tree", "--stdin", "--always", "--root", ...PATCH], some.map((s) => `${s}\n`).join("")).toString("utf8");
    for (const [sha, diff] of splitTree(out, some)) whole.set(sha, parseDiff(diff));
  }
  for (const commit of candidates) {
    const files = whole.get(commit.sha);
    if (!files) {
      // Too big to read whole: not counted.
      for (const diff of commit.files.values()) diff.removed.clear();
      continue;
    }
    const { files: left, removedTotal, moves } = unmoved(files);
    commit.files = left;
    commit.removedTotal = removedTotal;
    commit.moves = moves;
  }
  return commits;
}

/** A commit's full SHA and message, if it is in the history here (`sha` may be short); null if not. */
export function commitOf(git, sha) {
  try {
    const full = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${sha}^{commit}`]).toString("utf8").trim();
    if (!isSha(full)) return null;
    return { sha: full, message: parseBatch(git(["cat-file", "--batch"], `${full}\n`)).get(full) ?? "" };
  } catch {
    return null;
  }
}

/** Whether `ancestor` is in the history of `sha`. */
export function isAncestor(git, ancestor, sha) {
  try {
    git(["merge-base", "--is-ancestor", ancestor, sha]);
    return true;
  } catch (err) {
    if (err.git === 1) return false;
    throw err;
  }
}
