'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './signup.module.css';
import { postSignup } from '@/lib/api';
import Input from '@/components/Input';
import Button from '@/components/Button';

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      setLoading(false);
      return;
    }

    const res = await postSignup({ name, email, password });
    if (res.error) {
      setError(res.error);
      setLoading(false);
      return;
    }

    router.push('/scan');
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

        <div className={`liquid-glass-gradient-border ${styles.signupCard}`}>
          <h2 className={styles.cardTitle}>Create Your Account</h2>
          <p className={styles.cardSubtitle}>Sign up to start verifying products and earn points for flagging counterfeits</p>

          {error && (
            <div className={styles.errorBanner}>
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>error</span>
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className={styles.form}>
            <Input
              label="Full Name"
              icon="person"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              required
              minLength={2}
            />
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
              minLength={8}
            />

            <Button type="submit" variant="primary" size="lg" fullWidth loading={loading} icon={loading ? undefined : 'person_add'}>
              {loading ? 'Creating account...' : 'Sign Up'}
            </Button>
          </form>

          <div className={styles.divider}><span>or</span></div>

          <Button variant="ghost" size="lg" fullWidth icon="login" onClick={() => router.push('/login')}>
            Already have an account? Sign In
          </Button>
        </div>
      </div>
    </div>
  );
}
