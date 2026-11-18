import { useEffect, useState } from "react";
import { api, ApiError } from "./api.ts";

export interface Loaded<T> {
  data: T | null;
  /** The path `data` was fetched for. It stays put while a request for another path is in flight. */
  dataPath: string | null;
  error: string | null;
  /** HTTP status of a failed request (0 if the server could not be reached). */
  errorStatus: number | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch `path` whenever it changes. A 401 signs the user out. */
export function useApi<T>(token: string, path: string | null, onSignedOut: () => void): Loaded<T> {
  const [state, setState] = useState<Omit<Loaded<T>, "reload">>({
    data: null,
    dataPath: null,
    error: null,
    errorStatus: null,
    loading: path !== null,
  });
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    const asked = path;
    setState((s) => ({ ...s, loading: true, error: null }));
    api<T>(token, path, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ data, dataPath: asked, error: null, errorStatus: null, loading: false });
      })
      .catch((err: Error) => {
        if (err.name === "AbortError" || controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) onSignedOut();
        const errorStatus = err instanceof ApiError ? err.status : null;
        setState({ data: null, dataPath: asked, error: err.message, errorStatus, loading: false });
      });
    return () => controller.abort();
  }, [token, path, version]);
  return { ...state, reload: () => setVersion((v) => v + 1) };
}
