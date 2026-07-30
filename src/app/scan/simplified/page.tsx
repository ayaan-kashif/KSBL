'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from './simplified.module.css';
import { readScanResult, ScanResult, formatConfidence } from '@/lib/api';
import VerdictBadge from '@/components/VerdictBadge';
import BilingualText from '@/components/BilingualText';
import { useLanguage } from '@/components/LanguageContext';
import { VERDICT_PHRASE, UI_COPY, pick } from '@/lib/verdictCopy';

export default function SimplifiedVerdictPage() {
  const [result, setResult] = useState<ScanResult | null>(null);
  const { lang } = useLanguage();

  useEffect(() => {
    const data = readScanResult();
    if (data) {
      setResult(data);
    }
  }, []);

  const confidence = result ? Math.round(result.confidence * 100) : 99;
  const product = result?.product_name || 'Surf Excel Matic Front Load 1kg';
  const brand = result?.brand_name || 'Unilever Pakistan';

  return (
    <div className={styles.page}>
      <div className={styles.bgOrb}></div>

      <header className={styles.appBar}>
        <Link href="/scan" className={styles.backBtn}>
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <h1 className={styles.appBarTitle}>Verification Result</h1>
        <button className={styles.shareBtn}>
          <span className="material-symbols-outlined">share</span>
        </button>
      </header>

      <main className={styles.main}>
        <div className={styles.verdictIcon}>
          <div className={styles.iconRing}></div>
          <div className={styles.iconRing2}></div>
          <div className={styles.iconCenter}>
            <span className="material-symbols-outlined">verified</span>
          </div>
        </div>

        <VerdictBadge verdict="genuine" size="lg" />
        <div className={styles.verdictCopy}>
          <BilingualText
            en={VERDICT_PHRASE.genuine.en}
            ur={VERDICT_PHRASE.genuine.ur}
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
              {result?.extracted_mfg_date ? `${result.extracted_mfg_date} ✓` : 'Valid Expiry ✓'}
            </span>
          </div>
        </div>

        <div className={styles.message}>
          <BilingualText
            en={result?.reason ?? 'This product has been verified as authentic by ShelfWatch AI. Safe to purchase and consume.'}
            ur={result?.reason_ur ?? 'شیلف واچ اے آئی نے اس مصنوع کی اصل ہونے کی تصدیق کی ہے۔ خریدنا اور استعمال کرنا محفوظ ہے۔'}
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
