/**
 * lib/medicineView.ts
 *
 * Client-safe helpers that turn a scan's `medicine` payload into the rows the
 * EXISTING result screens already know how to draw — no new screens or
 * components. Values prefer the DataMatrix, then the print, then the
 * catalogue. A row is only shown when it has a value: nothing is filled in.
 */

import type { MedicineResult } from './api';
import { MEDICINE_COPY, MEDICINE_FIELD_LABELS, maskSerial, type BilingualPhrase } from './verdictCopy';

export interface MedicineDetailRow {
  label: BilingualPhrase;
  value: BilingualPhrase;
  /** Latin-script data (codes, dates) — render left-to-right in both languages. */
  mono?: boolean;
}

const plain = (v: string): BilingualPhrase => ({ en: v, ur: v });

function registrationValue(m: MedicineResult): BilingualPhrase | null {
  const reg = m.registration;
  if (!reg.regNo) return null;
  if (m.registrationMismatch) return { en: `${reg.regNo} — registered to another product`, ur: `${reg.regNo} — کسی اور مصنوع کا` };
  if (reg.status === 'found') return { en: `${reg.regNo} — in our DRAP list`, ur: `${reg.regNo} — ہماری ڈریپ فہرست میں` };
  if (reg.status === 'not_found') return { en: `${reg.regNo} — not in our DRAP list`, ur: `${reg.regNo} — ہماری ڈریپ فہرست میں نہیں` };
  return plain(reg.regNo);
}

export function medicineDetailRows(m: MedicineResult): MedicineDetailRow[] {
  const p = m.printed;
  const c = m.identity.product;
  const expiry = m.expiry.date
    ? m.expiry.expired
      ? { en: `${m.expiry.date} (expired)`, ur: `${m.expiry.date} (میعاد ختم)` }
      : plain(m.expiry.date)
    : null;
  const text = (v: string | null | undefined) => (v ? plain(v) : null);
  const rows: { label: BilingualPhrase; value: BilingualPhrase | null; mono?: boolean }[] = [
    { label: MEDICINE_FIELD_LABELS.name, value: text(p?.brandName ?? c?.product_name) },
    { label: MEDICINE_FIELD_LABELS.generic, value: text(p?.genericName ?? c?.generic_name) },
    { label: MEDICINE_FIELD_LABELS.strength, value: text(p?.strength ?? c?.strength) },
    { label: MEDICINE_FIELD_LABELS.dosageForm, value: text(p?.dosageForm ?? c?.dosage_form) },
    { label: MEDICINE_FIELD_LABELS.manufacturer, value: text(p?.manufacturer ?? c?.manufacturer) },
    { label: MEDICINE_FIELD_LABELS.regNo, value: registrationValue(m), mono: true },
    { label: MEDICINE_FIELD_LABELS.batch, value: text(m.gs1?.batch ?? p?.batch), mono: true },
    { label: MEDICINE_FIELD_LABELS.mfgDate, value: text(m.gs1?.mfgDate ?? p?.mfgDate), mono: true },
    { label: MEDICINE_FIELD_LABELS.expiry, value: expiry, mono: true },
    { label: MEDICINE_FIELD_LABELS.serial, value: text(maskSerial(m.gs1?.serial)), mono: true },
    { label: MEDICINE_FIELD_LABELS.gtin, value: text(m.gs1?.gtin), mono: true },
  ];
  return rows.filter((r): r is MedicineDetailRow => r.value !== null);
}

const STATUS_MARK: Record<string, string> = { pass: '✓', fail: '✗', warn: '!' };

/**
 * The "Checks performed" list: one line per check that ran — ✓ pass,
 * ✗ fail, ! warning. Skipped checks are hidden. Results cached before this
 * format (no `reasonEn`) render nothing rather than a broken line.
 */
export function medicineCheckLines(m: MedicineResult): { key: string; en: string; ur: string }[] {
  return (m.checks ?? [])
    .filter((c) => c.status !== 'skipped' && STATUS_MARK[c.status] && c.reasonEn)
    .map((c) => ({ key: c.id, en: `${STATUS_MARK[c.status]} ${c.reasonEn}`, ur: `${STATUS_MARK[c.status]} ${c.reasonUr}` }));
}

/** "Sources checked: DRAP alerts, ShelfWatch scan history" — only sources that ran. */
export function medicineSourcesLine(m: MedicineResult): BilingualPhrase | null {
  if (!m.sourcesConsulted?.length) return null;
  const list = m.sourcesConsulted.join(', ');
  return { en: `${MEDICINE_COPY.sourcesChecked.en}: ${list}`, ur: `${MEDICINE_COPY.sourcesChecked.ur}: ${list}` };
}

/** A medicine's positive outcome is never labelled "Genuine". */
export function isMedicineNoProblems(m: MedicineResult | null | undefined): boolean {
  return m?.verdict?.status === 'no_problems';
}
