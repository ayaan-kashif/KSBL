/**
 * POST /api/partner/redeem   body: { code }
 *
 * Restaurant-side redemption. Burns a voucher and credits the partner with the
 * offer's bulk_credit_pkr — the B2B pull-through number the dashboard reports.
 *
 * Unauthenticated by design for the demo (see TODO-horeca.md): anyone with the
 * URL can burn a code. Do not deploy this as-is.
 *
 * Every outcome returns HTTP 200 with a `result` discriminator rather than an
 * error status. The waiter-facing screen needs to render "already redeemed" and
 * "expired" as distinct, calm states — a 404 would surface as a generic
 * failure and lose the reason.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseConfig, restHeaders, isExpired } from "@/lib/vouchers";

export type PartnerRedeemResult = "valid" | "not_found" | "already_redeemed" | "expired";

export async function POST(req: NextRequest) {
  const config = supabaseConfig();
  if (!config) {
    return NextResponse.json({ error: "Supabase configuration is missing on server" }, { status: 500 });
  }

  let rawCode: string | undefined;
  try {
    ({ code: rawCode } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const code = (rawCode ?? "").replace(/\s+/g, "").toUpperCase();
  if (!code) {
    return NextResponse.json({ error: "code is required" }, { status: 400 });
  }

  const headers = restHeaders(config.key);

  try {
    const lookupRes = await fetch(
      `${config.url}/rest/v1/Voucher?code=eq.${encodeURIComponent(code)}` +
        `&select=id,code,status,issued_at,expires_at,redeemed_at,` +
        `offer:RewardOffer(id,title_en,title_ur,consumer_value_pkr,bulk_credit_pkr,` +
        `partner:Partner(id,name,area,bulk_credit_issued_pkr))`,
      { headers, cache: "no-store" }
    );
    if (!lookupRes.ok) {
      console.error("[POST /api/partner/redeem] Voucher lookup failed:", lookupRes.status);
      return NextResponse.json({ error: "Failed to look up voucher" }, { status: 500 });
    }

    interface VoucherRow {
      id: string;
      code: string;
      status: string;
      expires_at: string;
      redeemed_at: string | null;
      offer: {
        id: string;
        title_en: string;
        title_ur: string;
        consumer_value_pkr: number;
        bulk_credit_pkr: number;
        partner: { id: string; name: string; area: string; bulk_credit_issued_pkr: number } | null;
      } | null;
    }

    const voucher: VoucherRow | undefined = (await lookupRes.json())?.[0];

    if (!voucher) {
      return NextResponse.json({ result: "not_found" as PartnerRedeemResult, code }, { status: 200 });
    }

    if (voucher.status === "redeemed") {
      return NextResponse.json(
        {
          result: "already_redeemed" as PartnerRedeemResult,
          code: voucher.code,
          redeemed_at: voucher.redeemed_at,
          offer_title: voucher.offer?.title_en ?? null,
          partner_name: voucher.offer?.partner?.name ?? null,
        },
        { status: 200 }
      );
    }

    // Checked against expires_at, not status — nothing writes 'expired'.
    if (isExpired(voucher.expires_at)) {
      return NextResponse.json(
        {
          result: "expired" as PartnerRedeemResult,
          code: voucher.code,
          expires_at: voucher.expires_at,
          offer_title: voucher.offer?.title_en ?? null,
          partner_name: voucher.offer?.partner?.name ?? null,
        },
        { status: 200 }
      );
    }

    // ── Burn it ──────────────────────────────────────────────────────────────
    // status=eq.issued in the filter makes this a compare-and-set: a second
    // concurrent redemption of the same code matches zero rows and cannot
    // double-credit the partner.
    const redeemedAt = new Date().toISOString();
    const burnRes = await fetch(
      `${config.url}/rest/v1/Voucher?id=eq.${encodeURIComponent(voucher.id)}&status=eq.issued`,
      {
        method: "PATCH",
        headers: restHeaders(config.key, {
          "Content-Type": "application/json",
          Prefer: "return=representation",
        }),
        body: JSON.stringify({ status: "redeemed", redeemed_at: redeemedAt }),
      }
    );
    if (!burnRes.ok) {
      console.error("[POST /api/partner/redeem] Voucher update failed:", burnRes.status, await burnRes.text());
      return NextResponse.json({ error: "Failed to redeem voucher" }, { status: 500 });
    }
    const burned = await burnRes.json();
    if (!burned || burned.length === 0) {
      // Lost the race — someone redeemed it between the lookup and the update.
      return NextResponse.json(
        {
          result: "already_redeemed" as PartnerRedeemResult,
          code: voucher.code,
          redeemed_at: redeemedAt,
          offer_title: voucher.offer?.title_en ?? null,
          partner_name: voucher.offer?.partner?.name ?? null,
        },
        { status: 200 }
      );
    }

    // ── Credit the partner ───────────────────────────────────────────────────
    // Read-then-write; concurrent redemptions at one partner can lose an
    // increment (TODO-horeca.md). Logged rather than failed: the voucher is
    // already burned, and telling the waiter it failed would be wrong.
    const partner = voucher.offer?.partner;
    const bulkCredit = voucher.offer?.bulk_credit_pkr ?? 0;
    if (partner && bulkCredit > 0) {
      const creditRes = await fetch(
        `${config.url}/rest/v1/Partner?id=eq.${encodeURIComponent(partner.id)}`,
        {
          method: "PATCH",
          headers: restHeaders(config.key, {
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          }),
          body: JSON.stringify({
            bulk_credit_issued_pkr: (partner.bulk_credit_issued_pkr ?? 0) + bulkCredit,
          }),
        }
      );
      if (!creditRes.ok) {
        console.error("[POST /api/partner/redeem] Partner credit update failed:", creditRes.status);
      }
    }

    return NextResponse.json(
      {
        result: "valid" as PartnerRedeemResult,
        code: voucher.code,
        redeemed_at: redeemedAt,
        offer_title: voucher.offer?.title_en ?? null,
        offer_title_ur: voucher.offer?.title_ur ?? null,
        consumer_value_pkr: voucher.offer?.consumer_value_pkr ?? null,
        bulk_credit_pkr: bulkCredit,
        partner_name: partner?.name ?? null,
        partner_area: partner?.area ?? null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[POST /api/partner/redeem] Failed:", err);
    return NextResponse.json({ error: "Failed to redeem voucher" }, { status: 500 });
  }
}
