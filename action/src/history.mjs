// Reading a base branch's history with git, in the runner, as the sessionly
// binary reads a repository's: in three steps that nothing in a commit can
// be mistaken in. `rev-list` for the SHAs and times, `cat-file --batch` for
// the messages (each with its size), `diff-tree --stdin` for the changes.
import { lineHash, SPACE } from "./lines.mjs";

/** How long one git command may take, and how much it may print. */
const GIT_DEADLINE = 120_000;
const GIT_MOST = 256 * 1024 * 1024;
/** How many times a reading follows lines to where a commit moved them. */
const MOST_PASSES = 3;
/** A commit that adds and removes more lines than this is not read whole, and not counted: a vendored, generated or moved tree. */
export const MOST_LINES_SHOWN = 100_000;
/** Commits read whole in one reading, as the binary's `MOST_SHOWN`: the reading stops before the next. */
export const MOST_SHOWN = 2000;
/** Commits read whole at a time, and read for their files and messages. */
const SHOWN_AT_ONCE = 250;
const LISTED_AT_ONCE = 1000;
/**
 * How much of a command line the paths to read may take: well within what
 * Linux and macOS allow, and what Windows does (32,767 characters).
 */
const PATH_BYTES = process.platform === "win32" ? 24_000 : 200_000;

/** What Rust's `str::trim` removes, at both ends. */
const ENDS = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");

const PATCH = ["-p", "-U0", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];

/** A full commit SHA as git prints one. */
export const isSha = (text) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text);

/**
 * Git in `cwd`, for reading history: paths as they are, whatever the
 * environment says of pathspecs or of which repository; no prompt, no
 * signature checked. `spawn` is `spawnSync`. Returns what it printed, as a
 * Buffer; throws when it fails (with its exit code as `git`), prints more
 * than `most` bytes (`tooLarge`) or takes too long.
 */
export function gitIn(cwd, spawn, most = GIT_MOST) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  return (args, input) => {
    const done = spawn("git", ["-c", "core.quotepath=off", "-c", "log.showSignature=false", "--literal-pathspecs", ...args], {
      cwd,
      input,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: most,
      timeout: GIT_DEADLINE,
    });
    // More than it may print is a commit too large to read so, not git failing.
    if (done.error) throw Object.assign(new Error(`git ${args[0]} could not be run: ${done.error.message}`), { tooLarge: done.error.code === "ENOBUFS" });
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
 * message whose commit says it is Latin-1 is read as that. As the binary
 * reads one: the headers as UTF-8, the encoding's name without the white
 * space around it, and the message without Rust's white space at its ends
 * (a byte order mark stays, U+0085 goes).
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
      .toString("utf8")
      .split("\n")
      .some((line) => line.startsWith("encoding ") && ["iso-8859-1", "iso8859-1", "latin1", "latin-1", "l1"].includes(line.slice(9).replace(ENDS, "").replace(/[A-Z]+/g, (c) => c.toLowerCase())));
    messages.set(sha, body.toString(latin1 ? "latin1" : "utf8").replace(ENDS, ""));
  }
  return messages;
}

/**
 * `diff-tree --stdin --always` output, cut at each commit's SHA line: one
 * for every commit given, in the order given (a line of a patch always
 * begins with something else). Git leaves out one it cannot read and goes
 * on, and then what follows would be taken for another commit's: so, as
 * the binary does, none of it is, and the reading fails.
 */
export function splitTree(text, shas) {
  const parts = new Map();
  let next = 0;
  let open = null;
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\n$/, "");
    if (isSha(bare)) {
      if (bare !== shas[next]) throw new Error(`git diff-tree left out a commit (${shas[next] ?? "none"} was next, ${bare} came)`);
      if (open) parts.set(shas[open.i], text.slice(open.start, offset));
      open = { i: next, start: offset + line.length };
      next += 1;
    }
    offset += line.length;
  }
  if (open) parts.set(shas[open.i], text.slice(open.start));
  if (next < shas.length) throw new Error(`git diff-tree left out ${shas.length - next} of ${shas.length} commits`);
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
 * added again, in that file or another, is taken out of both. One removed
 * and added again in the same file stays there; only what is left of it
 * moves to another. With the tracked lines it removed, less those, and each
 * line moved to another file: `[from, to, hash, copies]`.
 */
export function unmoved(files) {
  const paths = [...files.keys()].sort();
  // Which files each line was removed from and added to, in that order, and
  // how many: found once, not file by file for each line.
  const removed = new Map();
  const added = new Map();
  const push = (map, hash, side) => (map.has(hash) ? map.get(hash).push(side) : map.set(hash, [side]));
  for (const path of paths) {
    const diff = files.get(path);
    for (const [hash, n] of diff.removed) push(removed, hash, [path, n]);
    for (const [hash, n] of diff.added) push(added, hash, [path, n]);
  }
  const take = (bag, hash, n) => {
    if (bag.get(hash) > n) bag.set(hash, bag.get(hash) - n);
    else bag.delete(hash);
  };
  const moves = [];
  for (const hash of [...removed.keys()].filter((h) => added.has(h)).sort()) {
    const from = removed.get(hash);
    const to = added.get(hash);
    // In the same file first: not moved.
    const here = new Map(to.map((side) => [side[0], side]));
    for (const side of from) {
      const there = here.get(side[0]);
      const same = Math.min(side[1], there?.[1] ?? 0);
      if (same === 0) continue;
      side[1] -= same;
      there[1] -= same;
      take(files.get(side[0]).removed, hash, same);
      take(files.get(side[0]).added, hash, same);
    }
    // What is left of it, from one file to another, in order.
    let [f, t] = [0, 0];
    while (f < from.length && t < to.length) {
      const taken = Math.min(from[f][1], to[t][1]);
      if (taken > 0) {
        moves.push([from[f][0], to[t][0], hash, taken]);
        from[f][1] -= taken;
        to[t][1] -= taken;
        take(files.get(from[f][0]).removed, hash, taken);
        take(files.get(to[t][0]).added, hash, taken);
      }
      if (from[f][1] === 0) f += 1;
      if (to[t][1] === 0) t += 1;
    }
  }
  let total = 0;
  for (const diff of files.values()) for (const n of diff.removed.values()) total += n;
  return { files, removedTotal: total, moves };
}

/** SHAs as git reads them on its input, one a line. */
const lines = (shas) => shas.map((sha) => `${sha}\n`).join("");

/**
 * `git rev-list` with `args`, from `revs` (`<sha>`, `^<sha>`), for the
 * commits that changed `paths`. The revisions and the paths go in on its
 * input, so that there can be any number of them (a command line holds only
 * so much); a path that a line of input cannot carry (with a line break in
 * it) goes on the command line.
 */
export function revList(git, args, revs, paths) {
  const odd = paths.filter((path) => /[\n\r]/.test(path));
  const plain = paths.filter((path) => !/[\n\r]/.test(path));
  return git(["rev-list", ...args, "--stdin", ...(odd.length > 0 ? ["--", ...odd] : [])], lines([...revs, "--", ...plain]));
}

/** Paths in parts that each fit on a command line. */
function pathParts(paths) {
  const parts = [[]];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1;
    if (bytes + size > PATH_BYTES && parts.at(-1).length > 0) {
      parts.push([]);
      bytes = 0;
    }
    parts.at(-1).push(path);
    bytes += size;
  }
  return parts;
}

/**
 * What `read` makes of the commits, so many at a time: a batch git prints
 * too much for is read in halves, and a commit too large on its own is left
 * out (and is in `left`), as the binary leaves out one that is `TooLarge`.
 */
function inBatches(shas, size, read) {
  const found = new Map();
  const left = new Set();
  const queue = [];
  for (let from = 0; from < shas.length; from += size) queue.push(shas.slice(from, from + size));
  while (queue.length > 0) {
    const some = queue.shift();
    let out;
    try {
      out = read(some);
    } catch (err) {
      if (!err.tooLarge) throw err;
      if (some.length === 1) left.add(some[0]);
      else queue.unshift(some.slice(0, some.length >> 1), some.slice(some.length >> 1));
      continue;
    }
    for (const [sha, value] of out) found.set(sha, value);
  }
  return { found, left };
}

/**
 * The commits `list(paths)` gives (each `{sha, at}`, in the order they are
 * to be read) with their messages and changes in `paths`. One that removes
 * any line there is read whole: a line it adds back elsewhere was moved,
 * not changed, and is taken out; one too large for that is not counted (its
 * removed lines are cleared). Lines moved out of a path read go with the
 * reading to their new path, which is read too (up to `MOST_PASSES`
 * readings). No more than `MOST_SHOWN` are read whole: `cut` is the first
 * that would be one more (null if none), where the reading stops.
 */
export function readHistory(git, list, paths) {
  const tracked = new Set(paths);
  let read = { commits: [], cut: null };
  for (let pass = 1; pass <= MOST_PASSES; pass += 1) {
    read = readOnce(git, list, [...tracked].sort());
    let more = false;
    for (const commit of read.commits) {
      for (const [from, to] of commit.moves) {
        if (tracked.has(from) && !tracked.has(to)) {
          tracked.add(to);
          more = true;
        }
      }
    }
    if (!more) break;
  }
  return { ...read, paths: [...tracked].sort() };
}

function readOnce(git, list, paths) {
  if (paths.length === 0) return { commits: [], cut: null };
  const listed = list(paths);
  if (listed.length === 0) return { commits: [], cut: null };
  const shas = listed.map((c) => c.sha);
  const messages = inBatches(shas, LISTED_AT_ONCE, (some) => parseBatch(git(["cat-file", "--batch"], lines(some)))).found;
  // Their changes in the files read: so many commits, and so many paths, at a time.
  const diffs = new Map();
  const unread = new Set();
  for (const part of pathParts(paths)) {
    const { found, left } = inBatches(shas, LISTED_AT_ONCE, (some) => {
      const out = git(["diff-tree", "--stdin", "--always", "--root", ...PATCH, "--", ...part], lines(some)).toString("utf8");
      return [...splitTree(out, some)].map(([sha, diff]) => [sha, parseDiff(diff)]);
    });
    for (const sha of left) unread.add(sha);
    for (const [sha, files] of found) diffs.set(sha, new Map([...(diffs.get(sha) ?? []), ...files]));
  }
  const commits = listed.map(({ sha, at }) => ({
    sha,
    at,
    message: messages.get(sha) ?? "",
    // One too large to read even in the files read is not counted.
    files: unread.has(sha) ? new Map() : (diffs.get(sha) ?? new Map()),
    removedTotal: null,
    moves: [],
  }));
  const candidates = commits.filter((c) => [...c.files.values()].some((d) => d.removed.size > 0));
  if (candidates.length === 0) return { commits, cut: null };
  const asked = candidates.slice(0, MOST_SHOWN).map((c) => c.sha);
  const sizes = inBatches(asked, SHOWN_AT_ONCE, (some) =>
    splitTree(git(["diff-tree", "--stdin", "--always", "--root", "--numstat", "--no-renames"], lines(some)).toString("utf8"), some),
  ).found;
  const small = asked.filter((sha) => {
    if (!sizes.has(sha)) return false;
    const counts = sizes.get(sha).split("\n").flatMap((line) => line.split("\t").slice(0, 2)).filter((n) => /^\d+$/.test(n));
    return counts.reduce((sum, n) => sum + Number(n), 0) <= MOST_LINES_SHOWN;
  });
  const whole = inBatches(small, SHOWN_AT_ONCE, (some) => {
    const out = git(["diff-tree", "--stdin", "--always", "--root", ...PATCH], lines(some)).toString("utf8");
    return [...splitTree(out, some)].map(([sha, diff]) => [sha, parseDiff(diff)]);
  }).found;
  for (const commit of candidates.slice(0, MOST_SHOWN)) {
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
  return { commits, cut: candidates[MOST_SHOWN]?.sha ?? null };
}

/** The SHAs `rev-list` printed, one a line. */
export const shasOf = (out) => out.toString("utf8").split("\n").filter(isSha);

/**
 * The commits on `tip` that are not on the commits of a list in `bottoms`,
 * for each list: what became part of the branch after it was at those
 * commits, whatever the commits' dates. `nodes` has each with its time and
 * parents; `of(bottom)` the SHAs of one list's.
 */
export function regionOf(git, tip, bottoms) {
  const nodes = new Map();
  const sets = new Map();
  for (const bottom of bottoms) {
    const key = JSON.stringify(bottom);
    if (sets.has(key)) continue;
    const out = git(["rev-list", "--parents", "--timestamp", "--stdin"], lines([tip, ...bottom.map((sha) => `^${sha}`)]));
    const set = new Set();
    for (const line of out.toString("utf8").split("\n")) {
      const [at, sha, ...parents] = line.split(" ");
      if (!isSha(sha ?? "") || !/^\d+$/.test(at)) continue;
      set.add(sha);
      if (!nodes.has(sha)) nodes.set(sha, { at: Number(at), parents: parents.filter(isSha) });
    }
    sets.set(key, set);
  }
  return { nodes, of: (bottom) => sets.get(JSON.stringify(bottom)) ?? new Set() };
}

/**
 * Where each commit of `nodes` came onto the branch at `tip`: `chain` is
 * the branch's own commits (first parents from `tip`, oldest first), and
 * each commit's `group` the first of those it is part of: a merged
 * branch's commits come with the merge commit. `order` puts them so, and
 * parents first within each.
 */
export function placeOf(nodes, tip) {
  const chain = [];
  for (let at = tip; at && nodes.has(at); at = nodes.get(at).parents[0]) chain.push(at);
  chain.reverse();
  const place = new Map();
  const opened = new Set();
  chain.forEach((head, group) => {
    const stack = [head];
    while (stack.length > 0) {
      const sha = stack.at(-1);
      if (place.has(sha)) {
        stack.pop();
        continue;
      }
      if (!opened.has(sha)) {
        opened.add(sha);
        stack.push(...nodes.get(sha).parents.filter((p) => nodes.has(p) && !place.has(p)).reverse());
        continue;
      }
      stack.pop();
      place.set(sha, { group, order: place.size });
    }
  });
  return { chain, place };
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
