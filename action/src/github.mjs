// The few GitHub REST calls the Action needs, with the built-in fetch.

/** `request(method, path, body)` against GitHub's API at `apiUrl`, and `graphql(query, variables)` against the one at `graphqlUrl`. */
export function github(token, apiUrl = "https://api.github.com", graphqlUrl = `${apiUrl}/graphql`) {
  // How many requests GitHub said the token has left this hour, at the last answer.
  let remaining;
  const counted = (response) => {
    const left = Number(response.headers.get("x-ratelimit-remaining"));
    if (response.headers.has("x-ratelimit-remaining") && Number.isFinite(left)) remaining = left;
  };
  const request = async (method, path, body) => {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "sessionly-action",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    counted(response);
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw Object.assign(new Error(`GitHub answered ${response.status} to ${method} ${path}: ${text}`), { status: response.status });
    }
    return response.status === 204 ? null : response.json();
  };
  /** A file as it is on a branch, as text; null if there is none at that path. */
  const text = async (path) => {
    const response = await fetch(`${apiUrl}${path}`, {
      headers: {
        accept: "application/vnd.github.raw+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "sessionly-action",
      },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const said = (await response.text()).slice(0, 300);
      throw Object.assign(new Error(`GitHub answered ${response.status} to GET ${path}: ${said}`), { status: response.status });
    }
    return response.text();
  };
  /** One question of GitHub's GraphQL API; what it answers under `data`. */
  const graphql = async (query, variables) => {
    const response = await fetch(graphqlUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "sessionly-action" },
      body: JSON.stringify({ query, variables }),
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok || answer.errors?.length || !answer.data) {
      const said = String(answer.errors?.[0]?.message ?? answer.message ?? "no reason given").slice(0, 300);
      throw Object.assign(new Error(`GitHub answered ${response.status} to a GraphQL query: ${said}`), { status: response.status });
    }
    return answer.data;
  };
  return {
    request,
    text,
    graphql,
    /** Undefined until GitHub has said. */
    get remaining() {
      return remaining;
    },
  };
}

/** Every item of a list GitHub serves in pages. */
export async function all(api, path, limit = 5000) {
  const items = [];
  for (let page = 1; items.length < limit; page += 1) {
    const batch = await api.request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/**
 * The numbers of a repository's pull requests created at or after `since`
 * (a time in milliseconds), the latest first, `most` at most. `more` is how
 * many others there are from then on, which were left out, and `lowest` the
 * number of the earliest of those; `more` is null, and `lowest` not there,
 * when there are some and GitHub's search would not say how many.
 */
export async function listPulls(api, repo, since, most) {
  const numbers = [];
  for (let page = 1; numbers.length < most; page += 1) {
    const batch = await api.request(
      "GET",
      `/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
    );
    for (const pull of batch) {
      if (Date.parse(pull.created_at) < since) return { numbers, more: 0 };
      if (numbers.length === most) break;
      numbers.push(pull.number);
    }
    if (batch.length < 100) return { numbers, more: 0 };
  }
  // The rest are not read through, however many there are: one request says
  // how many pull requests there are from `since` on, and which is the first.
  try {
    const from = new Date(since).toISOString().replace(/\.\d+Z$/, "Z");
    const q = encodeURIComponent(`repo:${repo} is:pr created:>=${from}`);
    const found = await api.request("GET", `/search/issues?q=${q}&sort=created&order=asc&per_page=1`);
    const more = Math.max(0, Number(found.total_count) - numbers.length);
    return { numbers, more, lowest: more > 0 ? found.items?.[0]?.number : undefined };
  } catch {
    return { numbers, more: null };
  }
}

/** A path as part of an address: each folder and the name encoded, the slashes kept. */
const inAddress = (path) => path.split("/").map(encodeURIComponent).join("/");

/**
 * The branch to look for a merged pull request's lines on, and the commit it
 * is at now: the one it was merged into, or the repository's default branch
 * when that one is gone (a branch others were stacked on is deleted once it
 * is merged itself). The files are then all read at that commit, so that a
 * push in between does not make a count of two states of the branch.
 */
export async function branchFor(api, repo, ref) {
  const at = async (branch) => ({ branch, sha: (await api.request("GET", `/repos/${repo}/branches/${inAddress(branch)}`)).commit.sha });
  if (ref) {
    try {
      return await at(ref);
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  return at((await api.request("GET", `/repos/${repo}`)).default_branch);
}

/** A file as it is at a commit, as text; null if it is not there. */
export function fileOn(api, repo, sha, path) {
  return api.text(`/repos/${repo}/contents/${inAddress(path)}?ref=${encodeURIComponent(sha)}`);
}

/** How many files one question asks GitHub for. */
export const FILES_AT_ONCE = 50;

/**
 * Files as they are at a commit, as text by path; null for one that is not
 * there, and nothing for one that is not text. Asked for many at a time, so
 * that a pull request of thousands of files takes tens of requests and not
 * thousands: a workflow's token is allowed a thousand an hour. A file too
 * large to be answered that way is read on its own.
 */
export async function filesAt(api, repo, sha, paths) {
  const [owner, name] = repo.split("/");
  const texts = new Map();
  for (let from = 0; from < paths.length; from += FILES_AT_ONCE) {
    const some = paths.slice(from, from + FILES_AT_ONCE);
    const query =
      `query($owner: String!, $name: String!, ${some.map((_, i) => `$e${i}: String!`).join(", ")}) { repository(owner: $owner, name: $name) { ` +
      some.map((_, i) => `f${i}: object(expression: $e${i}) { ... on Blob { text isTruncated isBinary } }`).join(" ") +
      " } }";
    const variables = { owner, name, ...Object.fromEntries(some.map((path, i) => [`e${i}`, `${sha}:${path}`])) };
    const found = (await api.graphql(query, variables)).repository ?? {};
    for (const [i, path] of some.entries()) {
      const file = found[`f${i}`];
      // Nothing there, or a folder where the file was.
      if (!file || file.isBinary === undefined) texts.set(path, null);
      else if (file.isTruncated) texts.set(path, await fileOn(api, repo, sha, path));
      else texts.set(path, file.isBinary ? "" : (file.text ?? ""));
    }
  }
  return texts;
}

/** Everything about a pull request that goes into a report. */
export async function readPull(api, repo, number) {
  const base = `/repos/${repo}/pulls/${number}`;
  // First and alone: for a number that is no pull request, this is the
  // request that says so, and the others are not made.
  const pull = await api.request("GET", base);
  const [files, reviews, comments, commits, conversation] = await Promise.all([
    all(api, `${base}/files`),
    all(api, `${base}/reviews`),
    all(api, `${base}/comments`),
    all(api, `${base}/commits`),
    // The comments under the pull request, which are not on a line of its diff.
    all(api, `/repos/${repo}/issues/${number}/comments`),
  ]);
  return { pull, files, reviews, comments, commits, conversation };
}

/**
 * Create the Action's comment on a pull request, or bring it up to date.
 * `comments` are the pull request's, if they were read already. They may be
 * from before another run wrote the comment, so one that is not among them is
 * looked for again before a second is written.
 */
export async function upsertComment(api, repo, number, marker, body, comments) {
  const find = (list) => list?.find((c) => c.body?.includes(marker));
  const mine = find(comments) ?? find(await all(api, `/repos/${repo}/issues/${number}/comments`));
  if (mine) {
    if (mine.body !== body) await api.request("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
  } else {
    await api.request("POST", `/repos/${repo}/issues/${number}/comments`, { body });
  }
}
