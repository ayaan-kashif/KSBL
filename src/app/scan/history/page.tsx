'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './history.module.css';
import { getMyScanHistory, getMe, postLogout, ScanHistoryItem, CustomerProfile, verdictIcon } from '@/lib/api';
import BottomNav from '@/components/BottomNav';

type FilterType = 'all' | 'genuine' | 'suspicious' | 'unverified';

// verdictColor() (from '@/lib/api') returns a var(--color-*) reference, which
// can't be hex-alpha-suffixed for translucent fills/borders. This local map
// mirrors the new --verdict-* token values as literal hex for that purpose.
const VERDICT_HEX: Record<'genuine' | 'suspicious' | 'unverified', string> = {
  genuine: '#00e6a8',
  suspicious: '#ffb800',
  unverified: '#9aa1b9',
};

export default function ScanHistoryPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterType>('all');
  const [search, setSearch] = useState('');
  const [scans, setScans] = useState<ScanHistoryItem[]>([]);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadScans() {
      setLoading(true);
      setError(null);
      const [scansRes, meRes] = await Promise.all([getMyScanHistory(50), getMe()]);
      setLoading(false);
      if (scansRes.error) {
        setError(scansRes.error);
      } else if (scansRes.data) {
        setScans(scansRes.data);
      }
      if (meRes.data) {
        setProfile(meRes.data);
      }
    }
    loadScans();
  }, []);

  const filtered = scans.filter(s => {
    const matchesFilter = filter === 'all' || s.verdict === filter;
    const productName = s.product_name || 'Unknown Product';
    const batch = s.extracted_batch || 'No Batch';
    const matchesSearch = productName.toLowerCase().includes(search.toLowerCase()) ||
                          batch.toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  function formatTime(dateStr: string) {
    try {
      const d = new Date(dateStr);
      const diffMs = Date.now() - d.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    } catch {
      return 'Recent';
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.appBar}>
        <Link href="/scan" className={styles.backBtn}>
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <h1 className={styles.appBarTitle}>Scan History</h1>
        <span className={styles.countBadge}>{filtered.length}</span>
      </header>

      <main className={styles.main}>
        {profile && (
          <div className={styles.scorePill}>
            <span className={styles.scoreGreeting}>Hi, {profile.name}</span>
            <div className={styles.scoreActions}>
              <span className={styles.scorePoints}>
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>military_tech</span>
                {profile.score_points} pts
              </span>
              <button
                onClick={async () => { await postLogout(); router.push('/login'); }}
                className={styles.logoutBtn}
              >
                Log out
              </button>
            </div>
          </div>
        )}

        {/* Search */}
        <div className={styles.searchWrapper}>
          <span className={`material-symbols-outlined ${styles.searchIcon}`}>search</span>
          <input
            className={styles.searchInput}
            placeholder="Search product or batch..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className={styles.clearBtn} onClick={() => setSearch('')}>
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>close</span>
            </button>
          )}
        </div>

        {/* Filter chips */}
        <div className={styles.filterRow}>
          {(['all', 'genuine', 'suspicious', 'unverified'] as FilterType[]).map(f => (
            <button
              key={f}
              className={filter === f ? styles.filterChipActive : styles.filterChip}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>

        {/* Loading / Error States */}
        {loading && (
          <div className={styles.stateMessage}>
            <span className="material-symbols-outlined spin" style={{ fontSize: '32px' }}>sync</span>
            <p style={{ marginTop: '8px' }}>Loading history...</p>
          </div>
        )}

        {error && (
          <div className={styles.stateMessage} style={{ color: 'var(--verdict-counterfeit)' }}>
            <span className="material-symbols-outlined" style={{ fontSize: '40px' }}>error_outline</span>
            <p style={{ marginTop: '8px' }}>{error}</p>
          </div>
        )}

        {/* Scan list */}
        {!loading && !error && filtered.length === 0 ? (
          <div className={styles.emptyState}>
            <span className="material-symbols-outlined" style={{ fontSize: '48px' }}>search_off</span>
            <p>No scans found</p>
          </div>
        ) : (
          <div className={styles.scanList}>
            {filtered.map(scan => {
              const hex = VERDICT_HEX[scan.verdict];
              return (
                <div key={scan.id} className={styles.scanCard} style={{ borderLeft: `3px solid ${hex}` }}>
                  <div className={styles.statusDot} style={{ color: hex, background: `${hex}1a`, borderColor: `${hex}33` }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '20px', fontVariationSettings: "'FILL' 1" }}>
                      {verdictIcon(scan.verdict)}
                    </span>
                  </div>
                  <div className={styles.scanInfo}>
                    <p className={styles.productName}>{scan.product_name || 'Unknown Product'}</p>
                    <p className={styles.batchInfo}>
                      {scan.extracted_batch || 'No Batch'} · {scan.brand_name || 'Unknown Brand'}
                    </p>
                    <p className={styles.timeInfo}>{formatTime(scan.created_at)}</p>
                  </div>
                  <div className={styles.scanRight}>
                    <span className={styles.statusBadge} style={{ color: hex, background: `${hex}1a`, border: `1px solid ${hex}33` }}>
                      {scan.verdict}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
}
