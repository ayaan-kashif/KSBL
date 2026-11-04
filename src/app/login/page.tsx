'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import styles from './login.module.css';
import { postLogin } from '@/lib/api';
import Input from '@/components/Input';
import Button from '@/components/Button';
import GoogleSignInButton from '@/components/GoogleSignInButton';

/** Messages for the ?error= codes /auth/callback and /reset-password send back. */
const AUTH_ERRORS: Record<string, string> = {
  google_cancelled: 'Google sign-in was cancelled.',
  google_failed: "Google sign-in didn't complete. Please try again.",
  auth_unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
};

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(() => AUTH_ERRORS[searchParams.get('error') ?? ''] ?? '');
  const passwordReset = searchParams.get('reset') === '1';

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const res = await postLogin({ email, password });
    if (res.error) {
      setError(res.error);
      setLoading(false);
      return;
    }

    const redirectTo = searchParams.get('redirect') || '/scan';
    router.push(redirectTo);
  };

  return (
    <div className={styles.page}>
      <div className={styles.bgOrb1}></div>
      <div className={styles.bgOrb2}></div>

      <div className={styles.container}>
        <div className={styles.leftPanel}>
          <div className={styles.logoMark}>
            <span className="material-symbols-outlined">shield</span>
          </div>
          <h1 className={styles.brandName}>ShelfWatch</h1>
          <p className={styles.brandTagline}>AI Brand Protection Platform</p>
          <div className={styles.trustRow}>
            {/* These were the same three invented figures the landing page used
                ("24,891 Scans Today", "1,247 Fakes Caught", "98.6% Accuracy").
                Capability statements are true without asserting live numbers on
                a page that has no data to back them. */}
            {[
              { icon: 'qr_code_scanner', text: 'Barcode & packaging verification' },
              { icon: 'shield', text: 'Counterfeit detection with audit trail' },
              { icon: 'translate', text: 'Full English and Urdu support' },
            ].map((item) => (
              <div key={item.text} className={styles.trustPill}>
                <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'var(--cyan-glow)' }}>{item.icon}</span>
                {item.text}
              </div>
            ))}
          </div>
        </div>

        <div className={`liquid-glass-gradient-border ${styles.loginCard}`}>
          <h2 className={styles.cardTitle}>Customer Login</h2>
          <p className={styles.cardSubtitle}>Sign in to scan products and track your reports</p>

          {error && (
            <div className={styles.errorBanner}>
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>error</span>
              {error}
            </div>
          )}
          {passwordReset && !error && (
            <div className={styles.successBanner}>
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>check_circle</span>
              Password updated. Sign in with your new password.
            </div>
          )}

          <form onSubmit={handleSubmit} className={styles.form}>
            <Input
              label="Email Address"
              icon="mail"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
            />
            <Input
              label="Password"
              icon="lock"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
            <p className={styles.forgotRow}>
              <Link href="/forgot-password" className={styles.adminLink}>
                Forgot password?
              </Link>
            </p>

            <Button type="submit" variant="primary" size="lg" fullWidth loading={loading} icon={loading ? undefined : 'login'}>
              {loading ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>

          <div className={styles.divider}><span>or</span></div>

          <div className={styles.altActions}>
            <GoogleSignInButton redirect={searchParams.get('redirect') ?? undefined} onError={setError} />
          </div>

          <Button variant="ghost" size="lg" fullWidth icon="person_add" onClick={() => router.push('/signup')}>
            Create an Account
          </Button>

          <p className={styles.adminLinkRow}>
            <Link href="/settings" className={styles.adminLink}>
              Brand agent? Admin Portal →
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
