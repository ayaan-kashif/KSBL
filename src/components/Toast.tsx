'use client';

import styles from './Toast.module.css';

export type ToastVariant = 'success' | 'error' | 'info';

const variantIcon: Record<ToastVariant, string> = {
  success: 'check_circle',
  error: 'error',
  info: 'info',
};

interface ToastProps {
  message: string;
  variant: ToastVariant;
  onDismiss: () => void;
}

export default function Toast({ message, variant, onDismiss }: ToastProps) {
  return (
    <div className={`${styles.toast} ${styles[variant]}`} role="status">
      <span className={`material-symbols-outlined ${styles.icon}`}>{variantIcon[variant]}</span>
      <p className={styles.message}>{message}</p>
      <button type="button" className={styles.closeBtn} onClick={onDismiss} aria-label="Dismiss">
        <span className="material-symbols-outlined">close</span>
      </button>
    </div>
  );
}
