'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import QRCode from 'qrcode';
import styles from './wallet.module.css';
import BottomNav from '@/components/BottomNav';
import { useLanguage } from '@/components/LanguageContext';
import { URDU_ATTRS } from '@/lib/verdictCopy';
import { getMyVouchers, daysUntil, formatPKR, type Voucher, type VoucherStatus } from '@/lib/api';

const STATUS_CHIP: Record<VoucherStatus, { className: string; icon: string; en: string; ur: string }> = {
  issued: { className: 'statusIssued', icon: 'check_circle', en: 'Active', ur: 'فعال' },
  redeemed: { className: 'statusRedeemed', icon: 'task_alt', en: 'Redeemed', ur: 'استعمال شدہ' },
  expired: { className: 'statusExpired', icon: 'schedule', en: 'Expired', ur: 'میعاد ختم' },
};

export default function WalletPage() {
  const { lang } = useLanguage();
  const urduLeads = lang === 'ur';

  const [vouchers, setVouchers] = useState<Voucher[]>([]);
  const [qrByCode, setQrByCode] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const res = await getMyVouchers();
      setLoading(false);
      if (res.error) {
        setError(res.error);
        return;
      }
      const list = res.data ?? [];
      setVouchers(list);

      // QR is a convenience layer over the code, never a replacement — the
      // 8-char string is the redemption mechanism and is always shown.
      const active = list.filter((v) => v.status === 'issued');
      const pairs = await Promise.all(
        active.map(async (v) => {
          try {
            return [v.code, await QRCode.toDataURL(v.code, { margin: 1, width: 232 })] as const;
          } catch {
            return null;
          }
        })
      );
      setQrByCode(Object.fromEntries(pairs.filter((p): p is readonly [string, string] => p !== null)));
    }
    load();
  }, []);

  // Active first, then spent/lapsed — both groups newest-first within
  // themselves (the API already returns issued_at desc).
  const active = vouchers.filter((v) => v.status === 'issued');
  const inactive = vouchers.filter((v) => v.status !== 'issued');

  function renderCard(v: Voucher) {
    const chip = STATUS_CHIP[v.status];
    const isActive = v.status === 'issued';
    const days = daysUntil(v.expires_at);
    const partner = v.offer?.partner;

    return (
      <article key={v.id} className={`${styles.card} ${isActive ? '' : styles.cardInactive}`}>
        <div className={styles.cardTop}>
          <div>
            <p className={styles.partnerName}>{partner?.name ?? 'Partner restaurant'}</p>
            <p className={styles.offerTitle}>
              {urduLeads ? v.offer?.title_ur : v.offer?.title_en}
            </p>
            <p className={styles.offerTitleUr} {...(urduLeads ? {} : URDU_ATTRS)}>
              {urduLeads ? v.offer?.title_en : v.offer?.title_ur}
            </p>
          </div>
          <span className={`${styles.statusChip} ${styles[chip.className]}`}>
            <span className={`material-symbols-outlined ${styles.chipIcon}`}>{chip.icon}</span>
            {urduLeads ? chip.ur : chip.en}
          </span>
        </div>

        <div className={styles.codeBlock}>
          <p className={styles.codeLabel}>Voucher code</p>
          <p className={`${styles.code} ${isActive ? '' : styles.codeInactive}`}>{v.code}</p>
          {isActive && qrByCode[v.code] && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrByCode[v.code]} alt={`QR code for voucher ${v.code}`} className={styles.qr} />
          )}
        </div>

        <div className={styles.cardFoot}>
          <span className={isActive ? styles.footValue : styles.footValueInactive}>
            {v.offer ? `Worth ${formatPKR(v.offer.consumer_value_pkr)}` : ''}
          </span>
          {v.status === 'redeemed' ? (
            <span className={styles.expiry}>
              Redeemed {v.redeemed_at ? new Date(v.redeemed_at).toLocaleDateString() : ''}
            </span>
          ) : v.status === 'expired' ? (
            <span className={styles.expiry}>
              Expired {new Date(v.expires_at).toLocaleDateString()}
            </span>
          ) : (
            <span className={`${styles.expiry} ${days <= 5 ? styles.expirySoon : ''}`}>
              {days <= 0
                ? 'Expires today'
                : `Expires in ${days} day${days === 1 ? '' : 's'}`}
            </span>
          )}
        </div>
      </article>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.appBar}>
        <div>
          <h1 className={styles.appBarTitle}>{urduLeads ? 'میرا والٹ' : 'My Wallet'}</h1>
          <p className={styles.appBarTitleUr} {...(urduLeads ? {} : URDU_ATTRS)}>
            {urduLeads ? 'My Wallet' : 'میرا والٹ'}
          </p>
        </div>
        <Link href="/rewards" className={styles.rewardsLink}>
          <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
            redeem
          </span>
          {urduLeads ? 'انعامات' : 'Rewards'}
        </Link>
      </header>

      <main>
        {loading && (
          <div className={styles.state}>
            <span className={`material-symbols-outlined ${styles.stateIcon}`}>hourglass_top</span>
            <p className={styles.stateTitle}>Loading your vouchers…</p>
          </div>
        )}

        {!loading && error && (
          <div className={styles.state}>
            <span className={`material-symbols-outlined ${styles.stateIcon}`}>error_outline</span>
            <p className={styles.stateTitle}>Couldn&apos;t load your wallet</p>
            <p className={styles.stateText}>{error}</p>
          </div>
        )}

        {!loading && !error && vouchers.length === 0 && (
          <div className={styles.state}>
            <span className={`material-symbols-outlined ${styles.stateIcon}`}>wallet</span>
            <p className={styles.stateTitle}>No vouchers yet</p>
            <p className={styles.stateText}>
              Scan products to earn points, then redeem them for dining rewards at partner
              restaurants.
            </p>
            <Link href="/rewards" className={styles.stateLink}>
              Browse rewards
            </Link>
          </div>
        )}

        {!loading && !error && active.length > 0 && <div className={styles.list}>{active.map(renderCard)}</div>}

        {!loading && !error && inactive.length > 0 && (
          <>
            <p className={styles.sectionLabel}>Past vouchers</p>
            <div className={styles.list}>{inactive.map(renderCard)}</div>
          </>
        )}
      </main>

      <BottomNav />
    </div>
  );
}
