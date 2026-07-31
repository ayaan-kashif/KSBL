'use client';

import Link from 'next/link';
import { useState, useEffect } from 'react';
import styles from './home.module.css';
import Button from '@/components/Button';
import MetricCard from '@/components/MetricCard';
import Tilt3D from '@/components/Tilt3D';
import ThemeToggle from '@/components/ThemeToggle';

const features = [
  {
    icon: 'qr_code_scanner',
    title: 'Barcode & QR Scan',
    desc: 'Scan any product barcode in seconds with your phone camera.',
    tint: '#0891b2',
  },
  {
    icon: 'network_intelligence',
    title: 'AI Verification',
    desc: 'Machine learning trained on millions of genuine products.',
    tint: '#7c3aed',
  },
  {
    icon: 'shield',
    title: 'Real-time Alerts',
    desc: 'Instant counterfeit detection with audit trail logging.',
    tint: '#f43f5e',
  },
  {
    icon: 'translate',
    title: 'Bilingual UI',
    desc: 'Full English and Urdu support for all users.',
    tint: '#10b981',
  },
];

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

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <span className="material-symbols-outlined">shield</span>
          ShelfWatch
        </div>
        <nav className={styles.nav}>
          <Link href="/settings" className={styles.adminNavLink} title="Brand agent or admin portal">
            <span className="material-symbols-outlined">security</span>
            Admin Portal
          </Link>
          <ThemeToggle compact />
          <Button href="/login" variant="ghost" size="sm">Log In</Button>
        </nav>
      </header>

      <main className={styles.hero}>
        <div className={styles.heroCopy}>
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

          <div className={styles.statsRow}>
            <MetricCard label="Scans Today" value={scanCount.toLocaleString()} icon="qr_code_scanner" />
            <MetricCard label="Fakes Caught" value="1,247" icon="gpp_maybe" />
            <MetricCard label="Accuracy" value="98.6%" icon="verified" />
          </div>
        </div>

        {/* Decorative mock result. It illustrates the product rather than
            reporting anything, so it is hidden from assistive tech entirely —
            a screen reader announcing a fake batch number would be misleading. */}
        <div className={styles.showcase} aria-hidden="true">
          <Tilt3D className={`plate ${styles.showcaseCard}`} max={11} lift={0}>
            <div className={styles.showcaseGlow} />

            <div className={`depth-1 ${styles.showcaseHead}`}>
              <span className={styles.showcaseLabel}>Live Verification</span>
              <span className={styles.showcaseVerdict}>
                <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>verified</span>
                Genuine
              </span>
            </div>

            <div className={`depth-1 ${styles.showcaseScreen}`}>
              <span className="material-symbols-outlined">barcode_scanner</span>
              <span className={styles.scanLine} />
            </div>

            <div className={`depth-2 ${styles.showcaseRows}`}>
              <div className={styles.showcaseRow}>
                <span className={styles.showcaseRowKey}>Batch</span>
                <span className={styles.showcaseRowValue}>SEFM-221-KHI</span>
              </div>
              <div className={styles.showcaseRow}>
                <span className={styles.showcaseRowKey}>Confidence</span>
                <span className={styles.showcaseRowValue}>98.6%</span>
              </div>
            </div>

            <span className={`${styles.floatChip} ${styles.chipTopLeft}`}>
              <span className="material-symbols-outlined">encrypted</span>
              Verified
            </span>
            <span className={`${styles.floatChip} ${styles.chipRight}`}>
              <span className="material-symbols-outlined">bolt</span>
              1.2s scan
            </span>
            <span className={`${styles.floatChip} ${styles.chipBottom}`}>
              <span className="material-symbols-outlined">inventory_2</span>
              12.4M products
            </span>
          </Tilt3D>
        </div>
      </main>

      <section className={`stagger ${styles.features}`}>
        {features.map((f) => (
          <div key={f.title} className={styles.featureScene}>
            <Tilt3D
              className={`plate rim spotlight ${styles.featureCard}`}
              max={8}
              lift={18}
            >
              <div className={`depth-2 ${styles.featureIcon}`} style={{ '--tint': f.tint } as React.CSSProperties}>
                <span className="material-symbols-outlined">{f.icon}</span>
              </div>
              <h3 className={`depth-1 ${styles.featureTitle}`}>{f.title}</h3>
              <p className={`depth-1 ${styles.featureDesc}`}>{f.desc}</p>
            </Tilt3D>
          </div>
        ))}
      </section>

      <section className={styles.ctaBanner}>
        <h2 className={styles.ctaTitle}>Ready to verify a product?</h2>
        <p className={styles.ctaDesc}>
          Point your camera at any product barcode to get an instant authenticity report.
        </p>
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
