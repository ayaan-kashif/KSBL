/**
 * GET + POST /api/whatsapp-webhook
 *
 * WhatsApp Cloud API webhook handler.
 *
 * GET  — Meta webhook verification challenge (hub.mode + hub.verify_token + hub.challenge)
 * POST — Receives incoming WhatsApp messages, runs the verification pipeline,
 *         and sends a bilingual text reply.
 *
 * Rate limiting: TODO (post-hackathon) add Upstash Redis rate limiting per
 *   sender phone number to prevent abuse.
 *
 * Required env vars:
 *   WHATSAPP_VERIFY_TOKEN   — arbitrary string you set in Meta dashboard
 *   WHATSAPP_APP_SECRET     — app secret from Meta developer dashboard (for HMAC)
 *   WHATSAPP_ACCESS_TOKEN   — permanent or temp access token
 *   WHATSAPP_PHONE_NUMBER_ID — phone number ID from Meta dashboard
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { verifyProduct } from "@/lib/verifyProduct";
import { getVerdictTextSync } from "@/lib/translate";

// ─── Meta Webhook Verification (GET) ─────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (
    mode === "subscribe" &&
    token === process.env.WHATSAPP_VERIFY_TOKEN
  ) {
    console.log("[WhatsApp] Webhook verified successfully");
    return new NextResponse(challenge ?? "", { status: 200 });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

// ─── Incoming Message Handler (POST) ─────────────────────────────────────────

export async function POST(req: NextRequest) {
  // ── Rate limit note ────────────────────────────────────────────────────────
  // TODO: Rate limit per sender phone (max 10 messages/minute)

  // ── HMAC signature verification ────────────────────────────────────────────
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (appSecret) {
    const signature = req.headers.get("x-hub-signature-256");
    const rawBody = await req.text();

    const expectedSig = `sha256=${createHmac("sha256", appSecret)
      .update(rawBody)
      .digest("hex")}`;

    if (signature !== expectedSig) {
      console.warn("[WhatsApp] HMAC signature mismatch");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    // Parse after verification
    let body: WhatsAppPayload;
    try {
      body = JSON.parse(rawBody) as WhatsAppPayload;
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }
    return await handleWhatsAppPayload(body);
  }

  // Without app secret (dev/demo mode) — parse directly
  let body: WhatsAppPayload;
  try {
    body = (await req.json()) as WhatsAppPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  return await handleWhatsAppPayload(body);
}

// ─── Payload Types ────────────────────────────────────────────────────────────

interface WhatsAppPayload {
  object: string;
  entry?: Array<{
    id: string;
    changes: Array<{
      value: {
        messages?: Array<{
          id: string;
          from: string;
          type: string;
          image?: { id: string; mime_type: string };
          text?: { body: string };
        }>;
        metadata?: { phone_number_id: string };
      };
    }>;
  }>;
}

// ─── Core handler ─────────────────────────────────────────────────────────────

async function handleWhatsAppPayload(payload: WhatsAppPayload) {
  // Not a WhatsApp message event
  if (payload.object !== "whatsapp_business_account") {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  const phoneNumberId = change?.value?.metadata?.phone_number_id;

  if (!message || !phoneNumberId) {
    // Echo 200 to Meta even when nothing to process
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  const senderPhone = message.from;

  // ── Text-only message: send instructions ──────────────────────────────────
  if (message.type === "text") {
    await sendWhatsAppText(
      phoneNumberId,
      senderPhone,
      "📷 *ShelfWatch* یہاں ہے!\n\n" +
        "براہ کرم اپنی مصنوع کی پیکیجنگ کی تصویر بھیجیں تاکہ ہم اس کی صداقت تصدیق کریں۔\n\n" +
        "Please send a photo of the product packaging to verify its authenticity."
    );
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  // ── Image message: run verification ───────────────────────────────────────
  if (message.type === "image" && message.image) {
    const imageId = message.image.id;

    // Step 1: Download image from WhatsApp media URL
    let imageBlob: Blob;
    try {
      imageBlob = await downloadWhatsAppMedia(imageId);
    } catch (err) {
      console.error("[WhatsApp] Failed to download media:", err);
      await sendWhatsAppText(
        phoneNumberId,
        senderPhone,
        "⚠️ تصویر ڈاؤن لوڈ نہیں ہو سکی۔ دوبارہ کوشش کریں۔\n\nCould not download the image. Please try again."
      );
      return NextResponse.json({ status: "ok" }, { status: 200 });
    }

    // Step 2: Run verification pipeline (same as /api/scan)
    let result;
    try {
      result = await verifyProduct({
        imageFile: imageBlob,
        scanned_by_role: "consumer",
      });
    } catch (err) {
      console.error("[WhatsApp] Verification pipeline failed:", err);
      const fallback = getVerdictTextSync("unverified");
      await sendWhatsAppText(
        phoneNumberId,
        senderPhone,
        `${fallback.urdu_text}\n\n${fallback.english_text}`
      );
      return NextResponse.json({ status: "ok" }, { status: 200 });
    }

    // Step 3: Reply with verdict
    const replyText =
      `*ShelfWatch Verification Result*\n\n` +
      `${result.urdu_text}\n\n` +
      `${result.english_text}\n\n` +
      `📊 Confidence: ${Math.round(result.confidence * 100)}%\n` +
      `📝 ${result.reason}\n\n` +
      (result.brand_name ? `🏷️ Brand: ${result.brand_name}\n` : "") +
      (result.extracted_batch ? `🔢 Batch: ${result.extracted_batch}\n` : "") +
      `\n_Scan ID: ${result.scan_id}_`;

    await sendWhatsAppText(phoneNumberId, senderPhone, replyText);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  // Other message types — acknowledge but don't process
  return NextResponse.json({ status: "ok" }, { status: 200 });
}

// ─── WhatsApp Cloud API helpers ───────────────────────────────────────────────

async function downloadWhatsAppMedia(mediaId: string): Promise<Blob> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) throw new Error("WHATSAPP_ACCESS_TOKEN not set");

  // Step 1: Get media URL
  const metaRes = await fetch(
    `https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!metaRes.ok) throw new Error(`Meta media lookup failed: ${metaRes.status}`);
  const { url } = (await metaRes.json()) as { url: string };

  // Step 2: Download actual file
  const fileRes = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileRes.ok) throw new Error(`Media download failed: ${fileRes.status}`);

  return fileRes.blob();
}

async function sendWhatsAppText(
  phoneNumberId: string,
  to: string,
  text: string
): Promise<void> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) {
    console.warn("[WhatsApp] WHATSAPP_ACCESS_TOKEN not set — skipping reply");
    return;
  }

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error("[WhatsApp] Send message failed:", err);
  }
}
