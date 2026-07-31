'use client';

import { useSyncExternalStore } from 'react';
import { readScanResult, type ScanResult } from './api';

const SCAN_KEY = 'shelfwatch_scan_result';

/**
 * The parsed result, cached against the raw string it came from.
 *
 * useSyncExternalStore compares snapshots by reference and re-renders whenever
 * they differ, so a getSnapshot that JSON.parse'd on every call would return a
 * fresh object each time and spin forever. Caching by raw string means the same
 * reference comes back until sessionStorage actually changes.
 */
let cachedRaw: string | null = null;
let cachedValue: ScanResult | null = null;

function getSnapshot(): ScanResult | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(SCAN_KEY);
  } catch {
    /* Private mode / storage disabled — treat as "no result". */
    return null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedValue = readScanResult();
  }
  return cachedValue;
}

/* The server has no sessionStorage, so it always renders the "no result" branch
   and the client corrects after hydration. Returning a constant (not null from
   getSnapshot) keeps the server render deterministic. */
function getServerSnapshot(): ScanResult | null {
  return null;
}

/**
 * Storage events only fire for OTHER tabs, and a scan result is written by the
 * same tab immediately before navigating here — so there is nothing to
 * subscribe to within one page's lifetime. The no-op keeps the store API
 * satisfied without pretending to observe changes it cannot see.
 */
function subscribe(): () => void {
  return () => {};
}

/**
 * Reads the scan result handed over from the scan flow via sessionStorage.
 *
 * Replaces the `useState` + `useEffect(() => setResult(...), [])` pattern these
 * pages used, which tripped React's set-state-in-effect rule and rendered one
 * throwaway frame with no data before correcting itself.
 *
 * Returns `null` on the server and on the first client frame, so callers must
 * handle the empty case — see `useRequireScanResult` for the redirect version.
 */
export function useScanResult(): ScanResult | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/* ── Generic variant ────────────────────────────────────────────────────────
   /scan/result hands over under a different key (the richer verify payload),
   so it needs the same machinery against another slot. Caches are kept per key
   for the same reason as above: a fresh parse on every getSnapshot call would
   return a new reference and loop forever. */

const jsonCache = new Map<string, { raw: string | null; value: unknown }>();

function readJson<T>(key: string): T | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(key);
  } catch {
    return null;
  }

  const hit = jsonCache.get(key);
  if (hit && hit.raw === raw) return hit.value as T | null;

  let value: T | null = null;
  if (raw) {
    try {
      value = JSON.parse(raw) as T;
    } catch {
      /* Corrupt payload — treat as absent rather than crashing the screen. */
      value = null;
    }
  }
  jsonCache.set(key, { raw, value });
  return value;
}

/**
 * Reads a JSON blob handed over via sessionStorage, hydration-safe.
 *
 * Same contract as `useScanResult`: `null` on the server and until the first
 * client snapshot, so every caller has to handle the empty case.
 */
export function useSessionJson<T>(key: string): T | null {
  return useSyncExternalStore(
    subscribe,
    () => readJson<T>(key),
    () => null,
  );
}
