'use client';

import { useEffect, useState } from 'react';
import styles from './leaderboard.module.css';
import { getLeaderboard, LeaderboardEntry } from '@/lib/api';
import Button from '@/components/Button';

const RANK_COLORS: Record<number, string> = {
  1: '#ffd700',
  2: '#c0c0c0',
  3: '#cd7f32',
};

export default function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const res = await getLeaderboard();
    setLoading(false);
    if (res.error) {
      setError(res.error);
    } else if (res.data) {
      setEntries(res.data);
    }
  }

  // Re-query on every mount — score_points is sorted DB-side (order=score_points.desc)
  // so the ranking is always fresh, never a stale client-side sort.
  useEffect(() => {
    load();
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.title}>Customer Leaderboard</h1>
          <p className={styles.subtitle}>
            Every customer ranked by scorecard points earned from flagging suspicious scans
          </p>
        </div>
        <Button variant="ghost" size="sm" icon="refresh" onClick={load} loading={loading}>
          Refresh
        </Button>
      </div>

      <div className={`liquid-glass ${styles.tableCard}`}>
        <div className={styles.tableHeader}>
          <h3 className={styles.cardTitle}>All Customers ({entries.length})</h3>
        </div>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                {['Rank', 'Customer', 'Email', 'Score Points'].map(h => (
                  <th key={h} className={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={4} className={`${styles.td} ${styles.tdEmpty}`}>
                    Loading leaderboard...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan={4} className={`${styles.td} ${styles.tdEmpty}`} style={{ color: 'var(--verdict-counterfeit)' }}>
                    {error}
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan={4} className={`${styles.td} ${styles.tdEmpty}`}>
                    No customers have signed up yet.
                  </td>
                </tr>
              ) : (
                entries.map((u, i) => {
                  const rank = i + 1;
                  const medal = RANK_COLORS[rank];
                  return (
                    <tr key={u.id} className={styles.tr}>
                      <td className={styles.td}>
                        <span
                          className={styles.rankBadge}
                          style={medal ? { color: medal, borderColor: `${medal}60`, background: `${medal}15` } : undefined}
                        >
                          {medal && <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>military_tech</span>}
                          #{rank}
                        </span>
                      </td>
                      <td className={styles.td} style={{ fontWeight: 600 }}>{u.name}</td>
                      <td className={`${styles.td} ${styles.tdMuted}`}>
                        {u.email}
                      </td>
                      <td className={styles.td}>
                        <span className={styles.pointsBadge}>{u.score_points.toLocaleString()} pts</span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
