/**
 * The required medicine cases, end to end through runMedicineChecks() and
 * combineMedicineVerdict() with an in-memory data source (no network), plus
 * routing (detectMedicine) and the kill switch.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runMedicineChecks, type MedicineDataSource, type MedicineEntry, type PriorSerialScan, type DrapAlertRow } from "../src/services/medicineChecks";
import { combineMedicineVerdict } from "../src/services/scoreEngine";
import { parseGs1 } from "../src/services/gs1Parser";
import { detectMedicine, pharmaCuesInText } from "../src/services/brandRouter";
import { medicineVerificationEnabled } from "../src/lib/medicineConfig";
import type { MedicinePrinted, PharmaPackagingFlags } from "../src/services/geminiVision";

const NOW = new Date("2026-11-05T08:00:00Z");
const CATALOG: MedicineEntry = {
  id: "m1", gtin: "02000000000015", registration_no: "999901", brand_name: "DEMO Paracetol",
  generic_name: "Paracetamol", strength: "500 mg", dosage_form: "Tablet", manufacturer: "Demo Pharma", source: "Medicine",
};
const CLEAN: PharmaPackagingFlags = {
  blurryPrint: false, blisterFoilDefect: false, sealBroken: false, spellingErrors: false, logoMismatch: false,
  stripBoxMismatch: false, missingRegNo: false, missingUrduOrMrp: false, missingKeepOutOfReach: false,
};

function printed(over: Partial<MedicinePrinted> = {}): MedicinePrinted {
  return {
    brandName: "DEMO Paracetol", genericName: "Paracetamol", strength: "500 mg", dosageForm: "Tablet", packSize: null,
    manufacturer: "Demo Pharma", drapRegNo: "999901", batch: "AB12", mfgDate: "01/2026", expiryDate: "12/2028", mrp: null, ...over,
  };
}

function data(over: Partial<MedicineDataSource> & { prior?: PriorSerialScan[]; alerts?: DrapAlertRow[] } = {}): MedicineDataSource {
  return {
    priorSerialScans: async () => over.prior ?? [],
    medicineByRegNo: async (reg) => (reg === CATALOG.registration_no ? CATALOG : null),
    medicineByGtin: async (gtin) => (gtin === CATALOG.gtin ? CATALOG : null),
    drapAlerts: async () => over.alerts ?? [],
    gs1Registry: async () => null,
    ...over,
  };
}

async function assess(opts: {
  code?: string | null;
  productCode?: string | null;
  printed?: MedicinePrinted;
  data?: MedicineDataSource;
  current?: Partial<{ area: string | null; latitude: number | null; longitude: number | null; reporter: string | null; customerId: string | null }>;
  timeoutMs?: number;
}) {
  const gs1 = opts.code ? parseGs1(opts.code) : null;
  const medicine = await runMedicineChecks(
    {
      gs1: gs1?.isGs1 ? gs1 : null,
      productCode: opts.productCode ?? (gs1?.gtin ? gs1.gtin.slice(1) : null),
      printed: opts.printed ?? printed(),
      gemini: { tampering: false, pharmaPackaging: CLEAN },
      hasBackImage: true,
      current: { area: "Gulberg", latitude: null, longitude: null, reporter: "c:me", customerId: "me", ...opts.current },
      clone: { maxKm: 20, maxScans: 3 },
      now: NOW,
    },
    opts.data ?? data(),
    opts.timeoutMs
  );
  return { medicine, verdict: combineMedicineVerdict(medicine.checks, { has2dCode: medicine.has2dCode }) };
}

const VALID_CODE = "(01)02000000000015(17)281231(10)AB12(21)SN0001";
const status = (m: { checks: { id: string; status: string }[] }, id: string) => m.checks.find((c) => c.id === id)?.status;

describe("required medicine cases", () => {
  test("1. valid pack → 'No red flags found', genuine in DB, never 'genuine' wording", async () => {
    const { verdict } = await assess({ code: VALID_CODE });
    assert.equal(verdict.status, "no_problems");
    assert.equal(verdict.dbVerdict, "genuine");
    assert.match(verdict.phrase.en, /No red flags found/);
    assert.match(verdict.phrase.en, /pharmacist/);
    assert.doesNotMatch(`${verdict.phrase.en} ${verdict.reasonEn}`, /genuine|authentic/i);
    assert.equal(verdict.score, 100);
  });

  test("2. expired → own 'Expired' wording, suspicious in DB", async () => {
    const { verdict, medicine } = await assess({
      code: "(01)02000000000015(17)260930(10)AB12(21)SN0002",
      printed: printed({ expiryDate: "09/2026" }),
    });
    assert.equal(medicine.expiry.expired, true);
    assert.equal(verdict.status, "expired");
    assert.equal(verdict.dbVerdict, "suspicious");
    assert.equal(verdict.displayVerdict, "suspicious");
    assert.match(verdict.phrase.en, /Expired/);
    assert.match(verdict.reasonEn, /do not use/i);
  });

  test("3. batch mismatch → counterfeit display, 'do not use'", async () => {
    const { verdict } = await assess({ code: VALID_CODE, printed: printed({ batch: "XY99" }) });
    assert.equal(verdict.status, "counterfeit");
    assert.equal(verdict.dbVerdict, "suspicious");
    assert.equal(verdict.displayVerdict, "counterfeit");
    assert.match(verdict.phrase.en, /Do not use/);
    assert.match(verdict.reasonEn, /does not match the 2D code/);
    assert.equal(verdict.score, 40);
  });

  test("4. same GTIN + serial already scanned in another area → cloned", async () => {
    const prior: PriorSerialScan[] = [
      { id: "p1", area_name: "Clifton", latitude: null, longitude: null, customer_id: "someone", reporter: "c:someone", created_at: "2026-11-03T10:00:00Z" },
    ];
    const { verdict, medicine } = await assess({ code: VALID_CODE, data: data({ prior }) });
    assert.equal(status(medicine, "clonedSerial"), "fail");
    assert.equal(verdict.displayVerdict, "counterfeit");
    assert.match(verdict.reasonEn, /already scanned in Clifton/);
  });

  test("5. same customer re-scanning within 24h is not flagged", async () => {
    const prior: PriorSerialScan[] = [
      { id: "p1", area_name: "Clifton", latitude: null, longitude: null, customer_id: "me", reporter: "c:me", created_at: "2026-11-05T02:00:00Z" },
    ];
    const { verdict, medicine } = await assess({ code: VALID_CODE, data: data({ prior }) });
    assert.equal(status(medicine, "clonedSerial"), "pass");
    assert.equal(verdict.status, "no_problems");
  });

  test("6. batch on a DRAP alert → 'Flagged by DRAP' with date and link", async () => {
    const alerts: DrapAlertRow[] = [
      {
        product_name: "DEMO Paracetol", generic_name: "Paracetamol", batch_no: "AB-12", batch_norm: "AB12", manufacturer_claimed: null,
        alert_type: "falsified", alert_date: "2026-10-01", source_url: "https://www.dra.gov.pk/alerts/demo-1",
      },
    ];
    const { verdict, medicine } = await assess({ code: VALID_CODE, data: data({ alerts }) });
    assert.equal(verdict.displayVerdict, "counterfeit");
    assert.match(verdict.reasonEn, /Flagged by DRAP.*2026-10-01/);
    assert.equal(medicine.drapAlert?.source_url, "https://www.dra.gov.pk/alerts/demo-1");
    assert.equal(medicine.drapAlert?.alert_date, "2026-10-01");
  });

  test("7. Reg. No. not in the catalogue → unverified, never counterfeit", async () => {
    const { verdict, medicine } = await assess({
      code: null,
      productCode: null,
      printed: printed({ brandName: "Unknownol", drapRegNo: "054321" }),
    });
    assert.equal(status(medicine, "drapRegistration"), "warn");
    assert.equal(verdict.status, "unverified");
    assert.equal(verdict.dbVerdict, "unverified");
    assert.match(verdict.reasonEn, /not in our DRAP list/);
  });

  test("8. no 2D code → no penalty, GS1 checks skipped, reason says 'No 2D code (older stock?)'", async () => {
    const { verdict, medicine } = await assess({ code: null, productCode: "2000000000015" });
    assert.equal(medicine.has2dCode, false);
    for (const id of ["batchMismatch", "expiryMismatch", "clonedSerial", "gs1Registry"]) assert.equal(status(medicine, id), "skipped");
    // Catalogue + registration still match, so nothing is held against the pack.
    assert.equal(verdict.score, 100);
    assert.equal(verdict.status, "no_problems");
    assert.match(verdict.reasonEn, /No 2D code \(older stock\?\)/);
  });

  test("9. invalid GTIN check digit → suspicious (counterfeit display)", async () => {
    const { verdict, medicine } = await assess({ code: "(01)02000000000016(17)281231(10)AB12(21)SN0003" });
    assert.equal(status(medicine, "gtinChecksum"), "fail");
    assert.equal(verdict.dbVerdict, "suspicious");
    assert.equal(verdict.displayVerdict, "counterfeit");
  });

  test("10. a check that throws or times out is skipped and a verdict is still produced", async () => {
    const broken = data({
      priorSerialScans: async () => {
        throw new Error("Scan table missing");
      },
      drapAlerts: () => new Promise(() => {}), // never resolves
    });
    const { verdict, medicine } = await assess({ code: VALID_CODE, data: broken, timeoutMs: 50 });
    assert.equal(status(medicine, "clonedSerial"), "skipped");
    assert.equal(status(medicine, "drapAlert"), "skipped");
    // An unavailable critical check (DRAP alert, clone) means "we don't know":
    // never "no red flags", even with a clean 2D code.
    assert.equal(verdict.status, "unverified");
    assert.ok(verdict.reasonEn.length > 0);
  });

  test("10b. a non-critical check failing to run doesn't block 'no red flags'", async () => {
    const flaky = data({
      gs1Registry: async () => {
        throw new Error("registry down");
      },
    });
    const { verdict, medicine } = await assess({ code: VALID_CODE, data: flaky });
    assert.equal(status(medicine, "gs1Registry"), "skipped");
    assert.equal(verdict.status, "no_problems");
  });
});

describe("verdict combiner rules", () => {
  test("two warnings → suspicious; one warning → unverified", async () => {
    const one = await assess({ code: null, productCode: null, printed: printed({ drapRegNo: "054321", brandName: "X-brand" }) });
    assert.equal(one.verdict.status, "unverified");
    const two = await assess({
      code: null,
      productCode: null,
      printed: printed({ drapRegNo: "054321", brandName: "X-brand", expiryDate: "11/2026" }),
    });
    assert.equal(two.verdict.status, "suspicious");
    assert.match(two.verdict.phrase.en, /do not take it/i);
    assert.match(two.verdict.phrase.en, /DRAP/);
  });
  test("score subtracts severities and skipped checks don't count", () => {
    const v = combineMedicineVerdict(
      [
        { id: "drapRegistration", status: "warn", severity: "low", reasonEn: "a", reasonUr: "ا" },
        { id: "expiry", status: "warn", severity: "medium", reasonEn: "b", reasonUr: "ب" },
        { id: "gs1Registry", status: "skipped", severity: "high", reasonEn: "c", reasonUr: "ج" },
      ],
      { has2dCode: true }
    );
    assert.equal(v.score, 80);
    // Most severe finding first.
    assert.ok(v.reasonEn.startsWith("b"));
  });
});

describe("11. routing — non-medicine scans stay on the existing path", () => {
  test("food and other products never route to medicine", () => {
    assert.equal(detectMedicine({ serialisedGs1: false, catalogMedicine: false, visionCategory: "food", visionConfidence: 0, visionCues: [] }).isMedicine, false);
    assert.equal(detectMedicine({ serialisedGs1: false, catalogMedicine: false, visionCategory: null }).isMedicine, false);
  });
  test("vision needs confidence ≥ 0.8 AND ≥ 2 cues", () => {
    const base = { serialisedGs1: false, catalogMedicine: false, visionCategory: "medicine" as const };
    assert.equal(detectMedicine({ ...base, visionConfidence: 0.79, visionCues: ["dosage_form", "drap_reg_no"] }).isMedicine, false);
    assert.equal(detectMedicine({ ...base, visionConfidence: 0.95, visionCues: ["dosage_form"] }).isMedicine, false);
    assert.equal(detectMedicine({ ...base, visionConfidence: 0.95, visionCues: ["dosage_form", "drap_reg_no"] }).isMedicine, true);
  });
  test("National Foods and a non-medicine catalogue row override vision", () => {
    const strong = { serialisedGs1: false, catalogMedicine: false, visionCategory: "medicine" as const, visionConfidence: 1, visionCues: ["dosage_form", "drap_reg_no"] };
    assert.equal(detectMedicine({ ...strong, nationalFoods: true }).isMedicine, false);
    assert.equal(detectMedicine({ ...strong, catalogNonMedicine: true }).isMedicine, false);
  });
  test("serialised GS1 or a catalogue GTIN decide it", () => {
    assert.equal(detectMedicine({ serialisedGs1: true, catalogMedicine: false }).source, "gs1_datamatrix");
    assert.equal(detectMedicine({ serialisedGs1: false, catalogMedicine: true }).source, "medicine_catalog");
  });
  test("WhatsApp text cues: food and household text don't qualify", () => {
    const decide = (text: string) => detectMedicine({ serialisedGs1: false, catalogMedicine: false, textCues: pharmaCuesInText(text) }).isMedicine;
    assert.equal(decide("Rooh Afza syrup 800 ml"), false);
    assert.equal(decide("Finish dishwasher tablets 30 pcs"), false);
    assert.equal(decide("Nutrition: Sodium 48 mg per serving"), false);
    assert.equal(decide("Paracetamol Tablets 500 mg Reg. No. 012345"), true);
    assert.equal(decide("Each tablet contains Paracetamol BP 500 mg"), true);
  });
  test("kill switch: default on, MEDICINE_VERIFICATION_ENABLED=false turns it off", () => {
    const saved = process.env.MEDICINE_VERIFICATION_ENABLED;
    delete process.env.MEDICINE_VERIFICATION_ENABLED;
    assert.equal(medicineVerificationEnabled(), true);
    process.env.MEDICINE_VERIFICATION_ENABLED = "false";
    assert.equal(medicineVerificationEnabled(), false);
    if (saved === undefined) delete process.env.MEDICINE_VERIFICATION_ENABLED;
    else process.env.MEDICINE_VERIFICATION_ENABLED = saved;
  });
});
