'use client';

import styles from './MetricCard.module.css';

interface MetricCardProps {
  label: string;
  value: string | number;
  icon?: string;
  trend?: 'up' | 'down' | 'flat';
  trendLabel?: string;
}

const trendIcon: Record<NonNullable<MetricCardProps['trend']>, string> = {
  up: 'trending_up',
  down: 'trending_down',
  flat: 'trending_flat',
};

const trendClass: Record<NonNullable<MetricCardProps['trend']>, string> = {
  up: styles.trendUp,
  down: styles.trendDown,
  flat: styles.trendFlat,
};

export default function MetricCard({ label, value, icon, trend, trendLabel }: MetricCardProps) {
  return (
    <div className={`liquid-glass-gradient-border lift ${styles.card}`}>
      <div className={styles.topRow}>
        <span className={styles.label}>{label}</span>
        {icon && (
          <div className={styles.iconWrap}>
            <span className={`material-symbols-outlined ${styles.icon}`} aria-hidden="true">{icon}</span>
          </div>
        )}
      </div>
      <div className={styles.value}>{value}</div>
      {trend && trendLabel && (
        <div className={`${styles.trendRow} ${trendClass[trend]}`}>
          <span className={`material-symbols-outlined ${styles.trendIcon}`} aria-hidden="true">{trendIcon[trend]}</span>
          <span>{trendLabel}</span>
        </div>
      )}
    </div>
  );
}
