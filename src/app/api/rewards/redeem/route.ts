/**
 * POST /api/rewards/redeem   body: { offer_id }
 *
 * Spends the logged-in customer's points on a reward offer and issues a
 * voucher valid for 30 days.
 *
 * The balance check and the point spend are read-then-write, not atomic —
 * PostgREST has no atomic decrement without a custom RPC. Two concurrent
 * redemptions by the same customer could both pass the check and overdraw.
 * Noted in TODO-horeca.md; out of scope for the demo.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCustomerIdFromRequest } from "@/lib/customer";
import { supabaseConfig, restHeaders, generateVoucherCode } from "@/lib/vouchers";

const VOUCHER_VALID_DAYS = 30;
/** Retries a unique-violation on Voucher.code. 8 chars from a 32-symbol
 *  alphabet makes a collision vanishingly unlikely, but a duplicate would
 *  otherwise surface to the customer as a failed redemption with their points
 *  already gone. */
const MAX_CODE_ATTEMPTS = 5;

export async function POST(req: NextRequest) {
  const customerId = await getCustomerIdFromRequest(req);
  if (!customerId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const config = supabaseConfig();
  if (!config) {
    return NextResponse.json({ error: "Supabase configuration is missing on server" }, { status: 500 });
  }

  let offerId: string | undefined;
  try {
    ({ offer_id: offerId } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!offerId) {
    return NextResponse.json({ error: "offer_id is required" }, { status: 400 });
  }

  const headers = restHeaders(config.key);

  try {
    // ── Offer ────────────────────────────────────────────────────────────────
    const offerRes = await fetch(
      `${config.url}/rest/v1/RewardOffer?id=eq.${encodeURIComponent(offerId)}&active=eq.true` +
        `&select=id,title_en,points_cost,consumer_value_pkr,partner:Partner(name,area)`,
      { headers, cache: "no-store" }
    );
    if (!offerRes.ok) {
      console.error("[POST /api/rewards/redeem] Offer lookup failed:", offerRes.status);
      return NextResponse.json({ error: "Failed to load offer" }, { status: 500 });
    }
    const offers = await offerRes.json();
    const offer = offers?.[0];
    if (!offer) {
      return NextResponse.json({ error: "Offer not found or no longer available" }, { status: 404 });
    }

    // ── Balance ──────────────────────────────────────────────────────────────
    const userRes = await fetch(
      `${config.url}/rest/v1/User?id=eq.${encodeURIComponent(customerId)}&select=score_points`,
      { headers, cache: "no-store" }
    );
    if (!userRes.ok) {
      console.error("[POST /api/rewards/redeem] User lookup failed:", userRes.status);
      return NextResponse.json({ error: "Failed to load your points balance" }, { status: 500 });
    }
    const users = await userRes.json();
    const balance: number = users?.[0]?.score_points ?? 0;

    if (balance < offer.points_cost) {
      const shortfall = offer.points_cost - balance;
      return NextResponse.json(
        {
          error: `You need ${shortfall} more point${shortfall === 1 ? "" : "s"} to redeem this reward`,
          shortfall,
          points_cost: offer.points_cost,
          balance,
        },
        { status: 400 }
      );
    }

    // ── Issue the voucher BEFORE spending the points ─────────────────────────
    // If the insert fails the customer keeps their points; the reverse order
    // could take the points and hand back nothing.
    const expiresAt = new Date(Date.now() + VOUCHER_VALID_DAYS * 24 * 60 * 60 * 1000);
    let voucher: { id: string; code: string; expires_at: string } | null = null;

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && !voucher; attempt++) {
      const insertRes = await fetch(`${config.url}/rest/v1/Voucher`, {
        method: "POST",
        headers: restHeaders(config.key, {
          "Content-Type": "application/json",
          Prefer: "return=representation",
        }),
        body: JSON.stringify({
          user_id: customerId,
          offer_id: offer.id,
          code: generateVoucherCode(),
          status: "issued",
          expires_at: expiresAt.toISOString(),
        }),
      });

      if (insertRes.ok) {
        voucher = (await insertRes.json())?.[0] ?? null;
        break;
      }
      // 409 = unique violation on code — regenerate and retry. Anything else
      // is a real failure.
      if (insertRes.status !== 409) {
        console.error("[POST /api/rewards/redeem] Voucher insert failed:", insertRes.status, await insertRes.text());
        return NextResponse.json({ error: "Failed to issue voucher" }, { status: 500 });
      }
    }

    if (!voucher) {
      return NextResponse.json({ error: "Failed to issue voucher" }, { status: 500 });
    }

    // ── Spend the points ─────────────────────────────────────────────────────
    const newBalance = balance - offer.points_cost;
    const spendRes = await fetch(`${config.url}/rest/v1/User?id=eq.${encodeURIComponent(customerId)}`, {
      method: "PATCH",
      headers: restHeaders(config.key, {
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      }),
      body: JSON.stringify({ score_points: newBalance }),
    });
    if (!spendRes.ok) {
      // The voucher is already issued and valid, so this is logged rather than
      // failed — the customer is not told a successful redemption failed.
      console.error("[POST /api/rewards/redeem] Point spend failed after issuing voucher:", spendRes.status);
    }

    return NextResponse.json(
      {
        voucher: {
          id: voucher.id,
          code: voucher.code,
          expires_at: voucher.expires_at,
          status: "issued",
        },
        offer: {
          id: offer.id,
          title_en: offer.title_en,
          consumer_value_pkr: offer.consumer_value_pkr,
          points_cost: offer.points_cost,
          partner_name: offer.partner?.name ?? null,
        },
        balance: newBalance,
      },
      { status: 201 }
    );
  } catch (err) {
    console.error("[POST /api/rewards/redeem] Failed:", err);
    return NextResponse.json({ error: "Failed to redeem reward" }, { status: 500 });
  }
}
