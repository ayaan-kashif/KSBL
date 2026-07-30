'use client';

import React from 'react';
import styles from './VerdictBadge.module.css';
import { VERDICT_LABEL, type BadgeVerdict } from '@/lib/verdictCopy';
import { useLanguage } from './LanguageContext';

interface VerdictBadgeProps {
  verdict: BadgeVerdict;
  size?: 'sm' | 'md' | 'lg';
}

const verdictIcon: Record<BadgeVerdict, string> = {
  genuine: 'verified',
  suspicious: 'warning',
  counterfeit: 'cancel',
  unverified: 'help_outline',
  processing: 'radar',
};

export default function VerdictBadge({ verdict, size = 'md' }: VerdictBadgeProps) {
  const { lang } = useLanguage();
  const label = VERDICT_LABEL[verdict];
  const urduLeads = lang === 'ur';

  // Both languages always render; the toggle only decides which one leads.
  const urduLine = (
    <span
      lang="ur"
      dir="rtl"
      className={`${styles.urdu} ${urduLeads ? styles.labelPrimary : styles.labelSecondary}`}
    >
      {label.ur}
    </span>
  );
  const englishLine = (
    <span
      lang="en"
      dir="ltr"
      className={urduLeads ? styles.labelSecondary : styles.labelPrimary}
    >
      {label.en}
    </span>
  );

  return (
    <div className={`${styles.badge} ${styles[verdict]} ${styles[size]}`}>
      <span className={`material-symbols-outlined ${styles.icon}`} aria-hidden="true">
        {verdictIcon[verdict]}
      </span>
      <span className={styles.labels}>
        {urduLeads ? urduLine : englishLine}
        {urduLeads ? englishLine : urduLine}
      </span>
    </div>
  );
}
