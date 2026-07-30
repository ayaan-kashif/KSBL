'use client';

/**
 * components/LanguageToggle.tsx
 *
 * EN / اردو switch. Rendered in TopNav (desktop) and BottomNav (mobile).
 * Changes which language leads on verdict screens; both always stay visible.
 */

import { useLanguage } from './LanguageContext';
import styles from './LanguageToggle.module.css';

export default function LanguageToggle({ compact = false }: { compact?: boolean }) {
  const { lang, setLang } = useLanguage();

  return (
    <div
      className={`${styles.toggle} ${compact ? styles.compact : ''}`}
      role="group"
      aria-label="Display language"
    >
      <button
        type="button"
        onClick={() => setLang('en')}
        aria-pressed={lang === 'en'}
        className={`${styles.option} ${lang === 'en' ? styles.active : ''}`}
      >
        EN
      </button>
      <button
        type="button"
        lang="ur"
        onClick={() => setLang('ur')}
        aria-pressed={lang === 'ur'}
        className={`${styles.option} ${styles.urdu} ${lang === 'ur' ? styles.active : ''}`}
      >
        اردو
      </button>
    </div>
  );
}
