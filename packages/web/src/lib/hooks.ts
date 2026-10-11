import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/client";

export interface Resource<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (updater: T | ((prev: T | undefined) => T | undefined)) => void;
}

/**
 * Load data with a fetcher; re-runs when `deps` change. Passing `enabled=false` skips loading.
 * Stale responses (from a previous dependency set) are discarded.
 */
export function useResource<T>(fetcher: () => Promise<T>, deps: unknown[], enabled = true): Resource<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const generation = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const run = useCallback(async () => {
    const gen = ++generation.current;
    setLoading(true);
    try {
      const result = await fetcherRef.current();
      if (gen === generation.current) {
        setDataState(result);
        setError(null);
      }
    } catch (err) {
      if (gen === generation.current) setError(errorMessage(err));
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    setDataState(undefined);
    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled]);

  const setData = useCallback((updater: T | ((prev: T | undefined) => T | undefined)) => {
    setDataState((prev) =>
      typeof updater === "function" ? (updater as (p: T | undefined) => T | undefined)(prev) : updater,
    );
  }, []);

  return { data, error, loading, reload: run, setData };
}

/** Run `fn` every `ms` while `active`; the latest `fn` is always used. */
export function useInterval(fn: () => void, ms: number, active = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => ref.current(), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
}

/** Coalesce bursts of calls (e.g. many live events) into one trailing call. */
export function useDebounced(fn: () => void, ms: number): () => void {
  const ref = useRef(fn);
  ref.current = fn;
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      ref.current();
    }, ms);
  }, [ms]);
}
