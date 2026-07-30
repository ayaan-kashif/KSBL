'use client';

import { useEffect, useState } from 'react';
import styles from './dashboard.module.css';
import { getScanHistory, ScanHistoryItem } from '@/lib/api';
import Button from '@/components/Button';
import HorecaTile from '@/components/HorecaTile';
import { useToast } from '@/components/ToastContext';

export default function DashboardPage() {
  const [activeIncident, setActiveIncident] = useState<ScanHistoryItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [flagged, setFlagged] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    async function loadIncident() {
      const res = await getScanHistory(10);
      setLoading(false);
      if (res.data && res.data.length > 0) {
        // /api/scans already orders by created_at desc, so the first item is the latest scan
        const latest = res.data[0];
        setActiveIncident(latest);

        // Check if this scan has already been flagged in Supabase
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        if (supabaseUrl && anonKey) {
          try {
            const repRes = await fetch(`${supabaseUrl}/rest/v1/Report?scan_id=eq.${latest.id}`, {
              headers: { "apikey": anonKey, "Authorization": `Bearer ${anonKey}` }
            });
            if (repRes.ok) {
              const reports = await repRes.json();
              if (reports && reports.length > 0) {
                setFlagged(reports[0].status === 'investigating');
              }
            }
          } catch (e) {
            console.error("[Dashboard] Error checking flagged report status:", e);
          }
        }
      }
    }
    loadIncident();
  }, []);

  const handleFlagIncident = async () => {
    if (!activeIncident || flagged || flagging) return;
    setFlagging(true);
    console.log(`[Dashboard] Flagging incident: ${activeIncident.id}`);

    try {
      const res = await fetch(`/api/incidents/${activeIncident.id}/flag`, {
        method: 'POST'
      });
      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }
      setFlagged(true);
      showToast(`Incident #${activeIncident.id.substring(0, 5).toUpperCase()} has been successfully flagged for manual field investigation.`, 'success');
    } catch (err) {
      console.error("[Dashboard] Flagging failed:", err);
      showToast("Failed to flag this incident. Please try again.", 'error');
    } finally {
      setFlagging(false);
    }
  };

  const handleExportIncident = async () => {
    if (!activeIncident || exporting) return;
    setExporting(true);
    console.log(`[Dashboard] Exporting dossier for incident: ${activeIncident.id}`);

    try {
      const res = await fetch(`/api/incidents/${activeIncident.id}/export`);
      if (!res.ok) {
        throw new Error(`Server returned status ${res.status}`);
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Incident_Report_${activeIncident.id.substring(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[Dashboard] Export failed:", err);
      showToast("Failed to export report dossier. Please try again.", 'error');
    } finally {
      setExporting(false);
    }
  };

  // Derives real AI flags from this scan's stored Gemini per-check scores
  // (src/app/api/verify/route.ts persists these into ocr_raw_json at scan
  // time). Scans made before that change have ai_flags = null — those fall
  // back to a message rather than showing fabricated flags.
  const MATCH_THRESHOLD = 70;
  function deriveFlags(incident: ScanHistoryItem): { icon: string; text: string }[] {
    const flags = incident.ai_flags;
    if (!flags) return [];

    const result: { icon: string; text: string }[] = [];
    if (flags.tampering) {
      result.push({ icon: 'gpp_maybe', text: 'Tampering Detected' });
    }
    if (flags.packagingMatch < MATCH_THRESHOLD) {
      result.push({ icon: 'print_disabled', text: 'Print Quality Anomaly' });
    }
    if (flags.barcodeMatch < MATCH_THRESHOLD) {
      result.push({ icon: 'qr_code', text: 'Barcode/Batch Pattern Inconsistency' });
    }
    if (flags.logoMatch < MATCH_THRESHOLD || flags.brandMatch < MATCH_THRESHOLD) {
      result.push({ icon: 'branding_watermark', text: 'Logo/Brand Mark Discrepancy' });
    }
    if (flags.designMatch < MATCH_THRESHOLD) {
      result.push({ icon: 'visibility', text: 'Visual Asset Discrepancy' });
    }
    return result;
  }

  const activeFlags = activeIncident ? deriveFlags(activeIncident) : [];

  // confidence is 0 for an unverified verdict — nothing was scored. Rendering
  // that as "0%" with an empty bar reads as a broken component rather than an
  // absent measurement, so the two cases are kept distinct.
  const hasConfidence = !!activeIncident && activeIncident.confidence > 0;
  const confidencePct = hasConfidence ? Math.round(activeIncident!.confidence * 100) : null;

  const isCritical = activeIncident?.verdict === 'suspicious';
  // Verdict colour comes from a modifier class that maps the light-theme
  // --verdict-* tokens onto local --verdict-accent* properties, so no hex
  // values are duplicated in JS.
  const verdictClass = isCritical ? styles.panelCritical : styles.panelCaution;

  return (
    <div className={styles.page}>
      <div className={styles.grid}>
        {/* HORECA pull-through — main column */}
        <div className={styles.mainCol}>
          <HorecaTile />
        </div>

        {/* Incident Panel — side column */}
        <div className={`liquid-glass ${styles.incidentPanel} ${verdictClass}`}>
          <div className={styles.panelInner}>
          {loading ? (
            <div className={styles.stateMessage}>
              <span className="material-symbols-outlined spin" style={{ fontSize: '32px' }}>sync</span>
              <p style={{ marginTop: '8px' }}>Loading active incident...</p>
            </div>
          ) : activeIncident ? (
            <>
              <div className={styles.panelHeader}>
                <div>
                  <p className={styles.panelEyebrow}>LATEST LOGGED INCIDENT</p>
                  <h2 className={styles.panelTitle}>Incident #{activeIncident.id.substring(0, 5).toUpperCase()}</h2>
                  <p className={styles.panelLocation}>
                    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>location_on</span>
                    {activeIncident.area_name || 'Karachi, Pakistan'}
                  </p>
                </div>
                <span className={styles.counterfeitBadge}>
                  <span className={`material-symbols-outlined ${styles.badgeIcon}`}>
                    {isCritical ? 'cancel' : 'warning'}
                  </span>
                  {isCritical ? 'Counterfeit' : 'Unverified'}
                </span>
              </div>

              {/* Confidence */}
              <div className={styles.confSection}>
                <div className={styles.confHeader}>
                  <span className={styles.sectionLabel}>AI CONFIDENCE SCORE</span>
                  {hasConfidence ? (
                    <span className={styles.confValue}>{confidencePct}%</span>
                  ) : (
                    <span className={styles.confValueEmpty}>Not scored</span>
                  )}
                </div>
                <div className={styles.confTrack}>
                  {/* No fill at all when unscored — a 0%-width bar and a real
                      0% score are indistinguishable to the eye otherwise. */}
                  {hasConfidence && (
                    <div className={styles.confFill} style={{ width: `${confidencePct}%` }} />
                  )}
                </div>
                {!hasConfidence && (
                  <p className={styles.confNote}>
                    This scan was not scored — no reference product was matched.
                  </p>
                )}
              </div>

              {/* Product Details */}
              <div className={styles.detailsCard}>
                <p className={styles.sectionLabel}>PRODUCT DETAILS</p>
                <div className={styles.detailsGrid}>
                  {[
                    { label: 'Batch No.', value: activeIncident.extracted_batch || 'Unknown', mono: true },
                    { label: 'Barcode', value: activeIncident.barcode || 'No Barcode', mono: true },
                    { label: 'Time Logged', value: new Date(activeIncident.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
                    { label: 'Verdict', value: activeIncident.verdict.toUpperCase() },
                    { label: 'Brand', value: activeIncident.brand_name || 'Unknown Brand' },
                    { label: 'Category', value: activeIncident.category || 'Uncategorized' },
                  ].map((d, i) => (
                    <div key={i} className={styles.detailItem}>
                      <p className={styles.detailLabel}>{d.label}</p>
                      <p className={`${styles.detailValue} ${d.mono ? styles.mono : ''}`}>{d.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* AI Flags */}
              <div className={styles.flagsCard}>
                <p className={styles.sectionLabel}>AI FLAGS DETECTED</p>
                {activeFlags.map((flag, i) => (
                  <div key={i} className={styles.flagItem}>
                    <span className={`material-symbols-outlined ${styles.flagIcon}`}>{flag.icon}</span>
                    <span className={styles.flagText}>{flag.text}</span>
                  </div>
                ))}
                {activeFlags.length === 0 && (
                  // "No anomalies" is a clean result, not a finding — it must
                  // not inherit the red treatment the actual flags use.
                  <div className={`${styles.flagItem} ${styles.flagItemOk}`}>
                    <span className={`material-symbols-outlined ${styles.flagIcon}`}>check_circle</span>
                    <span className={styles.flagText}>
                      {activeIncident.ai_flags ? 'No anomalies detected' : 'AI signal not recorded for this scan'}
                    </span>
                  </div>
                )}
              </div>

              {/* Actions */}
              <div className={styles.panelActions}>
                <Button
                  variant={flagged ? 'ghost' : 'danger'}
                  fullWidth
                  onClick={handleFlagIncident}
                  disabled={flagged || flagging}
                  loading={flagging}
                  icon={flagging ? undefined : flagged ? 'done' : 'flag'}
                >
                  {flagging ? 'Flagging...' : flagged ? 'Flagged for Investigation' : 'Flag for Investigation'}
                </Button>
                <Button
                  variant="ghost"
                  fullWidth
                  onClick={handleExportIncident}
                  disabled={exporting}
                  loading={exporting}
                  icon={exporting ? undefined : 'download'}
                >
                  {exporting ? 'Exporting...' : 'Export Report'}
                </Button>
              </div>
            </>
          ) : (
              <div className={styles.stateMessage}>
                <span className="material-symbols-outlined" style={{ fontSize: '40px' }}>info</span>
                <p style={{ marginTop: '8px' }}>No incidents logged in the database yet.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
