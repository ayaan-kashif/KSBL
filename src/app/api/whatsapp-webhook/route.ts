/**
 * GET + POST /api/whatsapp-webhook
 *
 * Inbound WhatsApp handler. Speaks TWO transports and picks per request by
 * sniffing the payload shape, so either can be swapped in without a redeploy:
 *
 *   • Evolution API (self-hosted gateway on a VPS/Docker host)
 *       { event: "messages.upsert", instance, data: { key, message } }
 *       auth: shared `apikey` header · image arrives inline as base64
 *
 *   • Meta WhatsApp Cloud API (official)
 *       { object: "whatsapp_business_account", entry: [...] }
 *       auth: HMAC x-hub-signature-256 · image needs two REST hops to fetch
 *
 * GET  — Meta's webhook verification challenge (hub.mode/verify_token/challenge)
 * POST — Accepts a message, acks immediately, verifies in the background.
 *
 * WHY THE WORK IS DEFERRED: the verification pipeline takes several seconds
 * (OCR + CV + vector search + Gemini). Evolution retries a webhook that doesn't
 * answer quickly, which would run the pipeline repeatedly for one photo and
 * send the user duplicate verdicts. `after()` lets us return 200 right away and
 * finish the work — including the reply — once the response is flushed.
 *
 * Rate limiting: TODO (post-hackathon) add Upstash Redis rate limiting per
 *   sender phone number to prevent abuse.
 *
 * Env vars — Evolution: EVOLUTION_API_URL, EVOLUTION_API_KEY,
 *   EVOLUTION_INSTANCE, EVOLUTION_WEBHOOK_TOKEN
 * Env vars — Meta: WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET,
 *   WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID
 */

import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { verifyProduct, type VerifyResult } from "@/lib/verifyProduct";
import { getVerdictTextSync } from "@/lib/translate";
import {
  isEvolutionPayload,
  isMessagesUpsert,
  parseEvolutionMessage,
  isAuthorizedEvolutionRequest,
  base64ToBlob,
  sendEvolutionText,
  type EvolutionWebhookPayload,
} from "@/lib/evolutionApi";

/** The pipeline can run ~8s; give the background work room beyond the default. */
export const maxDuration = 60;

// ─── Meta Webhook Verification (GET) ─────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("[WhatsApp] Webhook verified successfully");
    return new NextResponse(challenge ?? "", { status: 200 });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

// ─── Inbound dispatch (POST) ─────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Read once: the body is a stream and Meta's HMAC must hash the exact bytes.
  const rawBody = await req.text();

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (isEvolutionPayload(body)) {
    return handleEvolutionRequest(req, body);
  }
  return handleMetaRequest(req, rawBody, body);
}

// ─── Evolution API path ──────────────────────────────────────────────────────

function handleEvolutionRequest(req: NextRequest, payload: EvolutionWebhookPayload) {
  if (!isAuthorizedEvolutionRequest(req.headers)) {
    console.warn("[Evolution] Rejected webhook with bad/missing token");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Evolution emits many event types (connection.update, presence.update, …).
  if (!isMessagesUpsert(payload.event)) {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const message = parseEvolutionMessage(payload);
  // Null covers our own echoes, groups and status broadcasts — ack and drop.
  if (!message) {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  if (message.kind === "image") {
    if (!message.imageBase64) {
      // The instance is forwarding images without base64 delivery enabled.
      console.error(
        "[Evolution] Image message had no base64 payload — enable `base64: true` on the webhook subscription"
      );
      after(async () => {
        await sendEvolutionText(
          message.senderNumber,
          "⚠️ تصویر وصول نہیں ہو سکی۔ دوبارہ بھیجیں۔\n\nCould not read that image. Please send it again."
        );
      });
      return NextResponse.json({ status: "ok" }, { status: 200 });
    }

    const { senderNumber, imageBase64, imageMimeType } = message;

    // Ack now, verify after the response is flushed (see file header).
    after(async () => {
      try {
        const imageBlob = base64ToBlob(imageBase64, imageMimeType);
        const result = await verifyProduct({
          imageFile: imageBlob,
          scanned_by_role: "consumer",
        });
        await sendEvolutionText(senderNumber, formatVerdictReply(result));
      } catch (err) {
        console.error("[Evolution] Verification pipeline failed:", err);
        const fallback = getVerdictTextSync("unverified");
        await sendEvolutionText(
          senderNumber,
          `${fallback.urdu_text}\n\n${fallback.english_text}`
        );
      }
    });

    return NextResponse.json({ status: "processing" }, { status: 200 });
  }

  if (message.kind === "text") {
    const { senderNumber } = message;
    after(async () => {
      await sendEvolutionText(senderNumber, INSTRUCTIONS_TEXT);
    });
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  return NextResponse.json({ status: "ok" }, { status: 200 });
}

// ─── Meta Cloud API path ─────────────────────────────────────────────────────

function handleMetaRequest(req: NextRequest, rawBody: string, body: unknown) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;

  if (appSecret) {
    const signature = req.headers.get("x-hub-signature-256");
    const expectedSig = `sha256=${createHmac("sha256", appSecret)
      .update(rawBody)
      .digest("hex")}`;

    if (!signature || !safeEqual(signature, expectedSig)) {
      console.warn("[WhatsApp] HMAC signature mismatch");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  return handleWhatsAppPayload(body as WhatsAppPayload);
}

/** Constant-time compare so a bad signature can't be probed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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

// ─── Meta core handler ────────────────────────────────────────────────────────

function handleWhatsAppPayload(payload: WhatsAppPayload) {
  if (payload?.object !== "whatsapp_business_account") {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  const phoneNumberId = change?.value?.metadata?.phone_number_id;

  if (!message || !phoneNumberId) {
    // Echo 200 to Meta even when there's nothing to process.
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  const senderPhone = message.from;

  if (message.type === "text") {
    after(async () => {
      await sendWhatsAppText(phoneNumberId, senderPhone, INSTRUCTIONS_TEXT);
    });
    return NextResponse.json({ status: "ok" }, { status: 200 });
  }

  if (message.type === "image" && message.image) {
    const imageId = message.image.id;

    after(async () => {
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
        return;
      }

      try {
        const result = await verifyProduct({
          imageFile: imageBlob,
          scanned_by_role: "consumer",
        });
        await sendWhatsAppText(phoneNumberId, senderPhone, formatVerdictReply(result));
      } catch (err) {
        console.error("[WhatsApp] Verification pipeline failed:", err);
        const fallback = getVerdictTextSync("unverified");
        await sendWhatsAppText(
          phoneNumberId,
          senderPhone,
          `${fallback.urdu_text}\n\n${fallback.english_text}`
        );
      }
    });

    return NextResponse.json({ status: "processing" }, { status: 200 });
  }

  // Other message types — acknowledge but don't process.
  return NextResponse.json({ status: "ok" }, { status: 200 });
}

// ─── Shared copy / formatting ─────────────────────────────────────────────────

const INSTRUCTIONS_TEXT =
  "📷 *ShelfWatch* یہاں ہے!\n\n" +
  "براہ کرم اپنی مصنوع کی پیکیجنگ کی تصویر بھیجیں تاکہ ہم اس کی صداقت تصدیق کریں۔\n\n" +
  "Please send a photo of the product packaging to verify its authenticity.";

/** One verdict format for both transports, so replies stay identical. */
function formatVerdictReply(result: VerifyResult): string {
  return (
    `*ShelfWatch Verification Result*\n\n` +
    `${result.urdu_text}\n\n` +
    `${result.english_text}\n\n` +
    `📊 Confidence: ${Math.round(result.confidence * 100)}%\n` +
    `📝 ${result.reason}\n\n` +
    (result.brand_name ? `🏷️ Brand: ${result.brand_name}\n` : "") +
    (result.extracted_batch ? `🔢 Batch: ${result.extracted_batch}\n` : "") +
    `\n_Scan ID: ${result.scan_id}_`
  );
}

// ─── WhatsApp Cloud API helpers ───────────────────────────────────────────────

async function downloadWhatsAppMedia(mediaId: string): Promise<Blob> {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!accessToken) throw new Error("WHATSAPP_ACCESS_TOKEN not set");

  // Step 1: Get media URL
  const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
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
