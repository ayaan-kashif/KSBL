'use client';

import { useCallback, useEffect, useRef, ReactNode, ElementType } from 'react';

interface Tilt3DProps {
  children: ReactNode;
  className?: string;
  /** Max rotation in degrees at the far edge of the element. */
  max?: number;
  /** Extra Z-translation applied on hover, in px. Reads as "picks up". */
  lift?: number;
  /** Render as something other than a <div> (e.g. 'article', 'li'). */
  as?: ElementType;
  style?: React.CSSProperties;
}

/**
 * Pointer-driven 3D tilt.
 *
 * Writes four CSS custom properties onto the element — `--rx`/`--ry` (rotation)
 * and `--mx`/`--my` (pointer position as a percentage) — which the `.plate` and
 * `.spotlight` recipes in globals.css consume. Keeping the values in CSS vars
 * rather than setting `transform` directly means a stylesheet can still compose
 * its own transforms on top without fighting inline styles.
 *
 * Updates are batched into a single rAF callback: pointermove can fire well
 * above display refresh rate, and writing style on every event is what turns a
 * tilt into jank.
 *
 * Disabled entirely when the pointer is coarse (no hover to track on touch, and
 * the tilt would just fight scrolling) or when reduced motion is requested.
 */
export default function Tilt3D({
  children,
  className = '',
  max = 9,
  lift = 24,
  as: Tag = 'div',
  style,
}: Tilt3DProps) {
  const ref = useRef<HTMLElement>(null);
  const frame = useRef<number | null>(null);
  const next = useRef({ rx: 0, ry: 0, mx: 50, my: 50 });
  const enabled = useRef(true);

  useEffect(() => {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => { enabled.current = fine.matches && !still.matches; };
    sync();
    fine.addEventListener('change', sync);
    still.addEventListener('change', sync);
    return () => {
      fine.removeEventListener('change', sync);
      still.removeEventListener('change', sync);
    };
  }, []);

  const flush = useCallback(() => {
    frame.current = null;
    const el = ref.current;
    if (!el) return;
    const { rx, ry, mx, my } = next.current;
    el.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
    el.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
    el.style.setProperty('--mx', `${mx.toFixed(1)}%`);
    el.style.setProperty('--my', `${my.toFixed(1)}%`);
  }, []);

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  }, [flush]);

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!enabled.current || !ref.current) return;
      const r = ref.current.getBoundingClientRect();
      // Normalised to -0.5..0.5 from the element's centre.
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      next.current = {
        // Y-drag rotates about X and is negated: pushing the pointer DOWN should
        // tip the far edge away from the viewer, not toward it.
        rx: -py * max * 2,
        ry: px * max * 2,
        mx: (px + 0.5) * 100,
        my: (py + 0.5) * 100,
      };
      schedule();
    },
    [max, schedule],
  );

  const onEnter = useCallback(() => {
    if (!enabled.current || !ref.current) return;
    ref.current.style.setProperty('--tz', `${lift}px`);
  }, [lift]);

  const onLeave = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    next.current = { rx: 0, ry: 0, mx: 50, my: 50 };
    el.style.setProperty('--rx', '0deg');
    el.style.setProperty('--ry', '0deg');
    el.style.setProperty('--tz', '0px');
  }, []);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  return (
    <Tag
      ref={ref}
      className={className}
      style={style}
      onPointerMove={onMove}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      {children}
    </Tag>
  );
}
