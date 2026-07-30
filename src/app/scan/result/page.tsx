'use client';

import { useEffect, useState } from 'react';
import styles from './result.module.css';
import Button from '@/components/Button';

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
  barcodeDetected: boolean;
}

export default function ResultPage() {
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);

  useEffect(() => {
    const stored = sessionStorage.getItem('shelfwatch_verify_result');
    if (stored) {
      try {
        setResult(JSON.parse(stored));
      } catch (err) {
        console.error('Failed to parse verification result from sessionStorage:', err);
      }
    }
  }, []);

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
  // NOTE: themeColor is a plain hex value (matching the --verdict-* tokens in
  // globals.css) rather than a var() reference, because it gets alpha-suffixed
  // below (`${themeColor}40`) to derive translucent fills/borders — that
  // hex-alpha trick only works on literal hex colors, not on var() calls.
  let themeColor = "#b45309"; // --verdict-suspicious
  let themeIcon = "warning";
  let statusHeadline = "NEEDS MANUAL REVIEW";
  let statusUrdu = "مشکوک";
  let statusSub = "Visual discrepancies detected. Manual check recommended.";

  if (status === "Likely Original") {
    themeColor = "#047857"; // --verdict-genuine
    themeIcon = "verified";
    statusHeadline = "LIKELY ORIGINAL";
    statusUrdu = "اصلی";
    statusSub = "This product matches all official manufacturer specifications.";
  } else if (status === "Likely Counterfeit") {
    themeColor = "#be123c"; // --verdict-counterfeit
    themeIcon = "gpp_maybe";
    statusHeadline = "LIKELY COUNTERFEIT";
    statusUrdu = "جعلی";
    statusSub = "High packaging discrepancy indicates potential counterfeit.";
  }

  return (
    <>
      <header className={styles.appBar}>
        <h1 className={styles.logo}>ShelfWatch</h1>
        <div className={styles.appBarActions}>
          <button className={`material-symbols-outlined ${styles.iconButton}`}>language</button>
          <button className={`material-symbols-outlined ${styles.iconButton}`}>account_circle</button>
        </div>
      </header>

      <main className={styles.container}>
        <div className={styles.ambientGlowContainer}>
          <div className={styles.pulseAmberBig} style={{ backgroundColor: themeColor }}></div>
          <div className={styles.pulseAmberCenter} style={{ backgroundColor: themeColor }}></div>
        </div>

        {/* Verdict Hero Badge */}
        <div className={`liquid-glass-gradient-border ${styles.headerCard}`} style={{ boxShadow: `var(--glass-shadow), 0 0 40px ${themeColor}26` }}>
          <div
            className={styles.warningIconWrapper}
            style={{
              background: `${themeColor}20`,
              borderColor: `${themeColor}40`
            }}
          >
            <span className={`material-symbols-outlined ${styles.warningIcon}`} style={{ color: themeColor }}>
              {themeIcon}
            </span>
          </div>
          <div>
            <h2 className={styles.verdictTitle} style={{ color: themeColor }}>
              {statusHeadline} <span className={styles.urduText}>/ {statusUrdu}</span>
            </h2>
            <p className={styles.verdictSubtitle}>{statusSub}</p>
          </div>
        </div>

        {/* Confidence & Score Section */}
        <div className={`liquid-glass-gradient-border ${styles.confidenceSection}`}>
          <div className={styles.flexBetween}>
            <span className={styles.labelCaps}>Authenticity Score</span>
            <span className={styles.confidenceValue} style={{ color: themeColor }}>
              {score}%
            </span>
          </div>
          <div className={styles.progressBarTrack}>
            <div
              className={styles.progressBarFill}
              style={{
                width: `${score}%`,
                background: `linear-gradient(to right, var(--cyan-glow), ${themeColor})`,
                boxShadow: `0 0 10px ${themeColor}80`
              }}
            ></div>
          </div>
          <p className={styles.analysisNote}>{reason}</p>
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
              background: `${themeColor}1f`,
              border: `1px solid ${themeColor}4d`
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
              background: `${themeColor}1a`,
              border: `1px solid ${themeColor}40`
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
