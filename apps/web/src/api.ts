// Talking to the server. The access token lives in this browser's storage.
const STORAGE_KEY = "sessionly.token";
/** The sessions someone has in other organisations, to switch between. */
const SESSIONS_KEY = "sessionly.sessions";

/** A session someone got by signing in: one per organisation. */
export interface Saved {
  org: string;
  name: string;
  token: string;
}

export function savedSessions(): Saved[] {
  try {
    const list = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "[]") as Saved[];
    return Array.isArray(list) ? list.filter((s) => s && s.org && s.token) : [];
  } catch {
    return [];
  }
}

function saveSessions(list: Saved[]): void {
  try {
    if (list.length) localStorage.setItem(SESSIONS_KEY, JSON.stringify(list));
    else localStorage.removeItem(SESSIONS_KEY);
  } catch {
    // storage unavailable: nothing to switch between after a reload
  }
}

/** Remember a session, in place of an earlier one for the same organisation. */
export function keepSession(session: Saved): void {
  saveSessions([...savedSessions().filter((s) => s.org !== session.org), session]);
}

/** Forget every session: what signing out on a shared computer has to mean. */
export function clearSessions(): void {
  saveSessions([]);
}

/** Forget the session a token belongs to. Returns the ones that are left. */
export function dropSession(token: string): Saved[] {
  const left = savedSessions().filter((s) => s.token !== token);
  saveSessions(left);
  return left;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function savedToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private window): the token lasts until reload
  }
}

export async function api<T>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "The server could not be reached.");
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
  return data as T;
}

/** Ask something that needs no token: signing in, signing up, what the server offers. */
export async function open<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // The cookie of a sign-in that is under way goes along, to this server only.
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "The server could not be reached.");
  }
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, data.error ?? `HTTP ${response.status}`);
  return data as T;
}

/** Query string from the filters that are set. */
export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}
