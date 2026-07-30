/**
 * lib/verdictCopy.ts
 *
 * Client-side mirror of the fixed verdict glossary in lib/translate.ts, plus
 * the surrounding UI chrome used on verdict screens.
 *
 * Why a separate module: lib/translate.ts is server-only (it reads
 * process.env.GEMINI_API_KEY and calls the Gemini REST API). Client components
 * that only need the *phrases* must not pull that in. The verdict phrases here
 * are duplicated verbatim from the GLOSSARY there and, like it, are FIXED —
 * they are never free-translated at runtime, so a model can't emit
 * hallucinated or offensive Urdu into a verdict headline.
 *
 * Keep the two lists in sync when either changes.
 */

export type Language = "en" | "ur";

/** Verdict keys used by the UI. `counterfeit` and `processing` exist for
 *  VerdictBadge but have no server-side glossary entry — the pipeline only
 *  ever emits genuine | suspicious | unverified. */
export type VerdictKey = "genuine" | "suspicious" | "unverified";
export type BadgeVerdict = VerdictKey | "counterfeit" | "processing";

export interface BilingualPhrase {
  en: string;
  ur: string;
}

/** Full sentences — mirrors GLOSSARY in lib/translate.ts. */
export const VERDICT_PHRASE: Record<VerdictKey, BilingualPhrase> = {
  genuine: {
    ur: "✅ اصل مصنوع — یہ مصنوع معتبر ہے",
    en: "✅ Genuine Product — This product has been verified as authentic",
  },
  suspicious: {
    ur: "⚠️ مشکوک — یہ مصنوع جعلی ہو سکتی ہے، فروخت یا خریداری سے گریز کریں",
    en: "⚠️ Suspicious — This product may be counterfeit. Avoid selling or purchasing.",
  },
  unverified: {
    ur: "❓ غیر تصدیق شدہ — یہ مصنوع ہمارے ڈیٹا بیس میں موجود نہیں",
    en: "❓ Unverified — This product was not found in our manufacturer database",
  },
};

/** Short labels for badges and table cells. */
export const VERDICT_LABEL: Record<BadgeVerdict, BilingualPhrase> = {
  genuine: { en: "Genuine", ur: "اصل" },
  suspicious: { en: "Suspicious", ur: "مشکوک" },
  counterfeit: { en: "Counterfeit", ur: "جعلی" },
  unverified: { en: "Unverified", ur: "غیر تصدیق شدہ" },
  processing: { en: "Processing…", ur: "جاری ہے…" },
};

/** UI chrome on verdict screens. */
export const UI_COPY = {
  scanAnother: { en: "Scan another", ur: "دوبارہ اسکین کریں" },
  reportProduct: { en: "Report this product", ur: "اس مصنوع کی اطلاع دیں" },
  batchCode: { en: "Batch code", ur: "بیچ کوڈ" },
  confidence: { en: "Confidence", ur: "اعتماد" },
  verifiedOn: { en: "Verified on", ur: "تصدیق کی تاریخ" },
  reason: { en: "Reason", ur: "وجہ" },
  language: { en: "Language", ur: "زبان" },
} as const satisfies Record<string, BilingualPhrase>;

/** Pick the active-language string, with the other language as secondary. */
export function pick(phrase: BilingualPhrase, lang: Language): string {
  return lang === "ur" ? phrase.ur : phrase.en;
}

/** The non-active language — both stay on screen, the toggle only reorders
 *  emphasis, so screens need the secondary string too. */
export function other(phrase: BilingualPhrase, lang: Language): string {
  return lang === "ur" ? phrase.en : phrase.ur;
}

/** Attributes for a run of Urdu text. Urdu is RTL and needs the Noto Arabic
 *  face — without lang/dir the browser reflows it wrongly and falls back to a
 *  Latin face that renders Arabic script poorly. */
export const URDU_ATTRS = { lang: "ur", dir: "rtl" as const };
