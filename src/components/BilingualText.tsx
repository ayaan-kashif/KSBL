'use client';

/**
 * components/BilingualText.tsx
 *
 * Renders an English/Urdu pair stacked, with the active language leading and
 * the other directly beneath it. BOTH are always rendered — the language
 * toggle changes emphasis, not availability.
 *
 * The Urdu run carries lang="ur" dir="rtl" so the browser applies bidi
 * reordering and picks the Noto Arabic face; without them it falls back to a
 * Latin font that renders Arabic script badly.
 */

import { useLanguage } from './LanguageContext';
import styles from './BilingualText.module.css';

interface BilingualTextProps {
  en: string;
  ur: string;
  /** Visual weight of the leading line. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export default function BilingualText({ en, ur, size = 'md', className }: BilingualTextProps) {
  const { lang } = useLanguage();
  const urduLeads = lang === 'ur';

  const urduLine = (
    <p lang="ur" dir="rtl" className={`${styles.urdu} ${urduLeads ? styles.primary : styles.secondary}`}>
      {ur}
    </p>
  );
  const englishLine = (
    <p lang="en" dir="ltr" className={`${styles.english} ${urduLeads ? styles.secondary : styles.primary}`}>
      {en}
    </p>
  );

  return (
    <div className={`${styles.stack} ${styles[size]} ${className ?? ''}`}>
      {urduLeads ? urduLine : englishLine}
      {urduLeads ? englishLine : urduLine}
    </div>
  );
}
