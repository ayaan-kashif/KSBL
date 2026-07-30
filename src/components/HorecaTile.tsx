'use client';

import { useEffect, useState } from 'react';
import styles from './HorecaTile.module.css';
import { getPartnerStats, formatPKR, type PartnerStats } from '@/lib/api';

/**
 * HORECA pull-through tile for the desktop dashboard.
 *
 * Leads with bulk product credit issued rather than vouchers redeemed: the
 * redemption count is the consumer-side story, but the B2B credit is what a
 * National Foods stakeholder is being asked to fund.
 */
export default function HorecaTile() {
  const [stats, setStats] = useState<PartnerStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getPartnerStats().then((res) => {
      setLoading(false);
      if (res.data) setStats(res.data);
    });
  }, []);

  return (
    <div className={`liquid-glass ${styles.tile}`}>
      <div className={styles.head}>
        <div>
          <p className={styles.eyebrow}>HORECA PARTNER NETWORK</p>
          <h2 className={styles.title}>Voucher pull-through</h2>
        </div>
        <span className={styles.liveChip}>
          <span className={styles.liveDot} />
          LIVE
        </span>
      </div>

      <div className={styles.hero}>
        <p className={styles.heroLabel}>Bulk product credit issued</p>
        <p className={styles.heroValue}>
          {loading ? '—' : formatPKR(stats?.bulk_credit_pkr ?? 0)}
        </p>
        <p className={styles.heroSub}>
          B2B pull-through — settled to partners in National Foods bulk product, not cash.
        </p>
      </div>

      <div className={styles.metrics}>
        <div className={styles.metric}>
          <p className={styles.metricValue}>
            {loading ? '—' : (stats?.vouchers_redeemed ?? 0).toLocaleString()}
          </p>
          <p className={styles.metricLabel}>Vouchers redeemed</p>
        </div>
        <div className={styles.metric}>
          <p className={styles.metricValue}>
            {loading ? '—' : formatPKR(stats?.consumer_value_pkr ?? 0)}
          </p>
          <p className={styles.metricLabel}>Consumer value delivered</p>
        </div>
      </div>

      <p className={styles.partnersLabel}>Top partners by redemptions</p>
      {loading ? (
        <p className={styles.empty}>Loading…</p>
      ) : stats && stats.top_partners.length > 0 ? (
        stats.top_partners.map((p, i) => (
          <div key={p.partner_id} className={styles.partnerRow}>
            <span className={styles.rank}>{i + 1}</span>
            <div className={styles.partnerMeta}>
              <p className={styles.partnerName}>{p.name}</p>
              <p className={styles.partnerArea}>{p.area}</p>
            </div>
            <div className={styles.partnerCount}>
              <p className={styles.partnerCountValue}>{p.redemptions}</p>
              <p className={styles.partnerCountLabel}>{formatPKR(p.bulk_credit_pkr)}</p>
            </div>
          </div>
        ))
      ) : (
        <p className={styles.empty}>No redemptions yet. Vouchers appear here once partners start scanning codes.</p>
      )}
    </div>
  );
}
