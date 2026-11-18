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
      throw new Error(`GitHub answered ${response.status} to ${method} ${path}: ${text}`);
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
 * many others there are from then on, which were left out.
 */
export async function listPulls(api, repo, since, most) {
  const numbers = [];
  let more = 0;
  for (let page = 1; ; page += 1) {
    const batch = await api.request(
      "GET",
      `/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
    );
    for (const pull of batch) {
      if (Date.parse(pull.created_at) < since) return { numbers, more };
      if (numbers.length < most) numbers.push(pull.number);
      else more += 1;
    }
    if (batch.length < 100) return { numbers, more };
  }
}

/** Everything about a pull request that goes into a report. */
export async function readPull(api, repo, number) {
  const base = `/repos/${repo}/pulls/${number}`;
  const [pull, files, reviews, comments, commits, conversation] = await Promise.all([
    api.request("GET", base),
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
