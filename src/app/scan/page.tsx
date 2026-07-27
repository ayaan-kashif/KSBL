'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import styles from './scan.module.css';
import { getGeolocation, getScanHistory, ScanHistoryItem, verdictColor } from '@/lib/api';
import BottomNav from '@/components/BottomNav';
import Input from '@/components/Input';

import { compressImage } from '@/lib/imageCompress';

export default function ScanPage() {
  const router = useRouter();
  const [barcode, setBarcode] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ScanHistoryItem[]>([]);

  const [frontImage, setFrontImage] = useState<File | null>(null);
  const [frontPreview, setFrontPreview] = useState<string | null>(null);
  const [backImage, setBackImage] = useState<File | null>(null);
  const [backPreview, setBackPreview] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const backFileInputRef = useRef<HTMLInputElement>(null);

  // Fetch recent scans on mount
  useEffect(() => {
    async function loadHistory() {
      const res = await getScanHistory(3);
      if (res.data) {
        setHistory(res.data);
      }
    }
    loadHistory();

    // Prime the browser's location permission/GPS fix early so it's ready
    // (and cached via maximumAge) by the time /scan/processing needs it.
    getGeolocation();
  }, []);

  // Compress captured file(s) to optimized base64 JPEG and save to sessionStorage, then navigate to /scan/processing
  const submitScan = async (front: File | null, back: File | null, barcodeVal: string) => {
    setScanning(true);
    setError(null);

    try {
      if (front) {
        const frontData = await compressImage(front);
        sessionStorage.setItem('shelfwatch_captured_image', frontData);

        if (back) {
          const backData = await compressImage(back);
          sessionStorage.setItem('shelfwatch_captured_image_back', backData);
        } else {
          sessionStorage.removeItem('shelfwatch_captured_image_back');
        }
      } else {
        // Barcode-only lookup, no photo
        sessionStorage.removeItem('shelfwatch_captured_image');
        sessionStorage.removeItem('shelfwatch_captured_image_back');
      }

      sessionStorage.setItem('shelfwatch_captured_barcode', barcodeVal || '');
      router.push('/scan/processing');
    } catch (err) {
      console.error('[ScanPage] Prep failed:', err);
      const message = err instanceof Error && err.message.includes('read')
        ? err.message
        : 'Image is too large. Please capture/upload a smaller photo.';
      setError(message);
      setScanning(false);
    }
  };

  const handleBarcodeScan = () => {
    if (!barcode.trim()) {
      setError('Please enter a barcode or upload an image.');
      return;
    }
    submitScan(null, null, barcode.trim());
  };

  const handleFrontFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setFrontImage(file);
    setFrontPreview(URL.createObjectURL(file));
  };

  const handleBackFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBackImage(file);
    setBackPreview(URL.createObjectURL(file));
  };

  const handleRetakeFront = () => {
    setFrontImage(null);
    setFrontPreview(null);
    setBackImage(null);
    setBackPreview(null);
  };

  const handleRemoveBack = () => {
    setBackImage(null);
    setBackPreview(null);
  };

  const handleVerifyPhotos = () => {
    if (!frontImage) return;
    submitScan(frontImage, backImage, barcode.trim());
  };

  return (
    <div className={styles.page}>
      <header className={styles.appBar}>
        <Link href="/" className={styles.backBtn}>
          <span className="material-symbols-outlined">arrow_back</span>
        </Link>
        <h1 className={styles.appBarTitle}>Scan Product</h1>
        <button className={styles.helpBtn}>
          <span className="material-symbols-outlined">help_outline</span>
        </button>
      </header>

      <main className={styles.main}>
        {!frontPreview ? (
          /* Viewfinder — triggers file/camera upload for the front photo */
          <div className={styles.viewfinderContainer} onClick={() => fileInputRef.current?.click()} style={{ cursor: 'pointer' }}>
            <div className={styles.viewfinder}>
              <div className={styles.cornerTL}></div>
              <div className={styles.cornerTR}></div>
              <div className={styles.cornerBL}></div>
              <div className={styles.cornerBR}></div>
              <div className={styles.scanLine}></div>
              <div className={styles.viewfinderLabel}>
                <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>photo_camera</span>
                Tap to upload product photo (Front)
              </div>
            </div>
          </div>
        ) : (
          /* Front (+ optional back) photo preview / confirm step */
          <div className={styles.photoReviewSection}>
            <div className={styles.photoSlotRow}>
              <div className={styles.photoSlot}>
                <img src={frontPreview} alt="Front of product" className={styles.photoSlotImg} />
                <span className={styles.photoSlotLabel}>Front</span>
                <button className={styles.photoSlotRemove} onClick={handleRetakeFront} disabled={scanning} title="Retake">
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
                </button>
              </div>

              {backPreview ? (
                <div className={styles.photoSlot}>
                  <img src={backPreview} alt="Back of product" className={styles.photoSlotImg} />
                  <span className={styles.photoSlotLabel}>Back</span>
                  <button className={styles.photoSlotRemove} onClick={handleRemoveBack} disabled={scanning} title="Remove">
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>close</span>
                  </button>
                </div>
              ) : (
                <button
                  className={styles.addBackSlot}
                  onClick={() => backFileInputRef.current?.click()}
                  disabled={scanning}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '22px' }}>add_a_photo</span>
                  Add Back Photo
                  <span className={styles.optionalTag}>Optional</span>
                </button>
              )}
            </div>

            <p className={styles.photoReviewHint}>
              {backPreview
                ? 'Front and back photos will both be checked — this improves accuracy for barcodes and print details on the back label.'
                : 'Adding a back/label photo is optional but improves accuracy, especially for barcodes printed on the back panel.'}
            </p>

            <button className={styles.scanBtn} onClick={handleVerifyPhotos} disabled={scanning}>
              <span className="material-symbols-outlined">{scanning ? 'progress_activity' : 'verified'}</span>
              {scanning ? 'Verifying with AI (may take up to 8s)...' : 'Verify Product'}
            </button>
          </div>
        )}

        {/* Hidden file inputs for camera/gallery */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={handleFrontFileChange}
        />
        <input
          ref={backFileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={handleBackFileChange}
        />

        {/* Error display */}
        {error && (
          <div className={styles.errorBanner}>
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>error</span>
            {error}
          </div>
        )}

        {/* Manual Input */}
        <div className={styles.manualSection}>
          <p className={styles.orDivider}>— or enter barcode manually —</p>
          <Input
            icon="barcode"
            label="Barcode number"
            value={barcode}
            onChange={e => setBarcode(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !frontImage && handleBarcodeScan()}
            disabled={scanning}
          />
          {!frontImage && (
            <button
              className={styles.scanBtn}
              onClick={handleBarcodeScan}
              disabled={scanning}
            >
              <span className="material-symbols-outlined">{scanning ? 'progress_activity' : 'search'}</span>
              {scanning ? 'Verifying with AI...' : 'Verify Product'}
            </button>
          )}
        </div>

        {/* Recent Scans */}
        <div className={styles.recentSection}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.sectionTitle}>Recent Scans</h3>
            <Link href="/scan/history" className={styles.viewAllBtn}>View all</Link>
          </div>
          <div className={styles.recentList}>
            {history.map((s, i) => (
              <div key={i} className={styles.recentItem}>
                <div className={styles.recentDot} style={{ background: verdictColor(s.verdict) }}></div>
                <div className={styles.recentInfo}>
                  <p className={styles.recentName}>{s.product_name || 'Unknown Product'}</p>
                  <p className={styles.recentBatch}>
                    {s.extracted_batch || 'No batch'} · {s.brand_name || 'Unknown Brand'}
                  </p>
                </div>
                <span className={styles.recentStatus} style={{ color: verdictColor(s.verdict) }}>
                  {s.verdict}
                </span>
              </div>
            ))}
            {history.length === 0 && (
              <p className={styles.emptyState}>No scans recorded yet.</p>
            )}
          </div>
        </div>
      </main>

      <BottomNav />
    </div>
  );
}
