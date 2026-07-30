'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './rewards.module.css';
import BottomNav from '@/components/BottomNav';
import { useLanguage } from '@/components/LanguageContext';
import { URDU_ATTRS } from '@/lib/verdictCopy';
import {
  getRewards,
  getMe,
  postRedeemReward,
  formatPKR,
  type RewardOffer,
  type CustomerProfile,
} from '@/lib/api';

export default function RewardsPage() {
  const router = useRouter();
  const { lang } = useLanguage();
  const urduLeads = lang === 'ur';

  const [offers, setOffers] = useState<RewardOffer[]>([]);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [confirming, setConfirming] = useState<RewardOffer | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const [sheetError, setSheetError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const [offersRes, meRes] = await Promise.all([getRewards(), getMe()]);
      setLoading(false);
      if (offersRes.error) setError(offersRes.error);
      else if (offersRes.data) setOffers(offersRes.data);
      if (meRes.data) setProfile(meRes.data);
    }
    load();
  }, []);

  const balance = profile?.score_points ?? 0;

  async function handleConfirm() {
    if (!confirming || redeeming) return;
    setRedeeming(true);
    setSheetError(null);

    const res = await postRedeemReward(confirming.id);
    if (res.error) {
      setRedeeming(false);
      setSheetError(res.error);
      // The balance moved under us (another tab, or a scan landed) — resync so
      // the catalog stops offering something the customer can't afford.
      if (res.shortfall) setProfile((p) => (p ? { ...p, score_points: res.shortfall!.balance } : p));
      return;
    }
    router.push('/wallet');
  }

  return (
    <div className={styles.page}>
      <header className={styles.appBar}>
        <div className={styles.appBarTop}>
          <div>
            <h1 className={styles.appBarTitle}>{urduLeads ? 'انعامات' : 'Rewards'}</h1>
            <p className={styles.appBarTitleUr} {...(urduLeads ? {} : URDU_ATTRS)}>
              {urduLeads ? 'Rewards' : 'انعامات'}
            </p>
          </div>
          <Link href="/wallet" className={styles.walletLink}>
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
              wallet
            </span>
            {urduLeads ? 'والٹ' : 'Wallet'}
          </Link>
        </div>

        <div className={styles.balanceRow}>
          <span className={styles.balanceValue}>{balance.toLocaleString()}</span>
          <span className={styles.balanceLabel}>points available</span>
          <span className={styles.balanceLabelUr} {...URDU_ATTRS}>
            دستیاب پوائنٹس
          </span>
        </div>
      </header>

      <main>
        {loading && (
          <div className={styles.state}>
            <span className={`material-symbols-outlined ${styles.stateIcon}`}>hourglass_top</span>
            <p className={styles.stateTitle}>Loading rewards…</p>
          </div>
        )}

        {!loading && error && (
          <div className={styles.state}>
            <span className={`material-symbols-outlined ${styles.stateIcon}`}>error_outline</span>
            <p className={styles.stateTitle}>Couldn&apos;t load rewards</p>
            <p className={styles.stateText}>{error}</p>
          </div>
        )}

        {!loading && !error && offers.length === 0 && (
          <div className={styles.state}>
            <span className={`material-symbols-outlined ${styles.stateIcon}`}>redeem</span>
            <p className={styles.stateTitle}>No rewards available yet</p>
            <p className={styles.stateText}>Check back soon — partner restaurants are being added.</p>
          </div>
        )}

        {!loading && !error && offers.length > 0 && (
          <div className={styles.list}>
            {offers.map((offer) => {
              const affordable = balance >= offer.points_cost;
              const shortfall = offer.points_cost - balance;
              const partner = offer.partner;

              return (
                <article
                  key={offer.id}
                  className={`${styles.card} ${affordable ? '' : styles.cardLocked}`}
                >
                  <div className={styles.cardHead}>
                    {partner?.logo_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={partner.logo_url} alt="" className={styles.logo} />
                    ) : (
                      <div className={`${styles.logo} ${styles.logoFallback}`} aria-hidden="true">
                        {partner?.name?.charAt(0) ?? '?'}
                      </div>
                    )}
                    <div className={styles.partnerMeta}>
                      <p className={styles.partnerName}>{partner?.name ?? 'Partner restaurant'}</p>
                      <p className={styles.partnerSub}>
                        <span>{partner?.area}</span>
                        <span className={styles.dot} />
                        <span>{partner?.cuisine}</span>
                      </p>
                    </div>
                  </div>

                  <span className={styles.nflBadge}>
                    <span className={`material-symbols-outlined ${styles.nflBadgeIcon}`}>verified</span>
                    Cooks with National Foods
                  </span>

                  <h2 className={styles.offerTitle}>{urduLeads ? offer.title_ur : offer.title_en}</h2>
                  <p className={styles.offerTitleUr} {...(urduLeads ? {} : URDU_ATTRS)}>
                    {urduLeads ? offer.title_en : offer.title_ur}
                  </p>
                  <p className={styles.offerDesc}>
                    {urduLeads ? offer.description_ur : offer.description_en}
                  </p>
                  <p className={styles.offerDescUr} {...(urduLeads ? {} : URDU_ATTRS)}>
                    {urduLeads ? offer.description_en : offer.description_ur}
                  </p>

                  <div className={styles.offerFoot}>
                    <div className={styles.costBlock}>
                      <p className={styles.cost}>
                        {offer.points_cost.toLocaleString()}
                        <span className={styles.costUnit}>points</span>
                      </p>
                      <p className={styles.worth}>Worth {formatPKR(offer.consumer_value_pkr)}</p>
                    </div>

                    {affordable ? (
                      <button
                        type="button"
                        className={styles.redeemBtn}
                        onClick={() => {
                          setSheetError(null);
                          setConfirming(offer);
                        }}
                      >
                        Redeem
                      </button>
                    ) : (
                      <span className={styles.lockedChip}>
                        <span className={`material-symbols-outlined ${styles.lockedIcon}`}>lock</span>
                        {shortfall.toLocaleString()} more points
                      </span>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {confirming && (
        <div
          className={styles.sheetBackdrop}
          onClick={() => !redeeming && setConfirming(null)}
          role="presentation"
        >
          <div
            className={styles.sheet}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Confirm redemption"
          >
            <div className={styles.sheetGrip} />
            <h2 className={styles.sheetTitle}>
              {urduLeads ? 'انعام حاصل کریں؟' : 'Redeem this reward?'}
            </h2>
            <p className={styles.sheetTitleUr} {...(urduLeads ? {} : URDU_ATTRS)}>
              {urduLeads ? 'Redeem this reward?' : 'انعام حاصل کریں؟'}
            </p>

            <div className={styles.sheetSummary}>
              <div className={styles.sheetRow}>
                <span className={styles.sheetRowLabel}>Reward</span>
                <span className={styles.sheetRowValue}>{confirming.title_en}</span>
              </div>
              <div className={styles.sheetRow}>
                <span className={styles.sheetRowLabel}>At</span>
                <span className={styles.sheetRowValue}>{confirming.partner?.name}</span>
              </div>
              <div className={styles.sheetRow}>
                <span className={styles.sheetRowLabel}>Cost</span>
                <span className={styles.sheetRowValue}>
                  −{confirming.points_cost.toLocaleString()} pts
                </span>
              </div>
              <div className={`${styles.sheetRow} ${styles.sheetRowDivider}`}>
                <span className={styles.sheetRowLabel}>Balance after</span>
                <span className={styles.sheetRowValue}>
                  {(balance - confirming.points_cost).toLocaleString()} pts
                </span>
              </div>
            </div>

            {sheetError && <p className={styles.sheetError}>{sheetError}</p>}

            <div className={styles.sheetActions}>
              <button
                type="button"
                className={styles.sheetCancel}
                onClick={() => setConfirming(null)}
                disabled={redeeming}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.sheetConfirm}
                onClick={handleConfirm}
                disabled={redeeming}
              >
                {redeeming ? 'Redeeming…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      <BottomNav />
    </div>
  );
}
