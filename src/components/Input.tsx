'use client';

import { InputHTMLAttributes, useId, useState } from 'react';
import styles from './Input.module.css';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  icon?: string;
  error?: string;
  id?: string;
}

export default function Input({ label, icon, error, type = 'text', value, id, ...rest }: InputProps) {
  const [focused, setFocused] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const generatedId = useId();
  const inputId = id ?? generatedId;

  const isPassword = type === 'password';
  const resolvedType = isPassword && showPassword ? 'text' : type;
  const hasValue = value !== undefined && value !== '';
  const floated = focused || hasValue;

  return (
    <div>
      <div className={`${styles.wrapper} ${focused ? styles.focused : ''}`}>
        {icon && <span className={`material-symbols-outlined ${styles.leadingIcon}`}>{icon}</span>}
        <input
          id={inputId}
          type={resolvedType}
          className={styles.field}
          value={value}
          placeholder=""
          onFocus={(e) => {
            setFocused(true);
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            rest.onBlur?.(e);
          }}
          {...rest}
        />
        <label htmlFor={inputId} className={`${styles.label} ${floated ? styles.labelFloated : ''}`}>
          {label}
        </label>
        {isPassword && (
          <button
            type="button"
            className={styles.toggleBtn}
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            tabIndex={-1}
          >
            <span className="material-symbols-outlined">{showPassword ? 'visibility_off' : 'visibility'}</span>
          </button>
        )}
      </div>
      {error && <p className={styles.errorText}>{error}</p>}
    </div>
  );
}
