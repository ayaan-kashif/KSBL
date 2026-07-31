'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './TopNav.module.css';
import LanguageToggle from './LanguageToggle';
import ThemeToggle from './ThemeToggle';

export default function TopNav() {
  const pathname = usePathname();

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
          <ThemeToggle />
          <Link href="/login" className={styles.iconButton} aria-label="Account">
            <span className="material-symbols-outlined">account_circle</span>
          </Link>
        </div>
      </div>
      <div className={styles.mobileActions}>
        <LanguageToggle compact />
        <ThemeToggle compact />
        <Link href="/login" className={styles.iconButton} aria-label="Account">
          <span className="material-symbols-outlined">account_circle</span>
        </Link>
      </div>
    </header>
  );
}
