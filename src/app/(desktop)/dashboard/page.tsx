'use client';

import { useEffect, useState } from 'react';
import styles from './dashboard.module.css';
import { getScanHistory, ScanHistoryItem } from '@/lib/api';
import Button from '@/components/Button';
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

  const confidencePct = activeIncident ? Math.round(activeIncident.confidence * 100) : 97;
  const isCritical = activeIncident?.verdict === 'suspicious';
  const verdictHex = isCritical ? '#ff3366' : '#ffb800';

  return (
    <div className={styles.page}>
      {/* Vector SVG map */}
      <svg className={styles.mapSvg} viewBox="0 0 800 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <linearGradient id="mapFade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--bg-base)" stopOpacity="0.2" />
            <stop offset="55%" stopColor="var(--bg-base)" stopOpacity="0.55" />
            <stop offset="100%" stopColor="var(--bg-base)" stopOpacity="0.97" />
          </linearGradient>
        </defs>
        <rect width="800" height="600" fill="var(--bg-surface)" />
        {Array.from({ length: 17 }).map((_, i) => (
          <line key={`v${i}`} x1={i * 50} y1="0" x2={i * 50} y2="600" stroke="rgba(0,210,255,0.08)" strokeWidth="1" />
        ))}
        {Array.from({ length: 13 }).map((_, i) => (
          <line key={`h${i}`} x1="0" y1={i * 50} x2="800" y2={i * 50} stroke="rgba(0,210,255,0.08)" strokeWidth="1" />
        ))}
        <path d="M0,420 C150,380 250,460 400,400 S650,340 800,380" stroke="rgba(138,43,226,0.35)" strokeWidth="3" fill="none" />
        <path d="M120,0 C160,150 100,300 180,600" stroke="rgba(0,210,255,0.25)" strokeWidth="3" fill="none" />
        <path d="M0,180 C220,140 500,220 800,150" stroke="rgba(0,210,255,0.18)" strokeWidth="2" fill="none" />
        <rect width="800" height="600" fill="url(#mapFade)" />
      </svg>

      {/* Pulsing ping marker for the active incident */}
      {activeIncident && (
        <div className={styles.pingWrapper} style={{ top: '38%', left: '42%', color: verdictHex }}>
          <div className={styles.pingRipple}></div>
          <div className={styles.pingRipple2}></div>
          <div className={styles.pingDot} style={{ background: verdictHex }}></div>
        </div>
      )}

      {/* Incident Panel */}
      <div className={`liquid-glass ${styles.incidentPanel}`}>
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
                <span
                  className={styles.counterfeitBadge}
                  style={{ background: `${verdictHex}26`, color: verdictHex, border: `1px solid ${verdictHex}4d` }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px', fontVariationSettings: "'FILL' 1" }}>
                    {isCritical ? 'cancel' : 'warning'}
                  </span>
                  {isCritical ? 'Counterfeit' : 'Unverified'}
                </span>
              </div>

              {/* Confidence */}
              <div className={styles.confSection}>
                <div className={styles.confHeader}>
                  <span className={styles.sectionLabel}>AI Confidence Score</span>
                  <span className={styles.confValue} style={{ color: verdictHex }}>
                    {confidencePct}%
                  </span>
                </div>
                <div className={styles.confTrack}>
                  <div
                    className={styles.confFill}
                    style={{
                      width: `${confidencePct}%`,
                      background: `linear-gradient(to right, var(--cyan-glow), ${verdictHex})`,
                      boxShadow: `0 0 10px ${verdictHex}80`,
                    }}
                  ></div>
                </div>
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
                    <span className="material-symbols-outlined" style={{ color: 'var(--verdict-counterfeit)', fontSize: '18px' }}>{flag.icon}</span>
                    <span className={styles.flagText}>{flag.text}</span>
                  </div>
                ))}
                {activeFlags.length === 0 && (
                  <div className={styles.flagItem}>
                    <span className="material-symbols-outlined" style={{ color: 'var(--verdict-genuine)', fontSize: '18px' }}>check_circle</span>
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
  );
}
