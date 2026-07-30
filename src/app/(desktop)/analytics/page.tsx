'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from './analytics.module.css';
import { getDashboardStats, getDashboardHeatmap, getScanHistory, DashboardStats, HeatmapCluster, ScanHistoryItem, formatPKR } from '@/lib/api';
import MetricCard from '@/components/MetricCard';
import Button from '@/components/Button';

// Literal hex mirrors of the --verdict-* tokens in globals.css. Used here
// (rather than var(--verdict-*)) because these values get alpha-suffixed
// below (e.g. `${hex}1a`) for translucent fills/borders — a trick that only
// works on literal hex colors, not on var() references.
const STATUS_HEX: Record<string, string> = {
  genuine: '#00e5a0',
  suspicious: '#ffb020',
  unverified: '#9aa1b9',
};

const statusIcons: Record<string, string> = {
  genuine: 'verified',
  suspicious: 'warning',
  unverified: 'help_outline',
};

// Available demo brands
const BRANDS = [
  { id: 'brand_unilever_001', name: 'Unilever Pakistan' },
  { id: 'brand_national_001', name: 'National Foods' },
];

export default function AnalyticsPage() {
  const [selectedBrand, setSelectedBrand] = useState(BRANDS[0].id);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapCluster[]>([]);
  const [recentScans, setRecentScans] = useState<ScanHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Starts as null (not `new Date()`) so the server-rendered HTML and the
  // client's first render match exactly — computing it eagerly here would
  // give SSR and hydration two different Date instances (and, depending on
  // the server/browser's default locale, two different formatted strings),
  // causing a hydration mismatch. The real value is set post-mount below.
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);

  async function loadDashboardData() {
    setLoading(true);
    setError(null);

    // Call stats, heatmap, and recent scans in parallel
    const [statsRes, heatmapRes, historyRes] = await Promise.all([
      getDashboardStats(selectedBrand),
      getDashboardHeatmap(selectedBrand),
      getScanHistory(6), // get latest 6 scans for the table
    ]);

    setLoading(false);
    setLastRefreshed(new Date());

    if (statsRes.error) {
      setError(statsRes.error);
    } else {
      setStats(statsRes.data);
    }

    if (heatmapRes.data) {
      setHeatmap(heatmapRes.data);
    }

    if (historyRes.data) {
      setRecentScans(historyRes.data);
    }
  }

  // Reload data on mount or brand change
  useEffect(() => {
    loadDashboardData();

    // Auto-refresh every 45s for the demo
    const timer = setInterval(() => {
      loadDashboardData();
    }, 45000);

    return () => clearInterval(timer);
  }, [selectedBrand]);

  const totalScans = stats?.total_scans ?? 0;
  const genuineCount = stats?.genuine_count ?? 0;
  const suspiciousCount = stats?.suspicious_count ?? 0;
  const unverifiedCount = stats?.unverified_count ?? 0;

  // Percentages for the breakdown
  const genuinePct = totalScans > 0 ? ((genuineCount / totalScans) * 100).toFixed(1) : '0.0';
  const suspiciousPct = totalScans > 0 ? ((suspiciousCount / totalScans) * 100).toFixed(1) : '0.0';
  const unverifiedPct = totalScans > 0 ? ((unverifiedCount / totalScans) * 100).toFixed(1) : '0.0';

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.title}>Brand Intelligence Dashboard</h1>
          <p className={styles.subtitle}>
            Real-time counterfeit detection across Pakistan&apos;s market (Karachi)
          </p>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.brandSelectorWrapper}>
            <span className={styles.brandSelectorLabel}>Brand:</span>
            <select
              className={styles.brandSelect}
              value={selectedBrand}
              onChange={(e) => setSelectedBrand(e.target.value)}
            >
              {BRANDS.map(b => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <Button variant="ghost" size="sm" icon="refresh" onClick={loadDashboardData} loading={loading}>
            Refresh
          </Button>
        </div>
      </div>

      <p className={styles.lastRefreshed}>
        Last refreshed: {lastRefreshed ? lastRefreshed.toLocaleTimeString('en-US', { hour12: true }) : '—'}
      </p>

      {/* Metrics container with loading state overlay */}
      <div className={styles.metricsContainer}>
        {loading && (
          <div className={styles.loadingOverlay}>
            <span className="material-symbols-outlined spin" style={{ fontSize: '36px' }}>sync</span>
            <span className={styles.loadingLabel}>RECALCULATING METRICS...</span>
          </div>
        )}

        <div className={loading ? styles.contentLoading : styles.content}>
          {/* KPI Cards */}
          <div className={styles.kpiGrid}>
            <MetricCard label="Total Scans" value={totalScans.toLocaleString()} icon="qr_code_scanner" trend="flat" trendLabel="Scans captured" />
            <MetricCard label="Suspicious Items" value={suspiciousCount.toLocaleString()} icon="warning" trend="flat" trendLabel={`${stats?.suspicious_rate ?? 0}% rate`} />
            <MetricCard label="Losses Avoided" value={stats ? formatPKR(stats.estimated_losses_pkr) : 'PKR 0'} icon="payments" trend="flat" trendLabel="Estimated retail value" />
            <MetricCard label="Unverified Products" value={unverifiedCount.toLocaleString()} icon="help_outline" trend="flat" trendLabel="Unregistered SKU scans" />
          </div>

          {/* Chart + Map/Hotspot Areas row */}
          <div className={styles.chartRow}>
            <div className={`liquid-glass-gradient-border ${styles.chartCard}`}>
              <h3 className={styles.cardTitle}>Hotspot Areas (Karachi)</h3>
              <div className={styles.hotspotList}>
                {heatmap.map((area, i) => (
                  <div key={i} className={styles.hotspotRow}>
                    <div>
                      <p className={styles.hotspotName}>{area.area_name}</p>
                      <p className={styles.hotspotCoords}>
                        Lat: {area.latitude?.toFixed(4) || 'N/A'}, Lng: {area.longitude?.toFixed(4) || 'N/A'}
                      </p>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <p className={styles.hotspotScans}>
                        {area.report_count} Scans
                      </p>
                      <p className={styles.hotspotRate}>
                        {area.suspicious_rate}% Suspicious
                      </p>
                    </div>
                  </div>
                ))}
                {heatmap.length === 0 && (
                  <div className={styles.emptyHotspot}>
                    No regional hotspots detected yet.
                  </div>
                )}
              </div>
            </div>

            <div className={`liquid-glass-gradient-border ${styles.donutCard}`}>
              <h3 className={styles.cardTitle}>Result Breakdown</h3>
              <div className={styles.donutChart}>
                <div
                  className={styles.donutRing}
                  style={{
                    background: `conic-gradient(
                      var(--verdict-genuine) 0% ${genuinePct}%,
                      var(--verdict-suspicious) ${genuinePct}% ${Number(genuinePct) + Number(suspiciousPct)}%,
                      var(--text-secondary) ${Number(genuinePct) + Number(suspiciousPct)}% 100%
                    )`
                  }}
                ></div>
                <div className={styles.donutCenter}>
                  <span className={styles.donutValue}>{genuinePct}%</span>
                  <span className={styles.donutSub}>Genuine</span>
                </div>
              </div>
              <div className={styles.donutLegend}>
                {[
                  { label: 'Genuine', pct: `${genuinePct}%`, color: 'var(--verdict-genuine)' },
                  { label: 'Suspicious', pct: `${suspiciousPct}%`, color: 'var(--verdict-suspicious)' },
                  { label: 'Unverified', pct: `${unverifiedPct}%`, color: 'var(--text-secondary)' },
                ].map((l, i) => (
                  <div key={i} className={styles.legendItem}>
                    <span className={styles.legendDot} style={{ background: l.color }}></span>
                    <span className={styles.legendLabel}>{l.label}</span>
                    <span className={styles.legendPct} style={{ color: l.color }}>{l.pct}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Incident Table */}
          <div className={`liquid-glass ${styles.tableCard}`}>
            <div className={styles.tableHeader}>
              <h3 className={styles.cardTitle}>Recent Scans &amp; Incidents</h3>
              <Link href="/scan/history" className={styles.viewAllLink}>
                View all <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>arrow_forward</span>
              </Link>
            </div>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {['Scan ID', 'Product', 'Batch No.', 'Location', 'Verdict', 'Confidence', 'Time'].map(h => (
                      <th key={h} className={styles.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {recentScans.map((row, i) => {
                    const hex = STATUS_HEX[row.verdict];
                    return (
                      <tr key={i} className={styles.tr}>
                        <td className={`${styles.td} ${styles.tdMono}`} style={{ color: 'var(--cyan-glow)', fontWeight: 600, fontSize: '12px' }}>
                          {row.id.substring(0, 8)}...
                        </td>
                        <td className={styles.td}>{row.product_name || 'Unregistered Product'}</td>
                        <td className={`${styles.td} ${styles.tdMono}`}>
                          {row.extracted_batch || 'No Batch'}
                        </td>
                        <td className={styles.td}>{row.area_name || 'Karachi'}</td>
                        <td className={styles.td}>
                          <span className={styles.statusBadge} style={{ color: hex, background: `${hex}1a`, border: `1px solid ${hex}33` }}>
                            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>{statusIcons[row.verdict]}</span>
                            {row.verdict.charAt(0).toUpperCase() + row.verdict.slice(1)}
                          </span>
                        </td>
                        <td className={styles.td}>
                          <div className={styles.confidenceCell}>
                            <div className={styles.miniBar}>
                              <div className={styles.miniBarFill} style={{ width: `${Math.round(row.confidence * 100)}%`, background: hex }}></div>
                            </div>
                            <span style={{ color: hex, fontWeight: 600, fontSize: '13px', minWidth: '36px' }}>
                              {Math.round(row.confidence * 100)}%
                            </span>
                          </div>
                        </td>
                        <td className={`${styles.td} ${styles.tdMuted}`}>
                          {new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </td>
                      </tr>
                    );
                  })}
                  {recentScans.length === 0 && (
                    <tr>
                      <td colSpan={7} className={`${styles.td} ${styles.tdEmpty}`}>
                        No scans logged yet. Use the scan portal to create one.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
