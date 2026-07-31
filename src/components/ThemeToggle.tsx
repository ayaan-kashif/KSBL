'use client';

import { useSyncExternalStore } from 'react';
import styles from './ThemeToggle.module.css';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'shelfwatch-theme';

/**
 * The applied theme lives on <html data-theme>, written by the bootstrap script
 * in layout.tsx before first paint. That attribute — not React state — is the
 * source of truth, so this subscribes to it rather than mirroring it.
 *
 * Using an external store rather than useState+useEffect buys two things:
 * it avoids a setState-in-effect cascade on mount, and it keeps every mounted
 * toggle in sync (TopNav renders one for desktop and one for mobile, and with
 * local state the hidden one would silently drift out of date).
 */
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/* The server cannot know which theme the client resolved. Returning a fixed
   value keeps the markup deterministic; useSyncExternalStore re-renders with
   the real one immediately after hydration, without a mismatch warning. */
function getServerSnapshot(): Theme {
  return 'light';
}

export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const isDark = theme === 'dark';

  const toggle = () => {
    const next: Theme = isDark ? 'light' : 'dark';
    // Writing the attribute is what actually re-renders this component, via the
    // MutationObserver above.
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* Private mode / storage disabled — the theme still applies for this
         session, it just won't survive a reload. Not worth surfacing. */
    }
  };

  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      onClick={toggle}
      className={[
        styles.toggle,
        compact ? styles.compact : '',
        isDark ? styles.isDark : '',
      ].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      aria-pressed={isDark}
    >
      {/* Both glyphs are always rendered so the swap can crossfade. The button
          already carries the state in aria-label/aria-pressed, so the track,
          thumb and icons are all decorative to assistive tech. */}
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb}>
          <span className={styles.glyphs}>
            <span className={`${styles.glyph} ${styles.sun}`}>
              <span className="material-symbols-outlined">light_mode</span>
            </span>
            <span className={`${styles.glyph} ${styles.moon}`}>
              <span className="material-symbols-outlined">dark_mode</span>
            </span>
          </span>
        </span>
      </span>
    </button>
  );
}
