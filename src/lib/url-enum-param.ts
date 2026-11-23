"use client";

import { useCallback, useEffect, useRef, useState } from "react";

function readEnumParam<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof window === "undefined") return fallback;
  const raw = new URLSearchParams(window.location.search).get(key);
  if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
  return fallback;
}

const APP_TITLE = "Research · India equities";

function pushParam(key: string, value: string | null) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  const href = `${url.pathname}${url.search}${url.hash}`;
  const now = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (href === now) return;
  window.history.pushState(window.history.state, "", href);
  if (document.title !== APP_TITLE) document.title = APP_TITLE;
}

/**
 * In-page view driven by a query param. Local state switches the UI immediately;
 * pushState keeps browser Back in sync (popstate restores).
 */
export function useUrlEnumParam<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValueState] = useState<T>(() =>
    readEnumParam(key, allowed, fallback),
  );
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const onPop = () => {
      const next = readEnumParam(key, allowed, fallback);
      if (next !== valueRef.current) setValueState(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [key, allowed, fallback]);

  const setValue = useCallback(
    (next: T) => {
      if (next === valueRef.current) return;
      valueRef.current = next;
      setValueState(next);
      pushParam(key, next === fallback ? null : next);
    },
    [key, fallback],
  );

  return [value, setValue];
}

/** Free-form query string (e.g. watchlist chip id). Empty/null clears the param. */
export function useUrlStringParam(
  key: string,
  fallback: string,
  normalize?: (raw: string) => string | null,
): [string, (next: string) => void] {
  const read = useCallback((): string => {
    if (typeof window === "undefined") return fallback;
    const raw = new URLSearchParams(window.location.search).get(key);
    if (raw == null || raw === "") return fallback;
    const n = normalize ? normalize(raw) : raw;
    return n != null && n !== "" ? n : fallback;
  }, [key, fallback, normalize]);

  const [value, setValueState] = useState<string>(read);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    const onPop = () => {
      const next = read();
      if (next !== valueRef.current) setValueState(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [read]);

  const setValue = useCallback(
    (next: string) => {
      const want = next === fallback || next === "" ? fallback : next;
      if (want === valueRef.current) return;
      valueRef.current = want;
      setValueState(want);
      pushParam(key, want === fallback ? null : want);
    },
    [key, fallback],
  );

  return [value, setValue];
}
