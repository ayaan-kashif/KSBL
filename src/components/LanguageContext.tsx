'use client';

/**
 * components/LanguageContext.tsx
 *
 * EN / اردو preference, persisted to localStorage.
 *
 * The toggle changes EMPHASIS, not availability — verdict screens keep both
 * languages on screen in both modes (evaluators need to see the bilingual
 * capability without hunting for it). So this context deliberately does not
 * gate rendering; components use it to decide which language leads.
 *
 * localStorage is an external store, so it's read through
 * useSyncExternalStore rather than an effect + setState. That gives correct
 * hydration for free (React renders getServerSnapshot first, then swaps to
 * the client value) and picks up changes from other tabs, without the
 * cascading render that a setState-in-effect would cause.
 *
 * React context is not available in Server Components, so this is a Client
 * Component that takes `children` and is rendered from the server layout
 * (node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md).
 */

import { createContext, useContext, useCallback, useSyncExternalStore } from 'react';
import type { Language } from '@/lib/verdictCopy';

const STORAGE_KEY = 'shelfwatch_lang';

let listeners: Array<() => void> = [];
// getSnapshot must return a referentially stable value or React re-renders
// forever, so the parsed value is cached and invalidated on write / storage event.
let cached: Language | null = null;

function readStored(): Language {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'ur' ? 'ur' : 'en';
  } catch {
    return 'en'; // private mode / storage disabled
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.push(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      cached = null;
      onChange();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners = listeners.filter((l) => l !== onChange);
    window.removeEventListener('storage', onStorage);
  };
}

function getSnapshot(): Language {
  if (cached === null) cached = readStored();
  return cached;
}

// The server has no localStorage; always render English first so the markup
// is deterministic. React swaps in the stored value right after hydration.
function getServerSnapshot(): Language {
  return 'en';
}

function writeLang(next: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* ignore quota/permission errors — the toggle still works this session */
  }
  cached = next;
  listeners.forEach((l) => l());
}

interface LanguageContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  toggle: () => void;
}

const LanguageContext = createContext<LanguageContextValue>({
  lang: 'en',
  setLang: () => {},
  toggle: () => {},
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setLang = useCallback((next: Language) => writeLang(next), []);
  const toggle = useCallback(() => writeLang(getSnapshot() === 'en' ? 'ur' : 'en'), []);

  return (
    <LanguageContext.Provider value={{ lang, setLang, toggle }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}
