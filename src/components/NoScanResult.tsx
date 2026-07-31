'use client';

import Link from 'next/link';
import styles from './NoScanResult.module.css';

/**
 * Shown on a verdict screen reached without a scan result in sessionStorage —
 * a direct link, a refresh after the session cleared, or a back-navigation.
 *
 * These pages used to fall back to hardcoded sample data in that case, so
 * /scan/genuine would render "99% — HealthCare Pro 500mg — Genuine" for a
 * product nobody had scanned. On an anti-counterfeit product that is the single
 * worst thing the UI can do, so the empty state is explicit instead.
 */
export default function NoScanResult({ title = 'No scan to show' }: { title?: string }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.icon} aria-hidden="true">
        <span className="material-symbols-outlined">search_off</span>
      </div>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.body}>
        This result is only available right after a scan. Scan a product to see its
        verification result.
      </p>
      <p className={styles.urdu} dir="rtl" lang="ur">
        یہ نتیجہ صرف اسکین کے فوراً بعد دستیاب ہوتا ہے۔ تصدیق کے لیے مصنوع اسکین کریں۔
      </p>
      <Link href="/scan" className={styles.cta}>
        <span className="material-symbols-outlined">qr_code_scanner</span>
        Scan a product
      </Link>
    </div>
  );
}
