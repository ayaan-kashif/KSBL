'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import styles from './Sidebar.module.css';
import { useToast } from './ToastContext';

const navItems = [
  { href: '/dashboard', icon: 'dashboard', label: 'OVERVIEW' },
  { href: '/analytics', icon: 'analytics', label: 'ANALYTICS' },
  { href: '/leaderboard', icon: 'leaderboard', label: 'LEADERBOARD' },
  { href: '/inventory', icon: 'inventory_2', label: 'INVENTORY' },
  { href: '/scan/history', icon: 'history', label: 'SCAN HISTORY' },
  { href: '/reports', icon: 'description', label: 'REPORTS' },
  { href: '/settings', icon: 'settings', label: 'SETTINGS' },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [exporting, setExporting] = useState(false);
  const { showToast } = useToast();

  const handleExportAll = async () => {
    if (exporting) return;
    setExporting(true);
    console.log("[Sidebar] Exporting all scan logs...");
    try {
      const res = await fetch("/api/scans/export");
      if (!res.ok) throw new Error(`Server returned status ${res.status}`);

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ShelfWatch_All_Scans_Export_${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      showToast("Successfully exported all scans to CSV!", "success");
    } catch (err) {
      console.error("[Sidebar] Failed to export all scans:", err);
      showToast("Failed to export scan logs. Please try again.", "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <aside className={styles.sidebar}>
      <div className={styles.sidebarContent}>
        <div className={styles.agentProfile}>
          <div className={styles.agentAvatar}>
            <span className="material-symbols-outlined" style={{ color: 'var(--cyan-glow)' }}>security</span>
          </div>
          <div>
            <p className={styles.agentRole}>AGENT PORTAL</p>
            <p className={styles.agentName}>Field Intelligence</p>
          </div>
        </div>

        <nav className={styles.sidebarNav}>
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={isActive ? styles.sidebarLinkActive : styles.sidebarLink}
              >
                <span className="material-symbols-outlined">{item.icon}</span>
                <span className={styles.navLabel}>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      <div className={styles.sidebarFooter}>
        <button
          className={styles.exportBtn}
          onClick={handleExportAll}
          disabled={exporting}
        >
          <span className={`material-symbols-outlined ${exporting ? styles.spin : ''}`}>
            {exporting ? 'sync' : 'download'}
          </span>
          {exporting ? 'EXPORTING...' : 'EXPORT DATA'}
        </button>
        <Link href="/scan" className={styles.scanBtn}>
          <span className="material-symbols-outlined">qr_code_scanner</span>
          NEW SCAN
        </Link>
      </div>
    </aside>
  );
}
