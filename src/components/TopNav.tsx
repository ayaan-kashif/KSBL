'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import ThemeToggle from './ThemeToggle';
import styles from './TopNav.module.css';

const NAV_LINKS = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/inventory', label: 'Inventory' },
];

export default function TopNav() {
  const pathname = usePathname();

  const actions = (
    <>
      <ThemeToggle />
      <button type="button" className={styles.iconButton} aria-label="Change language">
        <span className="material-symbols-outlined" aria-hidden="true">language</span>
      </button>
      <Link href="/login" className={styles.iconButton} aria-label="Account">
        <span className="material-symbols-outlined" aria-hidden="true">account_circle</span>
      </Link>
    </>
  );

  return (
    <header className={styles.header}>
      <div className={styles.headerLeft}>
        <Link href="/" className={styles.logo}>
          <span className={styles.logoMark}>
            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: '20px' }}>
              verified_user
            </span>
          </span>
          <span className={styles.logoText}>ShelfWatch</span>
        </Link>
      </div>

      <div className={styles.headerRight}>
        <nav className={styles.nav} aria-label="Primary">
          {NAV_LINKS.map(({ href, label }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={active ? styles.navLinkActive : styles.navLink}
                aria-current={active ? 'page' : undefined}
              >
                {label}
              </Link>
            );
          })}
        </nav>
        <div className={styles.headerIcons}>{actions}</div>
      </div>

      <div className={styles.mobileActions}>{actions}</div>
    </header>
  );
}
