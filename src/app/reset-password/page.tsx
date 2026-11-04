'use client';

/**
 * /reset-password — choose a new password from a reset link.
 *
 * /auth/callback has already turned the emailed link into a Supabase recovery
 * session (or redirected here with ?error= when the link was expired, reused
 * or invalid). The new password is set with supabase.auth.updateUser(), then
 * stored for the app's own email/password login (/api/auth/reset-password),
 * the recovery session is closed, and the user is sent to sign in.
 *
 * Same layout and styles as the login page.
 */

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import styles from '../login/login.module.css';
import { postResetPassword } from '@/lib/api';
import { getSupabaseBrowser } from '@/lib/supabaseBrowser';
import Input from '@/components/Input';
import Button from '@/components/Button';

/** Same rule as signup. */
const MIN_PASSWORD_LENGTH = 8;

const LINK_PROBLEM = 'This reset link has expired or has already been used. Please request a new one.';

type Stage = 'checking' | 'ready' | 'invalid' | 'done';

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [stage, setStage] = useState<Stage>('checking');
  const [problem, setProblem] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Is there a usable recovery session? Errors can arrive in the query
  // (from /auth/callback) or the URL fragment (from Supabase itself, e.g.
  // #error_code=otp_expired for an expired link).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const linkError = searchParams.get('error') ?? hash.get('error_code') ?? hash.get('error');
      if (linkError) {
        if (!cancelled) {
          setProblem(linkError === 'auth_unavailable' ? 'Password reset is temporarily unavailable.' : LINK_PROBLEM);
          setStage('invalid');
        }
        return;
      }
      try {
        const { data } = await getSupabaseBrowser().auth.getSession();
        if (cancelled) return;
        if (data.session) {
          setStage('ready');
        } else {
          setProblem(LINK_PROBLEM);
          setStage('invalid');
        }
      } catch {
        if (!cancelled) {
          setProblem('Password reset is temporarily unavailable.');
          setStage('invalid');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setLoading(true);
    const supabase = getSupabaseBrowser();
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        setProblem(LINK_PROBLEM);
        setStage('invalid');
        setLoading(false);
        return;
      }

      const { error: updateError } = await supabase.auth.updateUser({ password });
      // "Same password" means a previous attempt already set it in Supabase;
      // carry on so the app's own login gets it too.
      if (updateError && updateError.code !== 'same_password') {
        setError(updateError.message || 'Could not update your password. Please try again.');
        setLoading(false);
        return;
      }

      const saved = await postResetPassword(data.session.access_token, password);
      if (saved.error) {
        setError(saved.error);
        setLoading(false);
        return;
      }

      await supabase.auth.signOut({ scope: 'local' });
      setStage('done');
      setTimeout(() => router.push('/login?reset=1'), 2500);
    } catch (err) {
      console.error('[ResetPassword] Failed:', err);
      setError('Could not update your password. Please try again.');
      setLoading(false);
    }
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
        </div>

        <div className={`liquid-glass-gradient-border ${styles.loginCard}`}>
          <h2 className={styles.cardTitle}>Set a New Password</h2>
          <p className={styles.cardSubtitle}>Choose a new password for your ShelfWatch account.</p>

          {stage === 'checking' && <p className={styles.cardSubtitle}>Checking your reset link…</p>}

          {stage === 'invalid' && (
            <>
              <div className={styles.errorBanner}>
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>link_off</span>
                {problem}
              </div>
              <Button variant="primary" size="lg" fullWidth icon="send" href="/forgot-password">
                Request a New Link
              </Button>
            </>
          )}

          {stage === 'done' && (
            <div className={styles.successBanner}>
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>check_circle</span>
              Password updated. Taking you to sign in…
            </div>
          )}

          {stage === 'ready' && (
            <>
              {error && (
                <div className={styles.errorBanner}>
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>error</span>
                  {error}
                </div>
              )}
              <form onSubmit={handleSubmit} className={styles.form} noValidate>
                <Input
                  label="New Password"
                  icon="lock"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                />
                <Input
                  label="Confirm New Password"
                  icon="lock"
                  type="password"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                />
                <p className={styles.forgotRow} style={{ textAlign: 'left', margin: '-0.5rem 0 0' }}>
                  At least {MIN_PASSWORD_LENGTH} characters.
                </p>
                <Button type="submit" variant="primary" size="lg" fullWidth loading={loading} icon={loading ? undefined : 'lock_reset'}>
                  {loading ? 'Saving...' : 'Save New Password'}
                </Button>
              </form>
            </>
          )}

          <p className={styles.adminLinkRow}>
            <Link href="/login" className={styles.adminLink}>
              ← Back to Sign In
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
