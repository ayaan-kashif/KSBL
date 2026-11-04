'use client';

import Link from 'next/link';
import styles from './genuine.module.css';
import VerdictBadge from '@/components/VerdictBadge';
import BilingualText from '@/components/BilingualText';
import NoScanResult from '@/components/NoScanResult';
import { useLanguage } from '@/components/LanguageContext';
import { useScanResult } from '@/lib/useScanResult';
import { VERDICT_PHRASE, UI_COPY, MEDICINE_COPY, pick } from '@/lib/verdictCopy';
import { medicineDetailRows, medicineSourcesLine, isMedicineNoProblems } from '@/lib/medicineView';

export default function GenuineResultPage() {
  const result = useScanResult();
  const { lang } = useLanguage();

  // Without a stored result this page previously invented one — a hardcoded
  // "99% · HP-221-KHI · HealthCare Pro 500mg" genuine verdict for a product
  // nobody scanned. Refusing to render is the only safe behaviour here.
  if (!result) return <NoScanResult title="No verification to show" />;

  const confidence = Math.round(result.confidence * 100);
  // The badge used to be pinned to "genuine" regardless of what was scanned.
  // These pages are reachable by direct URL, so that would have shown a
  // suspicious product as authentic. Everything below follows the real verdict.
  const verdict = result.verdict;
  const isGenuine = verdict === 'genuine';
  const verdictIcon = isGenuine ? 'verified' : verdict === 'suspicious' ? 'gpp_maybe' : 'help_outline';
  const batch = result.extracted_batch ?? 'Not detected';
  const product = result.product_name ?? 'Unidentified product';
  const brand = result.brand_name ?? 'Unknown brand';
  // Medicines: never "Genuine" — "No problems found", pending DRAP's official
  // verification — and their own phrases, checks and detail rows.
  const medicine = result.medicine ?? null;
  const medicineNoProblems = isMedicineNoProblems(medicine);
  const medicineSources = medicine ? medicineSourcesLine(medicine) : null;
  const phrase = medicine ? { en: result.english_text, ur: result.urdu_text } : VERDICT_PHRASE[verdict];

  return (
    <div className={styles.page}>
      <div className={styles.bgGlow}></div>

      <header className={styles.topBar}>
        <Link href="/scan" className={styles.backBtn} aria-label="Back to scanner">
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <h1 className={styles.pageTitle}>Verification Result</h1>
        <button className={styles.shareBtn} aria-label="Share result">
          <span className="material-symbols-outlined">share</span>
        </button>
      </header>

      <main className={styles.main}>
        {/* Glowing verified icon */}
        <div className={styles.iconWrapper}>
          <div className={styles.iconRingOuter}></div>
          <div className={styles.iconRingInner}></div>
          <div className={styles.iconCenter}>
            <span className="material-symbols-outlined">{verdictIcon}</span>
          </div>
        </div>

        <VerdictBadge verdict={verdict} size="lg" label={medicineNoProblems ? MEDICINE_COPY.noProblemsLabel : undefined} />
        <div className={styles.verdictSub}>
          <BilingualText
            en={phrase.en}
            ur={phrase.ur}
            size="sm"
          />
        </div>

        {/* Reason — bilingual, from the scan payload when present. */}
        <div className={styles.verdictSub}>
          {medicine?.expiry?.expired && (
            <BilingualText en={MEDICINE_COPY.expired.en} ur={MEDICINE_COPY.expired.ur} size="md" />
          )}
          <BilingualText
            en={result.reason}
            ur={result.reason_ur ?? result.reason}
            size="sm"
          />
          {medicine?.checks?.map((check) => (
            <BilingualText key={check.id} en={check.en} ur={check.ur} size="sm" />
          ))}
          {result.barcode_check && (
            <BilingualText en={result.barcode_check.en} ur={result.barcode_check.ur} size="sm" />
          )}
          {medicineSources && <BilingualText en={medicineSources.en} ur={medicineSources.ur} size="sm" />}
          {medicine && <BilingualText en={MEDICINE_COPY.safety.en} ur={MEDICINE_COPY.safety.ur} size="sm" />}
        </div>

        {/* Confidence meter */}
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

        {/* Product details */}
        <div className={styles.detailsCard}>
          <p className={styles.sectionLabel}>Product Information</p>
          <div className={styles.detailsGrid}>
            {(medicine
              ? medicineDetailRows(medicine).map((row) => ({ label: pick(row.label, lang), value: pick(row.value, lang) }))
              : [
              { label: 'Product', value: product },
              { label: 'Brand', value: brand },
              { label: 'Batch No.', value: batch },
              ...(result.extracted_mfg_date ? [{ label: 'Mfg Date', value: result.extracted_mfg_date }] : []),
              ...(result.extracted_mrp ? [{ label: 'MRP', value: `Rs. ${result.extracted_mrp}` }] : []),
            ]).map((d, i) => (
              <div key={i} className={styles.detailItem}>
                <p className={styles.detailLabel}>{d.label}</p>
                <p className={styles.detailValue}>{d.value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Reassurance note — genuine verdicts only. Shown unconditionally it
            would tell someone holding a suspicious product that it is safe.
            The copy also used to claim "24M+ authentic products", an invented
            catalogue size; it now states what the pipeline actually did. */}
        {isGenuine && (
          <div className={styles.successNote}>
            <span className="material-symbols-outlined" style={{ fontSize: '20px', flexShrink: 0 }}>check_circle</span>
            <p>
              {medicineNoProblems
                ? `${pick(MEDICINE_COPY.noProblemsLabel, lang)} — ${pick(MEDICINE_COPY.officialPending, lang)}`
                : <>Checked against ShelfWatch&apos;s reference catalogue and packaging analysis.</>}
            </p>
          </div>
        )}

        {/* Actions */}
        <div className={styles.actions}>
          <Link href="/scan" className={styles.secondaryBtn}>
            <span className="material-symbols-outlined">qr_code_scanner</span>
            Scan Another
          </Link>
          <Link href="/scan/simplified" className={styles.primaryBtn}>
            <span className="material-symbols-outlined">open_in_new</span>
            Full Report
          </Link>
        </div>
      </main>

      <nav className={styles.bottomNav}>
        <Link href="/" className={styles.navItem}>
          <span className="material-symbols-outlined">home</span>
          <span>Home</span>
        </Link>
        <Link href="/scan" className={styles.navItem}>
          <span className="material-symbols-outlined">qr_code_scanner</span>
          <span>Scan</span>
        </Link>
        <Link href="/scan/history" className={styles.navItem}>
          <span className="material-symbols-outlined">history</span>
          <span>History</span>
        </Link>
        <Link href="/login" className={styles.navItem}>
          <span className="material-symbols-outlined">person</span>
          <span>Profile</span>
        </Link>
      </nav>
    </div>
  );
}
