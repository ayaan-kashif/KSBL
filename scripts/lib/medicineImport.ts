/**
 * scripts/lib/medicineImport.ts
 *
 * Shared bits of the medicine CSV importers: env loading, a small RFC 4180
 * CSV parser (quoted fields, "" escapes, CRLF), and Supabase REST helpers
 * using the service role key (the Medicine / DrapAlert tables are read-only
 * to the anon key).
 */

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
dotenv.config({ path: path.resolve(process.cwd(), ".env"), quiet: true });

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  const [header, ...body] = nonEmpty;
  if (!header) return [];
  const keys = header.map((h) => h.trim().replace(/^﻿/, ""));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export function readCsv(relativePath: string): Record<string, string>[] {
  const file = path.resolve(process.cwd(), relativePath);
  if (!fs.existsSync(file)) throw new Error(`CSV not found: ${file}`);
  return parseCsv(fs.readFileSync(file, "utf8"));
}

function config(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local)");
  return { url, key };
}

export async function rest<T = unknown>(method: "GET" | "POST" | "PATCH", pathAndQuery: string, body?: unknown): Promise<T> {
  const { url, key } = config();
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = /does not exist|PGRST205|Could not find the table/i.test(text)
      ? " — run prisma/sql/medicine_patch.sql in the Supabase SQL Editor first"
      : "";
    throw new Error(`${method} ${pathAndQuery.split("?")[0]} failed (${res.status}): ${text.slice(0, 300)}${hint}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** Empty CSV cells become null. */
export const orNull = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

export function printCounts(label: string, counts: { inserted: number; updated: number; unchanged: number; skipped: number }) {
  console.log(
    `${label}: ${counts.inserted} inserted, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.skipped} skipped`
  );
}
