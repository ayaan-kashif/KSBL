'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import styles from './home.module.css';
import Button from '@/components/Button';
import MetricCard from '@/components/MetricCard';
import ThemeToggle from '@/components/ThemeToggle';

export default function HomePage() {
  const [scanCount, setScanCount] = useState(0);

  useEffect(() => {
    const target = 24891;
    const duration = 2000;
    const start = Date.now();
    const timer = setInterval(() => {
      const progress = Math.min((Date.now() - start) / duration, 1);
      setScanCount(Math.floor(progress * target));
      if (progress >= 1) clearInterval(timer);
    }, 16);
    return () => clearInterval(timer);
  }, []);

  const features = [
    { icon: 'qr_code_scanner', title: 'Barcode & QR Scan', desc: 'Scan any product barcode in seconds with your phone camera.', color: 'var(--brand-cyan)' },
    { icon: 'analytics', title: 'AI Verification', desc: 'Machine learning trained on millions of genuine products.', color: 'var(--brand-violet)' },
    { icon: 'shield', title: 'Real-time Alerts', desc: 'Instant counterfeit detection with audit trail logging.', color: 'var(--verdict-counterfeit)' },
    { icon: 'translate', title: 'Bilingual UI', desc: 'Full English and Urdu support for all users.', color: 'var(--verdict-genuine)' },
  ];

  return (
    <div className={styles.page}>
      {/* Parallax light layers over the global aurora field */}
      <div className={styles.bgOrb1} aria-hidden="true"></div>
      <div className={styles.bgOrb2} aria-hidden="true"></div>
      <div className={styles.bgOrb3} aria-hidden="true"></div>

      {/* Header */}
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className={styles.logoMark}>
            <span className="material-symbols-outlined" aria-hidden="true">verified_user</span>
          </span>
          <span className={styles.logoText}>ShelfWatch</span>
        </div>
        <nav className={styles.nav}>
          <ThemeToggle />
          <Link href="/settings" className={styles.adminNavLink} title="Brand agent or admin portal">
            <span className="material-symbols-outlined" aria-hidden="true">security</span>
            Admin Portal
          </Link>
          <Button href="/login" variant="ghost" size="sm">Log In</Button>
        </nav>
      </header>

      {/* Hero */}
      <main className={styles.hero}>
        <div className={styles.heroBadge}>
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>auto_awesome</span>
          AI-Powered Brand Protection
        </div>
        <h1 className={styles.heroTitle}>
          Protecting Pakistan&apos;s<br />
          <span className={styles.heroAccent}>Market Integrity</span>
        </h1>
        <p className={styles.heroSubtitle}>
          Instant barcode scanning to verify product authenticity. Built for field agents and consumers alike — in English and Urdu.
        </p>
        <p className={styles.heroUrdu}>پاکستانی مارکیٹ میں مصنوعات کی صداقت فوری طور پر تصدیق کریں</p>

        <div className={styles.heroCta}>
          <Button href="/signup" variant="primary" size="lg" icon="qr_code_scanner">
            Sign Up &amp; Start Scanning
          </Button>
          <Button href="/login" variant="ghost" size="lg" icon="login">
            Log In
          </Button>
        </div>

        {/* Stats Row */}
        <div className={styles.statsRow}>
          <MetricCard label="Scans Today" value={scanCount.toLocaleString()} icon="qr_code_scanner" />
          <MetricCard label="Fakes Caught" value="1,247" icon="gpp_maybe" />
          <MetricCard label="Accuracy" value="98.6%" icon="verified" />
        </div>
      </main>

      {/* Features */}
      <section className={`stagger ${styles.features}`}>
        {features.map((f, i) => (
          <div
            key={i}
            className={`surface surface-sheen ${styles.featureCard}`}
            style={{ '--card-accent': f.color } as React.CSSProperties}
          >
            <div className={styles.featureIcon}>
              <span className="material-symbols-outlined" aria-hidden="true">{f.icon}</span>
            </div>
            <h3 className={styles.featureTitle}>{f.title}</h3>
            <p className={styles.featureDesc}>{f.desc}</p>
          </div>
        ))}
      </section>

      {/* CTA Banner */}
      <section className={styles.ctaBanner}>
        <h2 className={styles.ctaTitle}>Ready to verify a product?</h2>
        <p className={styles.ctaDesc}>Point your camera at any product barcode to get an instant authenticity report.</p>
        <Button href="/scan" variant="primary" size="lg" icon="qr_code_scanner">
          Scan Now — It&apos;s Free
        </Button>
      </section>

      <footer className={styles.footer}>
        <p>© 2026 ShelfWatch AI · Protecting Pakistan&apos;s Markets</p>
      </footer>
    </div>
  );
}
