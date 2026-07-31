'use client';

import { useState } from 'react';
import styles from './result.module.css';
import Button from '@/components/Button';
import BilingualText from '@/components/BilingualText';
import LanguageToggle from '@/components/LanguageToggle';
import { useLanguage } from '@/components/LanguageContext';
import { useSessionJson } from '@/lib/useScanResult';
import { UI_COPY, pick } from '@/lib/verdictCopy';

interface ProductData {
  name: string;
  brand: string;
  manufacturer: string;
  category: string;
  barcode: string;
  size: string;
  referenceImage: string;
}

interface GeminiData {
  logoMatch: number;
  packagingMatch: number;
  barcodeMatch: number;
  brandMatch: number;
  designMatch: number;
  tampering: boolean;
  confidence: number;
  reason: string;
}

interface VerificationResult {
  scan_id: string;
  status: "Likely Original" | "Needs Manual Review" | "Likely Counterfeit";
  score: number;
  product: ProductData;
  gemini: GeminiData;
  apiSource: "LocalCatalog" | "ScraperMatch" | "UPCItemDB" | "OpenFoodFacts" | "BarcodeLookup" | "none";
  reason: string;
  /** Bilingual fields from /api/verify. Optional so a result cached in
   *  sessionStorage from before this change still renders. */
  reason_en?: string;
  reason_ur?: string;
  urdu_text?: string;
  english_text?: string;
  barcodeDetected: boolean;
  /** Routing metadata. Optional for the same reason as the bilingual fields —
   *  a result cached before this change still renders. */
  verificationPath?: "national_rag" | "external_db";
  brandContext?: {
    isNationalFoods: boolean;
    detectedBrand: string | null;
    source: "local_catalog" | "sku_prefix" | "vision" | "unknown";
    confidence: number;
  };
  vectorSimilarity?: number | null;
  displayVerdict?: "genuine" | "suspicious" | "counterfeit" | "unverified";
}

/** Translucent variant of a verdict colour, theme-aware. */
const tint = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export default function ResultPage() {
  // Read straight from sessionStorage rather than mirroring it into state via
  // an effect: the old pattern rendered one throwaway frame with no result and
  // tripped React's set-state-in-effect rule.
  const result = useSessionJson<VerificationResult>('shelfwatch_verify_result');
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const { lang } = useLanguage();

  const handleReport = async () => {
    if (!result?.scan_id || reported) return;
    setReporting(true);
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scan_id: result.scan_id,
          notes: `Consumer reported verification result. Status: ${result.status}, Score: ${result.score}%, Reason: ${result.reason}`,
        }),
      });
      if (res.ok || res.status === 409) {
        setReported(true);
      }
    } catch (err) {
      console.error('Failed to file user report:', err);
    } finally {
      setReporting(false);
    }
  };

  // Fallbacks if no data is available yet
  const status = result?.status || "Needs Manual Review";
  const score = result?.score !== undefined ? result.score : 75;
  const product = result?.product || {
    name: "Loading Product...",
    brand: "Unknown",
    manufacturer: "Unknown",
    category: "Unknown",
    barcode: "Unknown",
    size: "Unknown",
    referenceImage: "",
  };
  const gemini = result?.gemini || {
    logoMatch: 50,
    packagingMatch: 50,
    barcodeMatch: 50,
    brandMatch: 50,
    designMatch: 50,
    tampering: false,
    confidence: 50,
    reason: "No visual analysis details available.",
  };
  const apiSource = result?.apiSource || "none";
  const apiSourceLabels: Record<string, string> = {
    none: "None (Identified visually by Gemini)",
    LocalCatalog: "ShelfWatch Verified Catalog",
    ScraperMatch: "ShelfWatch Catalog (Image Match)",
    UPCItemDB: "UPCItemDB",
    OpenFoodFacts: "Open Food Facts",
    BarcodeLookup: "BarcodeLookup.com",
  };
  const reason = result?.reason || "Visual inspection could not be verified securely.";

  // Theme styling configurations based on status.
  const displayVerdict =
    result?.displayVerdict ??
    (status === "Likely Original"
      ? "genuine"
      : status === "Likely Counterfeit"
        ? "counterfeit"
        : "suspicious");

  let themeColor = "var(--verdict-suspicious)";
  let themeIcon = "warning";
  let statusHeadline = "NEEDS MANUAL REVIEW";
  let statusUrdu = "مشکوک";
  let statusSub = "Visual discrepancies detected. Manual check recommended.";
  let statusSubUrdu = "ظاہری تضادات پائے گئے۔ دستی جانچ کی سفارش کی جاتی ہے۔";

  if (displayVerdict === "genuine") {
    themeColor = "var(--verdict-genuine)";
    themeIcon = "verified";
    statusHeadline = "LIKELY ORIGINAL";
    statusUrdu = "اصلی";
    statusSub = "This product matches all official manufacturer specifications.";
    statusSubUrdu = "یہ مصنوع کارخانہ دار کی تمام سرکاری تفصیلات سے مطابقت رکھتی ہے۔";
  } else if (displayVerdict === "counterfeit") {
    themeColor = "var(--verdict-counterfeit)";
    themeIcon = "gpp_maybe";
    statusHeadline = "LIKELY COUNTERFEIT";
    statusUrdu = "جعلی";
    statusSub = "High packaging discrepancy indicates potential counterfeit.";
    statusSubUrdu = "پیکنگ میں نمایاں فرق ممکنہ جعل سازی کی نشاندہی کرتا ہے۔";
  } else if (displayVerdict === "unverified") {
    // Deliberately neutral, not alarming: no reference was available, which
    // is an absence of evidence rather than evidence against the product.
    themeColor = "var(--text-secondary)";
    themeIcon = "help_outline";
    statusHeadline = "UNVERIFIED";
    statusUrdu = "غیر تصدیق شدہ";
    statusSub = "No reference record was available, so authenticity could not be confirmed either way.";
    statusSubUrdu = "کوئی حوالہ جاتی ریکارڈ دستیاب نہیں تھا، اس لیے اصل ہونے کی تصدیق ممکن نہیں۔";
  }

  // Provenance line — makes the routing decision visible on screen.
  const pathLabel =
    result?.verificationPath === "national_rag"
      ? { en: "Verified against National Foods catalogue", ur: "نیشنل فوڈز کیٹلاگ کے مقابلے میں تصدیق شدہ" }
      : result?.verificationPath === "external_db"
        ? { en: "Verified against global product databases", ur: "عالمی پروڈکٹ ڈیٹا بیس کے مقابلے میں تصدیق شدہ" }
        : null;

  // Both languages stay on screen; `lang` only decides which one leads.
  const urduLeads = lang === 'ur';
  const reasonEn = result?.reason_en ?? reason;
  // Pre-bilingual cached results have no Urdu reason — show the fixed glossary
  // line rather than repeating the English sentence in the Urdu slot.
  const reasonUr = result?.reason_ur ?? statusSubUrdu;

  return (
    <>
      <header className={styles.appBar}>
        <h1 className={styles.logo}>ShelfWatch</h1>
        <div className={styles.appBarActions}>
          <LanguageToggle compact />
          <button className={`material-symbols-outlined ${styles.iconButton}`}>account_circle</button>
        </div>
      </header>

      <main className={styles.container}>
        <div className={styles.ambientGlowContainer}>
          <div className={styles.pulseAmberBig} style={{ backgroundColor: themeColor }}></div>
          <div className={styles.pulseAmberCenter} style={{ backgroundColor: themeColor }}></div>
        </div>

        {/* Verdict Hero Badge */}
        <div className={`liquid-glass-gradient-border ${styles.headerCard}`} style={{ boxShadow: `var(--glass-shadow), 0 0 40px ${tint(themeColor, 15)}` }}>
          <div
            className={styles.warningIconWrapper}
            style={{
              background: `${tint(themeColor, 13)}`,
              borderColor: `${tint(themeColor, 25)}`
            }}
          >
            <span className={`material-symbols-outlined ${styles.warningIcon}`} style={{ color: themeColor }}>
              {themeIcon}
            </span>
          </div>
          <div>
            {/* Stacked, not slashed — each language gets its own line, correct
                direction and correct font. */}
            <h2 className={styles.verdictTitle} style={{ color: themeColor }}>
              {urduLeads ? (
                <>
                  <span lang="ur" dir="rtl" className={styles.urduHeadline}>{statusUrdu}</span>
                  <span lang="en" dir="ltr" className={styles.secondaryHeadline}>{statusHeadline}</span>
                </>
              ) : (
                <>
                  <span lang="en" dir="ltr">{statusHeadline}</span>
                  <span lang="ur" dir="rtl" className={`${styles.urduHeadline} ${styles.secondaryHeadline}`}>{statusUrdu}</span>
                </>
              )}
            </h2>
            <BilingualText en={statusSub} ur={statusSubUrdu} size="sm" />

            {/* Which pipeline produced this verdict. Surfaced deliberately —
                the routing is the point of the feature, so it should be
                visible to anyone evaluating the app. */}
            {pathLabel && (
              <p className={styles.pathLabel}>
                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                  {result?.verificationPath === 'national_rag' ? 'inventory_2' : 'public'}
                </span>
                <span {...(urduLeads ? { lang: 'ur', dir: 'rtl' as const } : { lang: 'en', dir: 'ltr' as const })}>
                  {urduLeads ? pathLabel.ur : pathLabel.en}
                </span>
                {typeof result?.vectorSimilarity === 'number' && (
                  <span className={styles.pathMetric}>
                    {/* Latin digits in both languages. */}
                    {(result.vectorSimilarity * 100).toFixed(1)}% match
                  </span>
                )}
              </p>
            )}
          </div>
        </div>

        {/* Confidence & Score Section */}
        <div className={`liquid-glass-gradient-border ${styles.confidenceSection}`}>
          <div className={styles.flexBetween}>
            <span className={styles.labelCaps}>
              {pick(UI_COPY.confidence, lang)}
              {/* Score itself stays Latin digits in both languages. */}
            </span>
            <span className={styles.confidenceValue} style={{ color: themeColor }}>
              {score}%
            </span>
          </div>
          <div className={styles.flexBetween}>
            <span className={styles.labelCaps}>{pick(UI_COPY.batchCode, lang)}</span>
            <span className={styles.batchValue}>{product.barcode || '—'}</span>
          </div>
          <div className={styles.progressBarTrack}>
            <div
              className={styles.progressBarFill}
              style={{
                width: `${score}%`,
                background: `linear-gradient(to right, var(--cyan-glow), ${themeColor})`,
                boxShadow: `0 0 10px ${tint(themeColor, 50)}`
              }}
            ></div>
          </div>
          <div className={styles.analysisNote}>
            <BilingualText en={reasonEn} ur={reasonUr} size="sm" />
          </div>
        </div>

        {/* Gemini Visual Evaluation Details — telemetry bars */}
        <div className={styles.reasonsGrid}>
          {[
            { label: "Logo Accuracy", val: gemini.logoMatch },
            { label: "Brand Fonts", val: gemini.brandMatch },
            { label: "Design Layout", val: gemini.designMatch },
            { label: "Packaging Shell", val: gemini.packagingMatch },
          ].map((item, idx) => {
            const barColor = item.val >= 80 ? 'var(--verdict-genuine)' : item.val >= 50 ? 'var(--verdict-suspicious)' : 'var(--verdict-counterfeit)';
            return (
              <div key={idx} className={`liquid-glass ${styles.reasonChip}`}>
                <div className={styles.reasonChipHeader}>
                  <span className={styles.labelCaps} style={{ fontSize: '10px' }}>{item.label}</span>
                  <span className={styles.reasonChipValue}>{item.val}%</span>
                </div>
                <div className={styles.telemetryTrack}>
                  <div
                    className={styles.telemetryFill}
                    style={{ width: `${item.val}%`, background: `linear-gradient(to right, var(--cyan-glow), ${barColor})` }}
                  ></div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Product Details Snapshot */}
        <div className={`liquid-glass ${styles.productSnapshot}`}>
          {product.referenceImage && (
            <div
              className={styles.snapshotImage}
              style={{ backgroundImage: `url('${product.referenceImage}')`, height: '12rem' }}
            ></div>
          )}
          <div className={styles.snapshotDetails}>
            <div>
              <p className={styles.labelCaps}>Product</p>
              <p className={styles.detailValue}>{product.name}</p>
            </div>
            <div>
              <p className={styles.labelCaps}>Brand</p>
              <p className={styles.detailValue}>{product.brand}</p>
            </div>
            <div>
              <p className={styles.labelCaps}>Manufacturer</p>
              <p className={styles.detailValue}>{product.manufacturer}</p>
            </div>
            <div>
              <p className={styles.labelCaps}>Category</p>
              <p className={styles.detailValue}>{product.category}</p>
            </div>
            <div>
              <p className={styles.labelCaps}>Barcode No.</p>
              <p className={`${styles.detailValue} ${styles.mono}`}>{product.barcode}</p>
            </div>
            <div>
              <p className={styles.labelCaps}>Net Quantity</p>
              <p className={styles.detailValue}>{product.size || "Standard"}</p>
            </div>
            <div style={{ gridColumn: 'span 2' }}>
              <p className={styles.labelCaps}>API Lookup Source</p>
              <p className={styles.detailValue} style={{ color: 'var(--cyan-glow)' }}>
                {apiSourceLabels[apiSource] || apiSource}
              </p>
            </div>
          </div>
        </div>

        {/* Action Warning Notice */}
        {status !== "Likely Original" ? (
          <div
            className={styles.urgentWarning}
            style={{
              background: `${tint(themeColor, 12)}`,
              border: `1px solid ${tint(themeColor, 30)}`
            }}
          >
            <span className="material-symbols-outlined" style={{ color: themeColor, marginTop: '2px', fontVariationSettings: "'FILL' 1" }}>
              gpp_maybe
            </span>
            <div>
              <p className={styles.warningTitle} style={{ color: themeColor }}>
                {status === "Likely Counterfeit" ? "Critical Counterfeit Warning" : "Suspicious Anomaly Alert"}
              </p>
              <p className={styles.warningBody}>
                {status === "Likely Counterfeit" 
                  ? "This product shows high discrepancy indicators. Do not consume or sell. Isolate the packaging immediately." 
                  : "Some packaging fonts and logo coordinates deviate from official specs. Manual verification is advised."}
              </p>
            </div>
          </div>
        ) : (
          <div
            className={styles.urgentWarning}
            style={{
              background: `${tint(themeColor, 10)}`,
              border: `1px solid ${tint(themeColor, 25)}`
            }}
          >
            <span className="material-symbols-outlined" style={{ color: themeColor, marginTop: '2px', fontVariationSettings: "'FILL' 1" }}>
              verified_user
            </span>
            <div>
              <p className={styles.warningTitle} style={{ color: themeColor }}>Product Authenticated</p>
              <p className={styles.warningBody}>The visual profile, packaging design, and barcode verify cleanly against manufacturer reference metrics.</p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className={styles.actions}>
          <Button href="/scan" variant="primary" icon="qr_code_scanner" fullWidth>
            Scan Another
          </Button>
          <Button
            variant="danger"
            icon={reported ? 'check_circle' : 'report'}
            onClick={handleReport}
            disabled={reporting || reported}
            fullWidth
          >
            {reported ? 'Reported!' : reporting ? 'Reporting...' : 'Report Discrepancy'}
          </Button>
        </div>
        {result?.scan_id && (
          <p className={styles.scanIdNote}>Scan ID: {result.scan_id}</p>
        )}
      </main>
    </>
  );
}
