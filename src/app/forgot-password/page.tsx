'use client';

/**
 * /forgot-password — request a password reset email.
 *
 * The server first makes sure the account is known to Supabase Auth
 * (/api/auth/forgot-password); then Supabase sends the email from this
 * browser, which keeps the PKCE verifier /auth/callback needs. The reply is
 * the same whether or not the email has an account.
 *
 * Same layout and styles as the login page.
 */

import { useState } from 'react';
import Link from 'next/link';
import styles from '../login/login.module.css';
import { postForgotPassword } from '@/lib/api';
import { authCallbackUrl, getSupabaseBrowser } from '@/lib/supabaseBrowser';
import Input from '@/components/Input';
import Button from '@/components/Button';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    const address = email.trim().toLowerCase();
    if (!EMAIL_RE.test(address)) {
      setError('Please enter a valid email address.');
      return;
    }

    setLoading(true);
    const prepared = await postForgotPassword(address);
    if (prepared.error) {
      setError(prepared.error);
      setLoading(false);
      return;
    }

    try {
      const { error: sendError } = await getSupabaseBrowser().auth.resetPasswordForEmail(address, {
        redirectTo: authCallbackUrl('recovery'),
      });
      if (sendError) {
        setError(
          sendError.status === 429
            ? 'Too many reset requests. Please wait a few minutes and try again.'
            : 'We could not send the reset email. Please try again shortly.'
        );
        setLoading(false);
        return;
      }
      setSent(true);
    } catch (err) {
      console.error('[ForgotPassword] resetPasswordForEmail failed:', err);
      setError('We could not send the reset email. Please try again shortly.');
    }
    setLoading(false);
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
          <h2 className={styles.cardTitle}>Forgot Password</h2>
          <p className={styles.cardSubtitle}>
            Enter the email you registered with and we&apos;ll send you a link to choose a new password.
          </p>

          {error && (
            <div className={styles.errorBanner}>
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>error</span>
              {error}
            </div>
          )}

          {sent ? (
            <div className={styles.successBanner}>
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>mark_email_read</span>
              If an account exists for {email.trim().toLowerCase()}, a reset link is on its way. Check your inbox and spam
              folder, and open the link in this browser.
            </div>
          ) : (
            <form onSubmit={handleSubmit} className={styles.form} noValidate>
              <Input
                label="Email Address"
                icon="mail"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
              <Button type="submit" variant="primary" size="lg" fullWidth loading={loading} icon={loading ? undefined : 'send'}>
                {loading ? 'Sending...' : 'Send Reset Link'}
              </Button>
            </form>
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
