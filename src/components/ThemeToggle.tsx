'use client';

import { useSyncExternalStore } from 'react';
import styles from './ThemeToggle.module.css';

type Theme = 'light' | 'dark';

const STORAGE_KEY = 'shelfwatch-theme';
const EVENT = 'shelfwatch:themechange';

/**
 * The <html> data-theme attribute is the single source of truth — the inline
 * bootstrap in src/app/layout.tsx sets it before first paint, so reading it
 * here (rather than keeping a parallel React state) guarantees the button can
 * never disagree with what the user is actually looking at.
 */
function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  // Keep tabs in sync when the theme is changed in another window.
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

function getSnapshot(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

// The server has no DOM and no localStorage, so it always renders the dark
// default; the bootstrap script corrects the attribute before paint.
function getServerSnapshot(): Theme {
  return 'dark';
}

export default function ThemeToggle({ className = '' }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    if (next === 'light') {
      document.documentElement.dataset.theme = 'light';
    } else {
      delete document.documentElement.dataset.theme;
    }
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode or blocked storage: the theme still applies for this
      // session, it just won't persist. Not worth surfacing to the user.
    }
    window.dispatchEvent(new Event(EVENT));
  };

  const label = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;

  return (
    <button
      type="button"
      onClick={toggle}
      className={`${styles.toggle} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={theme === 'light'}
    >
      <span className={styles.track} aria-hidden="true">
        <span className={`${styles.thumb} ${theme === 'light' ? styles.thumbLight : ''}`}>
          <span className="material-symbols-outlined" aria-hidden="true">
            {theme === 'light' ? 'light_mode' : 'dark_mode'}
          </span>
        </span>
      </span>
    </button>
  );
}
