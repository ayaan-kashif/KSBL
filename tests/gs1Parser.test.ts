import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGs1, isSerialisedMedicineGs1 } from "../src/services/gs1Parser";

const GS = "\x1D";

test("bracketed (HRI) form", () => {
  const g = parseGs1("(01)02000000000015(17)281231(10)AB12(21)SN0001");
  assert.equal(g.isGs1, true);
  assert.equal(g.gtin, "02000000000015");
  assert.equal(g.expiry, "2028-12-31");
  assert.equal(g.batch, "AB12");
  assert.equal(g.serial, "SN0001");
  assert.equal(g.valid, true);
  assert.equal(isSerialisedMedicineGs1(g), true);
});

test("raw element string with GS separators", () => {
  const g = parseGs1(`010200000000001517281231` + `10AB12${GS}21SN0001`);
  assert.equal(g.gtin, "02000000000015");
  assert.equal(g.batch, "AB12");
  assert.equal(g.serial, "SN0001");
  assert.equal(g.expiry, "2028-12-31");
});

test("]d2 symbology identifier prefix", () => {
  const g = parseGs1(`]d2010200000000001521SN77${GS}17290630`);
  assert.equal(g.isGs1, true);
  assert.equal(g.serial, "SN77");
  assert.equal(g.expiry, "2029-06-30");
});

test("symbology identifier passed separately, FNC1 leading GS", () => {
  const g = parseGs1(`${GS}0102000000000015172812001`  + `0LOT9`, "]d2");
  assert.equal(g.gtin, "02000000000015");
  // DD=00 means the last day of the month.
  assert.equal(g.expiry, "2028-12-31");
  assert.equal(g.batch, "LOT9");
});

test("YYMMDD with DD=00 is end of month (February, leap year)", () => {
  const g = parseGs1("(01)02000000000015(17)280200");
  assert.equal(g.expiry, "2028-02-29");
});

test("bad GTIN check digit is parsed but not valid", () => {
  const g = parseGs1("(01)02000000000016(17)281231(21)X1");
  assert.equal(g.isGs1, true);
  assert.equal(g.gtin, "02000000000016");
  assert.equal(g.valid, false);
  // Still routed to the medicine path, where gtinChecksum fails it.
  assert.equal(isSerialisedMedicineGs1(g), true);
});

test("plain retail barcode is not GS1; food GS1 without serial is not a medicine signal", () => {
  assert.equal(parseGs1("8901030873874").isGs1, false);
  const food = parseGs1("(01)08901030873874(15)270101(10)B1");
  assert.equal(food.isGs1, true);
  assert.equal(isSerialisedMedicineGs1(food), false);
});
