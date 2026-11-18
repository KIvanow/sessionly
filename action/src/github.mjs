// The few GitHub REST calls the Action needs, with the built-in fetch.

/** `request(method, path, body)` against GitHub's API at `apiUrl`. */
export function github(token, apiUrl = "https://api.github.com") {
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
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300);
      throw Object.assign(new Error(`GitHub answered ${response.status} to ${method} ${path}: ${text}`), { status: response.status });
    }
    return response.status === 204 ? null : response.json();
  };
  return { request };
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
