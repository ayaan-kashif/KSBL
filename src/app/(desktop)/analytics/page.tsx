'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import styles from './analytics.module.css';
import type { MapFocus } from '@/components/HotspotMap';
import { getDashboardStats, getDashboardHeatmap, getScanHistory, getBrands, DashboardStats, HeatmapCluster, ScanHistoryItem, BrandOption, formatPKR } from '@/lib/api';
import MetricCard from '@/components/MetricCard';
import Button from '@/components/Button';

// var() references, not literal hex. These used to be hardcoded light-theme
// hexes so that alpha could be appended as a suffix (`${hex}1a`); that pinned
// the whole table to light-mode colours on the dark canvas. color-mix() gives
// the same translucent fills while letting the tokens follow the theme.
const STATUS_HEX: Record<string, string> = {
  genuine: 'var(--verdict-genuine)',
  suspicious: 'var(--verdict-suspicious)',
  unverified: 'var(--text-secondary)',
};

/** Translucent variant of a verdict colour, theme-aware. */
const tint = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

const statusIcons: Record<string, string> = {
  genuine: 'verified',
  suspicious: 'warning',
  unverified: 'help_outline',
};

/**
 * Leaflet reads `window` at module scope, so this must never be evaluated during
 * the server render — ssr:false keeps it out of the server bundle entirely. The
 * placeholder matches the map's own height so the card does not jump when the
 * chunk arrives.
 */
const HotspotMap = dynamic(() => import('@/components/HotspotMap'), {
  ssr: false,
  loading: () => <div className={styles.mapSkeleton} aria-hidden="true" />,
});

export default function AnalyticsPage() {
  // Brands come from the Brand table via /api/brands. This was previously a
  // hardcoded two-entry demo list, so any brand actually onboarded into the
  // database was unreachable from the console. Empty until loaded — the
  // stats calls below are gated on a selected brand, so there is nothing to
  // fetch before the list arrives.
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [selectedBrand, setSelectedBrand] = useState('');
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
  // Which cluster the map should pan to. The nonce lets the same row be clicked
  // repeatedly — without it, re-selecting an area would not re-trigger the
  // fly-to because the lat/lng props would be identical.
  const [mapFocus, setMapFocus] = useState<MapFocus | null>(null);

  const focusArea = useCallback((lat: number | null, lng: number | null) => {
    if (lat === null || lng === null) return;
    setMapFocus((prev) => ({ lat, lng, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  /* Both wrapped in useCallback so they are referentially stable. That lets the
     polling effect below list them as real dependencies instead of suppressing
     the exhaustive-deps rule — with unstable functions, every render would tear
     down and restart the 45s interval. Only setState functions are captured,
     and React guarantees those are stable, so [] is a complete dep list. */

  /** Fetch without touching state, so callers decide when to commit. */
  const fetchDashboardData = useCallback((brandId: string) => {
    // Call stats, heatmap, and recent scans in parallel
    return Promise.all([
      getDashboardStats(brandId),
      getDashboardHeatmap(brandId),
      getScanHistory(6), // latest 6 scans for the table
    ]);
  }, []);

  const applyDashboardData = useCallback((
    [statsRes, heatmapRes, historyRes]: Awaited<ReturnType<typeof fetchDashboardData>>
  ) => {
    setLoading(false);
    setLastRefreshed(new Date());

    if (statsRes.error) setError(statsRes.error);
    else { setError(null); setStats(statsRes.data); }

    if (heatmapRes.data) setHeatmap(heatmapRes.data);
    if (historyRes.data) setRecentScans(historyRes.data);
  }, []);

  /** Refresh button handler — an event, so sync state updates are fine here. */
  async function loadDashboardData() {
    // Nothing to query until a brand exists — /api/dashboard/stats 422s on an
    // empty brand_id, which would surface as a spurious error banner on load.
    if (!selectedBrand) return;
    setLoading(true);
    setError(null);
    applyDashboardData(await fetchDashboardData(selectedBrand));
  }

  // Load the brand list once, then select the first one, which cascades into
  // the data effect below.
  useEffect(() => {
    let cancelled = false;
    getBrands().then((res) => {
      if (cancelled) return;
      if (res.data) {
        setBrands(res.data);
        if (res.data.length > 0) setSelectedBrand(res.data[0].id);
        else { setBrands([]); setLoading(false); }
      } else {
        setError(res.error ?? 'Failed to load brands');
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Reload on brand change, then poll. `loading` already starts true and the
  // brand effect resets it, so the first setState here lands after the await
  // rather than synchronously inside the effect body.
  useEffect(() => {
    if (!selectedBrand) return;

    let cancelled = false;
    const run = () => {
      fetchDashboardData(selectedBrand).then((res) => {
        if (!cancelled) applyDashboardData(res);
      });
    };

    run();
    const timer = setInterval(run, 45_000); // auto-refresh

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [selectedBrand, fetchDashboardData, applyDashboardData]);

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
              disabled={brands.length === 0}
              aria-label="Brand"
            >
              {brands.length === 0 ? (
                <option value="">No brands available</option>
              ) : (
                brands.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))
              )}
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

      {/* `error` was being set on every failed load but never rendered, so a
          failing brand query left the last good numbers on screen with nothing
          to say they were stale. role="alert" announces it to screen readers. */}
      {error && (
        <div className={styles.errorBanner} role="alert">
          <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>error</span>
          <span>{error}</span>
          <Button variant="ghost" size="sm" icon="refresh" onClick={loadDashboardData}>
            Retry
          </Button>
        </div>
      )}

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
              <h3 className={styles.cardTitle}>Counterfeit Hotspots</h3>

              {/* Every point comes from the same `heatmap` state the rest of the
                  page already uses — no second fetch, no seeded points. */}
              <HotspotMap clusters={heatmap} loading={loading} focus={mapFocus} />

              {/* The ranked list stays: it is the accessible, screen-reader
                  friendly view of the same data, and the only way to reach
                  clusters the API could not geocode. */}
              <div className={styles.hotspotList}>
                {heatmap.map((area, i) => {
                  const locatable = area.latitude !== null && area.longitude !== null;
                  return (
                    <button
                      key={`${area.area_name}-${i}`}
                      type="button"
                      className={styles.hotspotRow}
                      onClick={() => focusArea(area.latitude, area.longitude)}
                      disabled={!locatable}
                      title={locatable ? `Show ${area.area_name} on the map` : 'No coordinates for this area'}
                    >
                      <div className={styles.hotspotMeta}>
                        <p className={styles.hotspotName}>{area.area_name}</p>
                        <p className={styles.hotspotCoords}>
                          {locatable
                            ? `Lat: ${area.latitude!.toFixed(4)}, Lng: ${area.longitude!.toFixed(4)}`
                            : 'Not mapped — no location captured'}
                        </p>
                      </div>
                      <div className={styles.hotspotStats}>
                        <p className={styles.hotspotScans}>{area.report_count} Scans</p>
                        <p className={styles.hotspotRate}>{area.suspicious_rate}% Suspicious</p>
                      </div>
                    </button>
                  );
                })}
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
                    const hex = STATUS_HEX[row.verdict] ?? STATUS_HEX.unverified;
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
                          <span className={styles.statusBadge} style={{ color: hex, background: tint(hex, 12), border: `1px solid ${tint(hex, 32)}` }}>
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
