'use client';

import Link from 'next/link';
import styles from './simplified.module.css';
import VerdictBadge from '@/components/VerdictBadge';
import BilingualText from '@/components/BilingualText';
import NoScanResult from '@/components/NoScanResult';
import { useLanguage } from '@/components/LanguageContext';
import { useScanResult } from '@/lib/useScanResult';
import { VERDICT_PHRASE, UI_COPY, pick } from '@/lib/verdictCopy';

export default function SimplifiedVerdictPage() {
  const result = useScanResult();
  const { lang } = useLanguage();

  // Without a stored result this page previously invented one — a hardcoded
  // "99% · Surf Excel Matic Front Load 1kg · Unilever Pakistan" genuine
  // verdict for a product nobody scanned.
  if (!result) return <NoScanResult title="No verification to show" />;

  const confidence = Math.round(result.confidence * 100);
  // The badge used to be pinned to "genuine" regardless of what was scanned.
  // These pages are reachable by direct URL, so that would have shown a
  // suspicious product as authentic. Everything below follows the real verdict.
  const verdict = result.verdict;
  const isGenuine = verdict === 'genuine';
  const verdictIcon = isGenuine ? 'verified' : verdict === 'suspicious' ? 'gpp_maybe' : 'help_outline';
  const product = result.product_name || 'Unidentified product';
  const brand = result.brand_name || 'Unknown brand';

  return (
    <div className={styles.page}>
      <div className={styles.bgOrb}></div>

      <header className={styles.appBar}>
        <Link href="/scan" className={styles.backBtn} aria-label="Back to scanner">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <h1 className={styles.appBarTitle}>Verification Result</h1>
        <button className={styles.shareBtn} aria-label="Share result">
          <span className="material-symbols-outlined">share</span>
        </button>
      </header>

      <main className={styles.main}>
        <div className={styles.verdictIcon}>
          <div className={styles.iconRing}></div>
          <div className={styles.iconRing2}></div>
          <div className={styles.iconCenter}>
            <span className="material-symbols-outlined">{verdictIcon}</span>
          </div>
        </div>

        <VerdictBadge verdict={verdict} size="lg" />
        <div className={styles.verdictCopy}>
          <BilingualText
            en={VERDICT_PHRASE[verdict].en}
            ur={VERDICT_PHRASE[verdict].ur}
            size="sm"
          />
        </div>

        <div className={styles.confBadge}>
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>analytics</span>
          {/* Score stays in Latin digits in both languages. */}
          {confidence}% {pick(UI_COPY.confidence, lang)}
        </div>

        <div className={styles.detailCard}>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Product</span>
            <span className={styles.detailValue}>{product}</span>
          </div>
          <div className={styles.divider}></div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Brand</span>
            <span className={styles.detailValue}>{brand}</span>
          </div>
          <div className={styles.divider}></div>
          <div className={styles.detailRow}>
            <span className={styles.detailLabel}>Expiry</span>
            <span className={styles.detailValue} style={{ color: 'var(--color-primary)' }}>
              {result.extracted_mfg_date ? `${result.extracted_mfg_date} ✓` : 'Not detected'}
            </span>
          </div>
        </div>

        <div className={styles.message}>
          <BilingualText
            en={result.reason}
            ur={result.reason_ur ?? result.reason}
            size="sm"
          />
        </div>

        <div className={styles.actions}>
          <Link href="/scan" className={styles.primaryBtn}>
            <span className="material-symbols-outlined">qr_code_scanner</span>
            Scan Another
          </Link>
          <Link href="/scan/genuine" className={styles.secondaryBtn}>
            <span className="material-symbols-outlined">open_in_new</span>
            Full Report
          </Link>
        </div>
      </main>
    </div>
  );
}
