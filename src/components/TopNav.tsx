'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './TopNav.module.css';
import LanguageToggle from './LanguageToggle';

export default function TopNav() {
  const pathname = usePathname();
  const isMobile = !pathname.startsWith('/dashboard') && !pathname.startsWith('/analytics') && !pathname.startsWith('/login') && !pathname.startsWith('/reports') && !pathname.startsWith('/inventory') && !pathname.startsWith('/settings');

  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <Link href="/" className={styles.logo}>
          <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>shield</span>
          ShelfWatch
        </Link>
      </div>
      <div className={styles.headerRight}>
        <nav className={styles.nav}>
          <Link href="/dashboard" className={pathname === '/dashboard' ? styles.navLinkActive : styles.navLink}>Overview</Link>
          <Link href="/analytics" className={pathname === '/analytics' ? styles.navLinkActive : styles.navLink}>Analytics</Link>
          <Link href="/inventory" className={pathname === '/inventory' ? styles.navLinkActive : styles.navLink}>Inventory</Link>
        </nav>
        <div className={styles.headerIcons}>
          <LanguageToggle />
          <Link href="/login" className={styles.iconButton}>
            <span className="material-symbols-outlined">account_circle</span>
          </Link>
        </div>
      </div>
      <div className={styles.mobileActions}>
        <LanguageToggle compact />
        <Link href="/login" className={styles.iconButton}>
          <span className="material-symbols-outlined">account_circle</span>
        </Link>
      </div>
    </header>
  );
}
