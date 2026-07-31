'use client';

import { useState } from 'react';
import Link from 'next/link';
import styles from './unverified.module.css';
import { postReport } from '@/lib/api';
import VerdictBadge from '@/components/VerdictBadge';
import BilingualText from '@/components/BilingualText';
import NoScanResult from '@/components/NoScanResult';
import { useLanguage } from '@/components/LanguageContext';
import { useScanResult } from '@/lib/useScanResult';
import { VERDICT_PHRASE, UI_COPY, pick } from '@/lib/verdictCopy';

export default function UnverifiedResultPage() {
  const result = useScanResult();
  const { lang } = useLanguage();
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReport = async () => {
    if (!result?.scan_id) return;
    setReporting(true);
    setError(null);
    const res = await postReport(result.scan_id, 'Unverified product reported by consumer');
    setReporting(false);
    if (res.error) {
      setError(res.error);
    } else {
      setReported(true);
    }
  };

  // Hooks must run before this branch, so the guard sits below them. The
  // fallback confidence was 45% — a fabricated score for a scan that never
  // happened; this page now refuses to render without a real result.
  if (!result) return <NoScanResult title="No verification to show" />;

  const confidence = Math.round(result.confidence * 100);
  // These fallbacks stay: "unknown" IS the honest answer on this screen, which
  // exists precisely because the product could not be matched.
  const barcode = result.extracted_batch || 'Unknown Batch';
  const productName = result.product_name || 'Unregistered Product';
  const brandName = result.brand_name || 'Unknown Brand';

  return (
    <div className={styles.page}>
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
        <div className={styles.iconWrapper}>
          <div className={styles.iconCenter}>
            <span className="material-symbols-outlined">help_outline</span>
          </div>
        </div>

        <VerdictBadge verdict="unverified" size="lg" />
        <div className={styles.verdictSub}>
          <BilingualText
            en={VERDICT_PHRASE.unverified.en}
            ur={VERDICT_PHRASE.unverified.ur}
            size="sm"
          />
        </div>

        {/* Reason — bilingual, from the scan payload when present. */}
        <div className={styles.verdictSub}>
          <BilingualText
            en={result?.reason ?? 'Product could not be matched in our database.'}
            ur={result?.reason_ur ?? 'یہ مصنوع ہمارے ڈیٹا بیس میں نہیں مل سکی۔'}
            size="sm"
          />
        </div>

        {/* Confidence */}
        <div className={styles.confidenceCard}>
          <div className={styles.confRow}>
            <span className={styles.confLabel}>{pick(UI_COPY.confidence, lang)}</span>
            {/* Latin digits in both languages. */}
            <span className={styles.confValue}>{confidence}%</span>
          </div>
          <div className={styles.confTrack}>
            <div className={styles.confFill} style={{ width: `${confidence}%` }}></div>
          </div>
        </div>

        {/* Product info */}
        <div className={styles.detailsCard}>
          <p className={styles.sectionLabel}>Scanned Product</p>
          <div className={styles.detailsGrid}>
            {[
              { label: 'Product Name', value: productName },
              { label: 'Brand', value: brandName },
              { label: 'Batch/Barcode', value: barcode },
              ...(result?.extracted_mfg_date ? [{ label: 'Mfg Date', value: result.extracted_mfg_date }] : []),
              ...(result?.extracted_mrp ? [{ label: 'MRP', value: `Rs. ${result.extracted_mrp}` }] : []),
            ].map((d, i) => (
              <div key={i} className={styles.detailItem}>
                <p className={styles.detailLabel}>{d.label}</p>
                <p className={styles.detailValue}>{d.value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Error notification if report fails */}
        {error && (
          <p style={{ color: 'var(--color-error)', fontSize: '13px', margin: '8px 16px', textAlign: 'center' }}>
            {error}
          </p>
        )}

        {/* Notice */}
        <div className={styles.notice}>
          <span className="material-symbols-outlined" style={{ color: 'var(--color-on-surface-variant)', fontSize: '20px', flexShrink: 0 }}>info</span>
          <p>{result?.reason || 'This product could not be matched in our database. It may be authentic but unregistered. Contact the brand directly to verify.'}</p>
        </div>

        {/* Actions */}
        <div className={styles.actions}>
          <button
            className={styles.primaryBtn}
            onClick={handleReport}
            disabled={reporting || reported}
            style={{ opacity: reported ? 0.6 : 1 }}
          >
            <span className="material-symbols-outlined">{reported ? 'check_circle' : 'report'}</span>
            {reported ? 'Reported!' : reporting ? 'Reporting...' : 'Report to Brand'}
          </button>
          <Link href="/scan" className={styles.secondaryBtn}>
            <span className="material-symbols-outlined">qr_code_scanner</span>
            Scan Again
          </Link>
        </div>
      </main>
    </div>
  );
}
