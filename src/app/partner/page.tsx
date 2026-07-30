'use client';

import { useRef, useState } from 'react';
import styles from './partner.module.css';
import { URDU_ATTRS } from '@/lib/verdictCopy';
import { postPartnerRedeem, formatPKR, type PartnerRedeemResponse } from '@/lib/api';

const CODE_LENGTH = 8;

/** Panel treatment per outcome. Amber for already-redeemed (a real voucher,
 *  just spent) versus red for not-found and expired — the waiter needs to tell
 *  "this was already used" apart from "this is not valid" at a glance. */
const OUTCOME = {
  valid: { panel: 'resultValid', icon: 'check_circle', en: 'Voucher accepted', ur: 'واؤچر منظور' },
  already_redeemed: { panel: 'resultWarn', icon: 'history', en: 'Already redeemed', ur: 'پہلے استعمال ہو چکا' },
  expired: { panel: 'resultError', icon: 'schedule', en: 'Voucher expired', ur: 'واؤچر کی میعاد ختم' },
  not_found: { panel: 'resultError', icon: 'error', en: 'Invalid code', ur: 'غلط کوڈ' },
} as const;

export default function PartnerPage() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PartnerRedeemResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || code.length === 0) return;
    setBusy(true);
    setError(null);
    setResult(null);

    const res = await postPartnerRedeem(code);
    setBusy(false);
    if (res.error) setError(res.error);
    else if (res.data) setResult(res.data);
  }

  function reset() {
    setCode('');
    setResult(null);
    setError(null);
    inputRef.current?.focus();
  }

  const outcome = result ? OUTCOME[result.result] : null;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brandRow}>
          <span className={`material-symbols-outlined ${styles.brandIcon}`}>storefront</span>
          <span className={styles.brandName}>SHELFWATCH · PARTNER</span>
        </div>
        <h1 className={styles.title}>Redeem a voucher</h1>
        <p className={styles.subtitle}>
          Enter the 8-character code from the customer&apos;s wallet.
        </p>
      </header>

      {!result && (
        <form className={styles.form} onSubmit={handleSubmit}>
          <label className={styles.label} htmlFor="voucher-code">
            Voucher code
          </label>
          <input
            id="voucher-code"
            ref={inputRef}
            className={styles.input}
            value={code}
            onChange={(e) =>
              // Uppercase and strip anything that can't be in a code as the
              // waiter types, so a pasted "k7m4 xr29" still submits cleanly.
              setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH))
            }
            placeholder="XXXXXXXX"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            maxLength={CODE_LENGTH}
            aria-describedby="code-hint"
          />
          <p className={styles.hint} id="code-hint">
            {code.length}/{CODE_LENGTH} characters
          </p>

          <button type="submit" className={styles.submit} disabled={busy || code.length !== CODE_LENGTH}>
            {busy ? 'Checking…' : 'Redeem'}
          </button>

          {error && (
            <div className={`${styles.result} ${styles.resultError}`}>
              <span className={`material-symbols-outlined ${styles.resultIcon}`}>error</span>
              <p className={styles.resultHeadline}>Something went wrong</p>
              <p className={styles.resultDetail}>{error}</p>
              <button type="button" className={styles.nextBtn} onClick={reset}>
                Try again
              </button>
            </div>
          )}
        </form>
      )}

      {result && outcome && (
        <div className={`${styles.result} ${styles[outcome.panel]}`}>
          <span className={`material-symbols-outlined ${styles.resultIcon}`}>{outcome.icon}</span>
          <p className={styles.resultHeadline}>{outcome.en}</p>
          <p className={styles.resultHeadlineUr} {...URDU_ATTRS}>
            {outcome.ur}
          </p>

          <p className={styles.resultCode}>{result.code}</p>

          {result.result === 'valid' && (
            <>
              <p className={styles.resultDetail}>
                Apply <strong>{result.offer_title}</strong> to this customer&apos;s bill.
              </p>
              <div className={styles.resultMeta}>
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>Reward value</span>
                  <span className={styles.metaValue}>
                    {result.consumer_value_pkr != null ? formatPKR(result.consumer_value_pkr) : '—'}
                  </span>
                </div>
                <div className={styles.metaRow}>
                  <span className={styles.metaLabel}>Your NFL bulk credit</span>
                  <span className={styles.metaValue}>
                    {result.bulk_credit_pkr != null ? formatPKR(result.bulk_credit_pkr) : '—'}
                  </span>
                </div>
                {result.partner_name && (
                  <div className={styles.metaRow}>
                    <span className={styles.metaLabel}>Partner</span>
                    <span className={styles.metaValue}>{result.partner_name}</span>
                  </div>
                )}
              </div>
            </>
          )}

          {result.result === 'already_redeemed' && (
            <p className={styles.resultDetail}>
              This voucher was used
              {result.redeemed_at ? ` on ${new Date(result.redeemed_at).toLocaleString()}` : ''}.
              Do not apply the discount again.
            </p>
          )}

          {result.result === 'expired' && (
            <p className={styles.resultDetail}>
              This voucher lapsed
              {result.expires_at ? ` on ${new Date(result.expires_at).toLocaleDateString()}` : ''} and
              can no longer be redeemed.
            </p>
          )}

          {result.result === 'not_found' && (
            <p className={styles.resultDetail}>
              No voucher matches this code. Check the customer&apos;s wallet screen and re-enter it.
            </p>
          )}

          <button type="button" className={styles.nextBtn} onClick={reset}>
            Next customer
          </button>
        </div>
      )}
    </div>
  );
}
