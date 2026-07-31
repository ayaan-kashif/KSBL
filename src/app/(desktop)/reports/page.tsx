'use client';

import { useEffect, useState } from 'react';
import styles from './reports.module.css';
import { getPublicStats } from '@/lib/api';

type ReportFormat = 'PDF' | 'CSV' | 'XLSX';

/**
 * A report TYPE, not a stored file. Every entry here is compiled on demand by
 * /api/reports/download from live Scan data, so the catalogue itself is
 * legitimately static — but `date` and `size` are not, and used to be
 * hardcoded ("Jul 1, 2026", "2.4 MB"). Both were fiction: nothing is generated
 * until the user clicks, so there is no creation date and no file size to
 * report beforehand. They have been removed rather than faked.
 */
interface Report {
  id: number;
  name: string;
  description: string;
  format: ReportFormat;
  icon: string;
  color: string;
  /** What the report is compiled from — shown in place of the fake metadata. */
  source: string;
}

const REPORTS: Report[] = [
  {
    id: 1,
    name: 'Counterfeit Summary',
    description: 'Every scan flagged suspicious, with product, brand, area and confidence',
    format: 'PDF',
    icon: 'summarize',
    color: 'var(--color-error)',
    source: 'Suspicious scans',
  },
  {
    id: 2,
    name: 'Field Agent Audit Trail',
    description: 'Complete audit log of scan activity and submissions by role',
    format: 'CSV',
    icon: 'person_search',
    color: 'var(--color-secondary)',
    source: 'All scans',
  },
  {
    id: 3,
    name: 'Regional Hotspot Analysis',
    description: 'Suspicious-scan rate broken down by area, from geotagged scans',
    format: 'PDF',
    icon: 'location_on',
    color: 'var(--color-primary)',
    source: 'Geotagged scans',
  },
  {
    id: 4,
    name: 'Brand Integrity Score Report',
    description: 'Per-brand scoring for product authenticity and supply chain trust',
    // CSV, not XLSX. The badge claimed XLSX while /api/reports/download?id=4
    // serves text/csv with a .csv filename, so the download never matched what
    // the UI promised. Corrected to what the endpoint actually returns.
    format: 'CSV',
    icon: 'shield',
    color: 'var(--color-primary)',
    source: 'Scans grouped by brand',
  },
  {
    id: 5,
    name: 'Verification Pipeline Metrics',
    description: 'Verdict distribution and confidence spread across the scan pipeline',
    format: 'PDF',
    icon: 'analytics',
    color: 'var(--color-secondary)',
    source: 'All scans',
  },
  {
    id: 6,
    name: 'Recalled Products Master List',
    description: 'Full inventory export of products with active recall status',
    format: 'CSV',
    icon: 'inventory_2',
    color: 'var(--color-error)',
    source: 'Product catalogue',
  },
];

// var() references rather than literal hex: these were light-theme values that
// stayed light on the dark canvas. Alpha now comes from color-mix.
const formatColors: Record<ReportFormat, string> = {
  PDF: 'var(--verdict-counterfeit)',
  CSV: 'var(--verdict-genuine)',
  XLSX: 'var(--cyan-glow)',
};

const tint = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export default function ReportsPage() {
  const [downloading, setDownloading] = useState<number | null>(null);
  const [downloaded, setDownloaded] = useState<Set<number>>(new Set());
  const [generating, setGenerating] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  // null = not loaded yet, rendered as an em dash. 0 would be a claim.
  const [scanCount, setScanCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPublicStats().then((res) => {
      if (!cancelled && res.data) setScanCount(res.data.total_scans);
    });
    return () => { cancelled = true; };
  }, []);

  async function handleDownload(id: number, format: string, name: string) {
    setDownloading(id);
    setToast(null);
    console.log(`[Reports] Downloading report #${id}: ${name}`);

    try {
      const res = await fetch(`/api/reports/download?id=${id}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch report from server (status: ${res.status})`);
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name.replace(/\s+/g, "_")}.${format.toLowerCase()}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      setDownloaded(prev => new Set(prev).add(id));
      console.log(`[Reports] Downloaded report #${id} successfully`);
      setToast({ message: `Successfully downloaded "${name}"`, type: 'success' });
    } catch (err) {
      console.error(`[Reports] Download failed for #${id}:`, err);
      setToast({ message: `Download failed: ${err instanceof Error ? err.message : 'Unknown error'}`, type: 'error' });
    } finally {
      setDownloading(null);
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    setToast(null);
    console.log("[Reports] Triggering report compile generation...");

    try {
      const res = await fetch('/api/reports/generate', {
        method: 'POST'
      });
      if (!res.ok) {
        throw new Error(`Failed to compile report from database (status: ${res.status})`);
      }

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Supply_Chain_Audit_Report_${Date.now()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      console.log("[Reports] Supply Chain Audit Report generated successfully");
      setToast({ message: 'Global Supply Chain Audit Report compiled and downloaded successfully!', type: 'success' });
    } catch (err) {
      console.error("[Reports] Supply Chain Audit Report generation failed:", err);
      setToast({ message: `Generation failed: ${err instanceof Error ? err.message : 'Unknown error'}`, type: 'error' });
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Reports</h1>
          <p className={styles.subtitle}>Download generated intelligence reports and audit exports</p>
        </div>
        <button
          className={styles.generateBtn}
          onClick={handleGenerate}
          disabled={generating}
        >
          <span className={`material-symbols-outlined ${generating ? styles.spin : ''}`}>
            {generating ? 'sync' : 'add_chart'}
          </span>
          {generating ? 'Generating…' : 'Generate Report'}
        </button>
      </div>

      {/* Stats bar. Previously four invented figures (24/6/14/10). The report
          counts are now derived from the catalogue itself, and the scan counts
          come from live data — an em dash until they arrive, never a zero. */}
      <div className={styles.statsBar}>
        {[
          { label: 'Report Types', value: String(REPORTS.length), icon: 'description' },
          {
            label: 'Document Reports',
            value: String(REPORTS.filter(r => r.format === 'PDF').length),
            icon: 'picture_as_pdf',
          },
          {
            label: 'Data Exports',
            value: String(REPORTS.filter(r => r.format !== 'PDF').length),
            icon: 'table_chart',
          },
          {
            label: 'Scans Covered',
            value: scanCount === null ? '—' : scanCount.toLocaleString(),
            icon: 'qr_code_scanner',
          },
        ].map((s, i) => (
          <div key={i} className={styles.statCard}>
            <span className="material-symbols-outlined" style={{ color: 'var(--color-primary)', fontSize: '20px' }}>{s.icon}</span>
            <span className={styles.statValue}>{s.value}</span>
            <span className={styles.statLabel}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Report List */}
      <div className={styles.list}>
        {REPORTS.map(report => (
          <div key={report.id} className={styles.row}>
            {/* color-mix, not hex-alpha concatenation: report.color is a
                var() reference, so appending "18" would be invalid CSS. */}
            <div
              className={styles.rowIcon}
              style={{ background: `color-mix(in srgb, ${report.color} 12%, transparent)`, color: report.color }}
            >
              <span className="material-symbols-outlined">{report.icon}</span>
            </div>
            <div className={styles.rowContent}>
              <h3 className={styles.rowName}>{report.name}</h3>
              <p className={styles.rowDesc}>{report.description}</p>
              {/* Replaces the invented date + file size. These are the two
                  facts that are actually true of an on-demand report: what it
                  reads from, and that it is built at download time. */}
              <div className={styles.rowMeta}>
                <span className={styles.metaItem}>
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>database</span>
                  {report.source}
                </span>
                <span className={styles.metaItem}>
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>bolt</span>
                  Compiled on download
                </span>
              </div>
            </div>
            <div className={styles.rowRight}>
              <span
                className={styles.formatBadge}
                style={{
                  color: formatColors[report.format],
                  borderColor: tint(formatColors[report.format], 38),
                  background: tint(formatColors[report.format], 12),
                }}
              >
                {report.format}
              </span>
              <button
                className={`${styles.downloadBtn} ${downloaded.has(report.id) ? styles.downloadDone : ''}`}
                onClick={() => !downloaded.has(report.id) && handleDownload(report.id, report.format, report.name)}
                disabled={downloading === report.id}
              >
                {downloading === report.id ? (
                  <span className={`material-symbols-outlined ${styles.spin}`}>sync</span>
                ) : downloaded.has(report.id) ? (
                  <span className="material-symbols-outlined">check_circle</span>
                ) : (
                  <span className="material-symbols-outlined">download</span>
                )}
                {downloading === report.id ? 'Downloading…' : downloaded.has(report.id) ? 'Downloaded' : 'Download'}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Toast Notification */}
      {toast && (
        <div style={{
          position: 'fixed',
          bottom: '24px',
          right: '24px',
          background: toast.type === 'success' ? 'var(--verdict-genuine-bg)' : 'var(--verdict-counterfeit-bg)',
          color: toast.type === 'success' ? 'var(--verdict-genuine)' : 'var(--verdict-counterfeit)',
          border: `1px solid ${toast.type === 'success' ? 'var(--verdict-genuine-border)' : 'var(--verdict-counterfeit-border)'}`,
          padding: '12px 20px',
          borderRadius: 'var(--r-sm)',
          boxShadow: 'var(--e4)',
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontSize: '14px',
          fontFamily: 'var(--font-inter), sans-serif'
        }}>
          <span className="material-symbols-outlined" style={{ color: 'inherit', fontSize: '18px' }}>
            {toast.type === 'success' ? 'check_circle' : 'error'}
          </span>
          {toast.message}
          <button onClick={() => setToast(null)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', marginLeft: '12px', display: 'flex', alignItems: 'center' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
          </button>
        </div>
      )}
    </div>
  );
}
