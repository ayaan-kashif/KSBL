'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import styles from './BottomNav.module.css';
import LanguageToggle from './LanguageToggle';

const navItems = [
  { href: '/', icon: 'home', label: 'Home' },
  { href: '/scan', icon: 'qr_code_scanner', label: 'Scan' },
  { href: '/rewards', icon: 'redeem', label: 'Rewards' },
  { href: '/scan/history', icon: 'history', label: 'History' },
  { href: '/login', icon: 'account_circle', label: 'Account' },
];

export default function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className={styles.nav}>
      {navItems.map((item) => {
        const isActive = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`${styles.link} ${isActive ? styles.linkActive : ''}`}
          >
            <span className={styles.pill} />
            <span className={`material-symbols-outlined ${styles.icon}`}>{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        );
      })}
      <span className={styles.langSlot}>
        <LanguageToggle compact />
      </span>
    </nav>
  );
}
