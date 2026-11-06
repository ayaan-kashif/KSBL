'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './history.module.css';
import { getMyScanHistory, getMe, postLogout, ScanHistoryItem, CustomerProfile, verdictIcon } from '@/lib/api';
import { useLanguage } from '@/components/LanguageContext';
import { VERDICT_LABEL, MEDICINE_COPY } from '@/lib/verdictCopy';
import BottomNav from '@/components/BottomNav';
import { useNow, formatRelativeTime } from '@/lib/useNow';

type FilterType = 'all' | 'genuine' | 'suspicious' | 'unverified';

// Theme tokens, not literal hex. These were hardcoded light-theme values so
// they could be alpha-suffixed (`${hex}1a`) for translucent fills — which also
// pinned every verdict colour to light mode on the dark canvas. color-mix()
// gives the same translucency over a var(), so the tokens follow the theme.
const VERDICT_HEX: Record<'genuine' | 'suspicious' | 'unverified', string> = {
  genuine: 'var(--verdict-genuine)',
  suspicious: 'var(--verdict-suspicious)',
  unverified: 'var(--text-secondary)',
};

/** Translucent variant of a verdict colour, theme-aware. */
const tint = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

export default function ScanHistoryPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterType>('all');
  const { lang } = useLanguage();
  const urduLeads = lang === 'ur';
  const [search, setSearch] = useState('');
  const [scans, setScans] = useState<ScanHistoryItem[]>([]);
  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Shared clock — see useNow. Reading Date.now() inside render made the output
  // impure and produced a server/client hydration mismatch on every timestamp.
  const now = useNow();

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


  return (
    <div className={styles.page}>
      <header className={styles.appBar}>
        <Link href="/scan" className={styles.backBtn} aria-label="Back to scanner">
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
              const hex = VERDICT_HEX[scan.verdict] ?? VERDICT_HEX.unverified;
              // A medicine is never labelled "Genuine" — see MEDICINE_COPY.
              const label = scan.category === 'Medicine' && scan.verdict === 'genuine'
                ? MEDICINE_COPY.noProblemsLabel
                : VERDICT_LABEL[scan.verdict];
              return (
                <div key={scan.id} className={styles.scanCard} style={{ borderLeft: `3px solid ${hex}` }}>
                  <div className={styles.statusDot} style={{ color: hex, background: tint(hex, 10), borderColor: tint(hex, 20) }}>
                    <span className="material-symbols-outlined" style={{ fontSize: '20px', fontVariationSettings: "'FILL' 1" }}>
                      {verdictIcon(scan.verdict)}
                    </span>
                  </div>
                  <div className={styles.scanInfo}>
                    <p className={styles.productName}>{scan.product_name || 'Unknown Product'}</p>
                    <p className={styles.batchInfo}>
                      {scan.extracted_batch || 'No Batch'} · {scan.brand_name || 'Unknown Brand'}
                      {/* Medicines: expiry, only when known. */}
                      {scan.expiry_date ? ` · Exp ${scan.expiry_date.slice(0, 10)}` : ''}
                    </p>
                    <p className={styles.timeInfo}>{formatRelativeTime(scan.created_at, now)}</p>
                  </div>
                  <div className={styles.scanRight}>
                    {/* Verdict label in the active language, with the other
                        beneath it — rows stay bilingual in both modes. */}
                    <span className={styles.statusBadge} style={{ color: hex, background: tint(hex, 10), border: `1px solid ${tint(hex, 20)}` }}>
                      {urduLeads ? (
                        <>
                          <span lang="ur" dir="rtl" className={styles.badgeUrdu}>
                            {label.ur}
                          </span>
                          <span lang="en" dir="ltr" className={styles.badgeSecondary}>
                            {label.en}
                          </span>
                        </>
                      ) : (
                        <>
                          <span lang="en" dir="ltr">{label.en}</span>
                          <span lang="ur" dir="rtl" className={`${styles.badgeUrdu} ${styles.badgeSecondary}`}>
                            {label.ur}
                          </span>
                        </>
                      )}
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
