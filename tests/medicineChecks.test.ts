import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  checkGtinChecksum,
  checkExpiry,
  checkMfgVsExpiry,
  checkBatchMismatch,
  checkExpiryMismatch,
  checkPackaging,
  checkClonedSerial,
  checkDrapRegistration,
  checkGtinCatalog,
  checkDrapAlert,
  checkGs1Registry,
  normaliseBatch,
  parsePrintedDate,
  type MedicineEntry,
  type DrapAlertRow,
  type PriorSerialScan,
} from "../src/services/medicineChecks";
import type { MedicinePrinted, PharmaPackagingFlags } from "../src/services/geminiVision";

const NOW = new Date("2026-11-05T08:00:00Z");

const printed = (over: Partial<MedicinePrinted> = {}): MedicinePrinted => ({
  brandName: "DEMO Paracetol", genericName: "Paracetamol", strength: "500 mg", dosageForm: "Tablet",
  packSize: "10 x 10", manufacturer: "Demo Pharma", drapRegNo: "999901", batch: "AB12",
  mfgDate: "01/2026", expiryDate: "12/2028", mrp: "Rs. 120", ...over,
});

const entry = (over: Partial<MedicineEntry> = {}): MedicineEntry => ({
  id: "m1", gtin: "02000000000015", registration_no: "999901", brand_name: "DEMO Paracetol",
  generic_name: "Paracetamol", strength: "500 mg", dosage_form: "Tablet", manufacturer: "Demo Pharma",
  source: "Medicine", ...over,
});

const noFlags: PharmaPackagingFlags = {
  blurryPrint: false, blisterFoilDefect: false, sealBroken: false, spellingErrors: false, logoMismatch: false,
  stripBoxMismatch: false, missingRegNo: false, missingUrduOrMrp: false, missingKeepOutOfReach: false,
};

describe("normalisers", () => {
  test("batch: case, separators and look-alike letters", () => {
    assert.equal(normaliseBatch("ab-12 / 0s"), "AB1205");
    assert.equal(normaliseBatch("BO1I"), normaliseBatch("B011"));
    assert.equal(normaliseBatch(""), null);
  });
  test("printed dates", () => {
    assert.equal(parsePrintedDate("EXP 12/2028"), "2028-12-31");
    assert.equal(parsePrintedDate("DEC 2028"), "2028-12-31");
    assert.equal(parsePrintedDate("31.12.2028"), "2028-12-31");
    assert.equal(parsePrintedDate("rubbish"), null);
  });
});

describe("gtinChecksum", () => {
  test("valid GTIN-14 and EAN-13 pass", () => {
    assert.equal(checkGtinChecksum("02000000000015").status, "pass");
    assert.equal(checkGtinChecksum("8901030873874").status, "pass");
  });
  test("bad check digit is a critical fail", () => {
    const r = checkGtinChecksum("02000000000016");
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "critical");
  });
  test("no code is skipped", () => assert.equal(checkGtinChecksum(null).status, "skipped"));
});

describe("expiry", () => {
  test("past is critical fail", () => {
    const r = checkExpiry("2026-10-31", NOW);
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "critical");
    assert.match(r.reasonEn, /do not use/i);
  });
  test("the expiry day itself is still valid", () => assert.notEqual(checkExpiry("2026-11-05", NOW).status, "fail"));
  test("within 30 days warns", () => {
    const r = checkExpiry("2026-11-30", NOW);
    assert.equal(r.status, "warn");
  });
  test("more than 6 years out is a medium warning", () => {
    const r = checkExpiry("2033-01-31", NOW);
    assert.equal(r.status, "warn");
    assert.equal(r.severity, "medium");
  });
  test("normal expiry passes; missing is skipped", () => {
    assert.equal(checkExpiry("2028-12-31", NOW).status, "pass");
    assert.equal(checkExpiry(null, NOW).status, "skipped");
  });
});

describe("mfgVsExpiry", () => {
  test("mfg after expiry fails high", () => {
    const r = checkMfgVsExpiry("2029-01-01", "2028-12-31", NOW);
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "high");
  });
  test("mfg in the future fails", () => assert.equal(checkMfgVsExpiry("2027-01-01", "2029-01-01", NOW).status, "fail"));
  test("consistent dates pass; missing mfg skipped", () => {
    assert.equal(checkMfgVsExpiry("2026-01-31", "2028-12-31", NOW).status, "pass");
    assert.equal(checkMfgVsExpiry(null, "2028-12-31", NOW).status, "skipped");
  });
});

describe("batchMismatch / expiryMismatch", () => {
  test("batch equal after normalisation passes", () => assert.equal(checkBatchMismatch("AB-12", "ab 12").status, "pass"));
  test("O/0 misread is not a mismatch", () => assert.equal(checkBatchMismatch("B0O1", "BOO1").status, "pass"));
  test("different batch is critical fail", () => {
    const r = checkBatchMismatch("AB12", "XY99");
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "critical");
  });
  test("a missing side is skipped", () => {
    assert.equal(checkBatchMismatch(null, "AB12").status, "skipped");
    assert.equal(checkBatchMismatch("AB12", null).status, "skipped");
  });
  test("expiry compared on month + year", () => {
    assert.equal(checkExpiryMismatch("2028-12-31", "12/2028").status, "pass");
    assert.equal(checkExpiryMismatch("2028-12-31", "11/2028").status, "fail");
    assert.equal(checkExpiryMismatch("2028-12-31", null).status, "skipped");
  });
});

describe("packaging", () => {
  test("clean pack passes", () => assert.equal(checkPackaging({ tampering: false, pharmaPackaging: noFlags }, true).status, "pass"));
  test("broken seal fails high", () => {
    const r = checkPackaging({ tampering: false, pharmaPackaging: { ...noFlags, sealBroken: true } }, true);
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "high");
  });
  test("missing Urdu/MRP is only a low warning, and only with a back photo", () => {
    const flags = { ...noFlags, missingUrduOrMrp: true };
    const withBack = checkPackaging({ tampering: false, pharmaPackaging: flags }, true);
    assert.equal(withBack.status, "warn");
    assert.equal(withBack.severity, "low");
    assert.equal(checkPackaging({ tampering: false, pharmaPackaging: flags }, false).status, "pass");
  });
  test("no inspection returned is skipped", () => assert.equal(checkPackaging({ tampering: false, pharmaPackaging: null }, true).status, "skipped"));
});

describe("clonedSerial", () => {
  const opts = { maxKm: 20, maxScans: 3 };
  const prior = (over: Partial<PriorSerialScan>): PriorSerialScan => ({
    id: "s0", area_name: "Clifton", latitude: null, longitude: null, customer_id: "other",
    reporter: "c:other", created_at: "2026-11-04T08:00:00Z", ...over,
  });
  const current = { area: "Gulberg", latitude: null, longitude: null, reporter: "c:me", customerId: "me", now: NOW };

  test("first scan passes", () => assert.equal(checkClonedSerial([], current, opts).status, "pass"));
  test("same serial in another area is critical", () => {
    const r = checkClonedSerial([prior({})], current, opts);
    assert.equal(r.status, "fail");
    assert.equal(r.severity, "critical");
    assert.match(r.reasonEn, /already scanned in Clifton/);
  });
  test("more than 20 km away is critical even without area names", () => {
    const r = checkClonedSerial(
      [prior({ area_name: null, latitude: 24.86, longitude: 67.0 })],
      { ...current, area: null, latitude: 31.52, longitude: 74.35 },
      opts
    );
    assert.equal(r.status, "fail");
  });
  test("many scans in the same area is a high warning", () => {
    const same = [1, 2, 3].map((i) => prior({ id: `s${i}`, area_name: "Gulberg", customer_id: `u${i}`, reporter: `c:u${i}` }));
    const r = checkClonedSerial(same, current, opts);
    assert.equal(r.status, "warn");
    assert.equal(r.severity, "high");
  });
  test("same customer re-scanning within 24h is ignored", () => {
    const mine = prior({ customer_id: "me", reporter: "c:me", created_at: "2026-11-05T01:00:00Z" });
    assert.equal(checkClonedSerial([mine], current, opts).status, "pass");
  });
  test("same customer after 24h in another area still counts", () => {
    const mine = prior({ customer_id: "me", reporter: "c:me", created_at: "2026-11-01T01:00:00Z" });
    assert.equal(checkClonedSerial([mine], current, opts).status, "fail");
  });
});

describe("official records", () => {
  test("drapRegistration: match passes, different product fails high, not found warns", () => {
    assert.equal(checkDrapRegistration("999901", entry(), printed()).status, "pass");
    const other = checkDrapRegistration("999901", entry({ brand_name: "Brufen" }), printed());
    assert.equal(other.status, "fail");
    assert.equal(other.severity, "high");
    const missing = checkDrapRegistration("123456", null, printed());
    assert.equal(missing.status, "warn");
    assert.match(missing.reasonEn, /not in our DRAP list/);
    assert.equal(checkDrapRegistration(null, null, printed()).status, "skipped");
  });
  test("gtinCatalog: match passes, mismatch fails high, not found skipped", () => {
    assert.equal(checkGtinCatalog("02000000000015", entry(), printed()).status, "pass");
    assert.equal(checkGtinCatalog("02000000000015", entry({ brand_name: "Augmentin" }), printed()).status, "fail");
    assert.equal(checkGtinCatalog("02000000000015", null, printed()).status, "skipped");
  });
  test("drapAlert: exact batch critical, product-only low warning, none pass", () => {
    const alert: DrapAlertRow = {
      product_name: "DEMO Paracetol", generic_name: null, batch_no: "FAKE-001", batch_norm: "FAKE001",
      manufacturer_claimed: null, alert_type: "falsified", alert_date: "2026-10-01", source_url: "https://www.dra.gov.pk/alert/1",
    };
    const hit = checkDrapAlert([alert], "DEMO Paracetol 500mg", "fake 001");
    assert.equal(hit.status, "fail");
    assert.equal(hit.severity, "critical");
    assert.match(hit.reasonEn, /Flagged by DRAP/);
    assert.equal(hit.evidence?.source_url, "https://www.dra.gov.pk/alert/1");
    const productOnly = checkDrapAlert([alert], "DEMO Paracetol", "OTHER9");
    assert.equal(productOnly.status, "warn");
    assert.equal(productOnly.severity, "low");
    assert.equal(checkDrapAlert([], "DEMO Paracetol", "AB12").status, "pass");
    assert.equal(checkDrapAlert([alert], "Brufen", "FAKE-001").status, "pass");
  });
  test("gs1Registry: skipped unless configured", () => {
    assert.equal(checkGs1Registry(null).status, "skipped");
    assert.equal(checkGs1Registry("valid").status, "pass");
    assert.equal(checkGs1Registry("invalid").status, "fail");
  });
});
