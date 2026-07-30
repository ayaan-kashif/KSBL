'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './onboarding.module.css';

const STEPS = [
  {
    id: 0,
    component: StepWelcome,
  },
  {
    id: 1,
    component: StepHowToScan,
  },
  {
    id: 2,
    component: StepPermission,
  },
];

function StepWelcome() {
  return (
    <div className={styles.stepContent}>
      <div className={styles.logoWrap}>
        <div className={styles.logoIcon}>
          <span className="material-symbols-outlined" style={{ fontSize: '48px' }}>shield_with_heart</span>
        </div>
        <h1 className={styles.logoText}>ShelfWatch</h1>
        <span className={styles.logoTagline}>AI Verification System</span>
      </div>
      <div className={styles.welcomeCard}>
        <h2 className={styles.stepTitle}>What is ShelfWatch?</h2>
        <p className={styles.stepBody}>
          ShelfWatch uses advanced AI to instantly verify pharmaceutical and consumer product authenticity —
          protecting Pakistan's supply chain from counterfeit goods in real time.
        </p>
        <div className={styles.featureList}>
          {[
            { icon: 'qr_code_scanner', label: 'Scan any product barcode or QR code' },
            { icon: 'psychology', label: 'AI-powered counterfeit detection in seconds' },
            { icon: 'verified', label: 'Trusted verdict with confidence scoring' },
            { icon: 'cloud_upload', label: 'Report incidents directly to authorities' },
          ].map((f, i) => (
            <div key={i} className={styles.featureItem}>
              <div className={styles.featureIcon}>
                <span className="material-symbols-outlined">{f.icon}</span>
              </div>
              <span className={styles.featureLabel}>{f.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StepHowToScan() {
  const scanSteps = [
    {
      icon: 'qr_code_scanner',
      title: 'Scan the Product',
      desc: 'Point your camera at the product barcode, QR code, or hologram sticker. Hold steady for best results.',
      color: 'var(--color-primary)',
    },
    {
      icon: 'analytics',
      title: 'AI Analysis',
      desc: 'ShelfWatch AI analyzes 40+ authenticity markers including print quality, barcode integrity, and batch data.',
      color: 'var(--color-secondary)',
    },
    {
      icon: 'verified',
      title: 'Receive Verdict',
      desc: 'Instantly get a Genuine, Suspicious, or Counterfeit verdict with a confidence score and detailed reasoning.',
      color: 'var(--color-primary)',
    },
  ];

  return (
    <div className={styles.stepContent}>
      <h2 className={styles.stepTitle}>How to Scan</h2>
      <p className={styles.stepBody}>Follow these three simple steps to verify any product in seconds.</p>
      <div className={styles.scanSteps}>
        {scanSteps.map((s, i) => (
          <div key={i} className={styles.scanStep}>
            <div className={styles.scanStepNumber} style={{ borderColor: s.color, color: s.color }}>
              {i + 1}
            </div>
            {/* color-mix, not hex-alpha concatenation: s.color is a var()
                reference, and appending "18" to that produces invalid CSS. */}
            <div
              className={styles.scanStepIcon}
              style={{ background: `color-mix(in srgb, ${s.color} 12%, transparent)`, color: s.color }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '32px' }}>{s.icon}</span>
            </div>
            <div className={styles.scanStepText}>
              <h3 className={styles.scanStepTitle} style={{ color: s.color }}>{s.title}</h3>
              <p className={styles.scanStepDesc}>{s.desc}</p>
            </div>
            {i < 2 && <div className={styles.scanConnector} style={{ background: `linear-gradient(to bottom, ${s.color}, ${scanSteps[i + 1].color})` }} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function StepPermission({ onGranted }: { onGranted?: () => void }) {
  const [status, setStatus] = useState<'idle' | 'granted' | 'denied'>('idle');

  async function requestCamera() {
    try {
      await navigator.mediaDevices.getUserMedia({ video: true });
      setStatus('granted');
      setTimeout(() => onGranted?.(), 800);
    } catch {
      setStatus('denied');
    }
  }

  return (
    <div className={styles.stepContent}>
      <div className={styles.permissionIllustration}>
        <div className={`${styles.permissionRing} ${status === 'granted' ? styles.permissionGranted : status === 'denied' ? styles.permissionDenied : ''}`}>
          <span className="material-symbols-outlined" style={{ fontSize: '64px' }}>
            {status === 'granted' ? 'check_circle' : status === 'denied' ? 'cancel' : 'camera_alt'}
          </span>
        </div>
      </div>
      <h2 className={styles.stepTitle}>Enable Camera Access</h2>
      <p className={styles.stepBody}>
        ShelfWatch needs access to your camera to scan product barcodes and QR codes for verification.
        Your camera is used only during scans — never recorded or stored.
      </p>
      <div className={styles.permissionCard}>
        {[
          { icon: 'lock', text: 'Camera access is used only during scanning' },
          { icon: 'block', text: 'No images are stored on our servers' },
          { icon: 'privacy_tip', text: 'Compliant with Pakistan data protection laws' },
        ].map((item, i) => (
          <div key={i} className={styles.permissionItem}>
            <span className="material-symbols-outlined" style={{ color: 'var(--color-primary)', fontSize: '18px' }}>{item.icon}</span>
            <span className={styles.permissionText}>{item.text}</span>
          </div>
        ))}
      </div>
      {status === 'idle' && (
        <button className={styles.cameraBtn} onClick={requestCamera}>
          <span className="material-symbols-outlined">camera_alt</span>
          Allow Camera Access
        </button>
      )}
      {status === 'granted' && (
        <div className={styles.statusMessage} style={{ color: 'var(--color-primary)' }}>
          <span className="material-symbols-outlined">check_circle</span>
          Camera access granted!
        </div>
      )}
      {status === 'denied' && (
        <div className={styles.statusMessage} style={{ color: 'var(--color-error)' }}>
          <span className="material-symbols-outlined">error</span>
          Access denied. Please enable camera in browser settings.
        </div>
      )}
    </div>
  );
}

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const router = useRouter();
  const isLast = step === STEPS.length - 1;

  function handleNext() {
    if (isLast) {
      router.push('/scan');
    } else {
      setStep(s => s + 1);
    }
  }

  const StepComponent = STEPS[step].component;

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.cardScroll}>
          {step === 2 ? (
            <StepPermission onGranted={handleNext} />
          ) : (
            <StepComponent />
          )}
        </div>

        {/* Step dots */}
        <div className={styles.dots}>
          {STEPS.map((_, i) => (
            <button
              key={i}
              className={`${styles.dot} ${step === i ? styles.dotActive : ''} ${step > i ? styles.dotDone : ''}`}
              onClick={() => setStep(i)}
              aria-label={`Step ${i + 1}`}
            />
          ))}
        </div>

        {/* Navigation */}
        <div className={styles.nav}>
          {step > 0 && (
            <button className={styles.backBtn} onClick={() => setStep(s => s - 1)}>
              <span className="material-symbols-outlined">arrow_back</span>
              Back
            </button>
          )}
          <button className={styles.nextBtn} onClick={handleNext}>
            {isLast ? 'Get Started' : 'Next'}
            <span className="material-symbols-outlined">{isLast ? 'rocket_launch' : 'arrow_forward'}</span>
          </button>
        </div>
      </div>

      {/* Background decoration */}
      <div className={styles.bgGlow1} />
      <div className={styles.bgGlow2} />
    </div>
  );
}
