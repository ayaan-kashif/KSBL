'use client';

import { useSyncExternalStore } from 'react';

/**
 * A shared clock for relative timestamps ("3m ago").
 *
 * Reading `Date.now()` straight inside render is impure — the same props
 * produce different output on every pass, which React flags — and it is a
 * hydration hazard, because the server and the client stamp different times
 * into the same markup.
 *
 * This solves both: the server snapshot is `0`, a sentinel meaning "no clock
 * yet", so server output is deterministic and callers can fall back to an
 * absolute date. After hydration the real time arrives, and a single shared
 * interval re-renders every subscriber together rather than each row running
 * its own timer.
 */
let now = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const TICK_MS = 30_000;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, TICK_MS);
  }

  return () => {
    listeners.delete(listener);
    // Last subscriber out clears the interval, so an unmounted page does not
    // keep a timer alive for the rest of the session.
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  // Seed on the first read so the initial paint is not stuck at the sentinel
  // while waiting for the first tick.
  if (now === 0) now = Date.now();
  return now;
}

function getServerSnapshot(): number {
  return 0;
}

/** Current time in ms, or `0` on the server / before hydration. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Relative time against a caller-supplied `now`.
 *
 * `now === 0` means the clock has not started (server render), so this returns
 * an absolute date instead — deterministic markup, no mismatch on hydration.
 */
export function formatRelativeTime(dateStr: string | null | undefined, now: number): string {
  if (!dateStr) return 'Unknown';

  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return 'Unknown';

  const absolute = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (now === 0) return absolute;

  const diffMins = Math.floor((now - d.getTime()) / 60_000);
  if (diffMins < 0) return absolute;      // clock skew — don't say "in -3m"
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  return absolute;
}
