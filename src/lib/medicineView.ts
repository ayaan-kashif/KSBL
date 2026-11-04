/**
 * lib/medicineView.ts
 *
 * Client-safe helpers that turn a scan's `medicine` payload into the rows the
 * EXISTING result screens already know how to draw — no new screens or
 * components. Values prefer the DataMatrix, then the print, then the
 * catalogue; anything none of them has is shown as "Not visible".
 */

import type { MedicineResult } from './api';
import { MEDICINE_COPY, MEDICINE_FIELD_LABELS, maskSerial, type BilingualPhrase } from './verdictCopy';

export interface MedicineDetailRow {
  label: BilingualPhrase;
  value: BilingualPhrase;
  /** Latin-script data (codes, dates) — render left-to-right in both languages. */
  mono?: boolean;
}

const plain = (v: string | null | undefined): BilingualPhrase =>
  v ? { en: v, ur: v } : MEDICINE_COPY.notVisible;

function registrationValue(m: MedicineResult): BilingualPhrase {
  const reg = m.registration;
  if (!reg.regNo) return MEDICINE_COPY.notVisible;
  if (m.registrationMismatch) return { en: `${reg.regNo} — registered to another product`, ur: `${reg.regNo} — کسی اور مصنوع کا` };
  if (reg.status === 'found') return { en: `${reg.regNo} — listed by DRAP`, ur: `${reg.regNo} — ڈریپ میں درج` };
  if (reg.status === 'not_found') return { en: `${reg.regNo} — not in DRAP's price list`, ur: `${reg.regNo} — ڈریپ کی قیمتوں کی فہرست میں نہیں` };
  return { en: `${reg.regNo} — not checked`, ur: `${reg.regNo} — جانچ نہیں ہو سکی` };
}

export function medicineDetailRows(m: MedicineResult): MedicineDetailRow[] {
  const p = m.printed;
  const c = m.identity.product;
  const expiry = m.expiry.date
    ? m.expiry.expired
      ? { en: `${m.expiry.date} (expired)`, ur: `${m.expiry.date} (میعاد ختم)` }
      : plain(m.expiry.date)
    : MEDICINE_COPY.notVisible;
  return [
    { label: MEDICINE_FIELD_LABELS.name, value: plain(p?.brandName ?? c?.product_name) },
    { label: MEDICINE_FIELD_LABELS.generic, value: plain(p?.genericName ?? c?.generic_name) },
    { label: MEDICINE_FIELD_LABELS.strength, value: plain(p?.strength ?? c?.strength) },
    { label: MEDICINE_FIELD_LABELS.dosageForm, value: plain(p?.dosageForm ?? c?.dosage_form) },
    { label: MEDICINE_FIELD_LABELS.manufacturer, value: plain(p?.manufacturer ?? c?.manufacturer) },
    { label: MEDICINE_FIELD_LABELS.regNo, value: registrationValue(m), mono: true },
    { label: MEDICINE_FIELD_LABELS.batch, value: plain(m.gs1?.batch ?? p?.batch), mono: true },
    { label: MEDICINE_FIELD_LABELS.mfgDate, value: plain(m.gs1?.mfgDate ?? p?.mfgDate), mono: true },
    { label: MEDICINE_FIELD_LABELS.expiry, value: expiry, mono: true },
    { label: MEDICINE_FIELD_LABELS.serial, value: plain(maskSerial(m.gs1?.serial)), mono: true },
    { label: MEDICINE_FIELD_LABELS.gtin, value: plain(m.gs1?.gtin), mono: true },
  ];
}

/** "Sources checked: DRAP price index, AGP Limited catalogue" — only sources that ran. */
export function medicineSourcesLine(m: MedicineResult): BilingualPhrase | null {
  if (!m.sourcesConsulted?.length) return null;
  const list = m.sourcesConsulted.join(', ');
  return { en: `${MEDICINE_COPY.sourcesChecked.en}: ${list}`, ur: `${MEDICINE_COPY.sourcesChecked.ur}: ${list}` };
}

/** A medicine's positive outcome is never labelled "Genuine". */
export function isMedicineNoProblems(m: MedicineResult | null | undefined): boolean {
  return m?.verdict?.status === 'no_problems';
}
