'use client';

import Tilt3D from './Tilt3D';
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
    // The scene wrapper owns the perspective; the plate inside it is what
    // actually rotates. They have to be separate elements — an element cannot
    // be both the vanishing point and the thing being rotated within it.
    <div className={`scene ${styles.scene}`}>
      <Tilt3D className={`plate rim spotlight ${styles.card}`} max={7} lift={16}>
        <div className={`depth-1 ${styles.topRow}`}>
          <span className={styles.label}>{label}</span>
          {icon && (
            <div className={styles.iconWrap}>
              <span className={`material-symbols-outlined ${styles.icon}`} aria-hidden="true">{icon}</span>
            </div>
          )}
        </div>
        <div className={`depth-2 ${styles.value}`}>{value}</div>
        {trend && trendLabel && (
          <div className={`depth-1 ${styles.trendRow} ${trendClass[trend]}`}>
            <span className={`material-symbols-outlined ${styles.trendIcon}`} aria-hidden="true">{trendIcon[trend]}</span>
            <span>{trendLabel}</span>
          </div>
        )}
      </Tilt3D>
    </div>
  );
}
