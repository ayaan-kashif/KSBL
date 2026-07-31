/**
 * lib/evolutionApi.ts
 *
 * Client + payload parser for a self-hosted Evolution API instance
 * (https://github.com/EvolutionAPI/evolution-api).
 *
 * Evolution is an unofficial WhatsApp gateway that holds the WebSocket session
 * to WhatsApp on a long-lived server (Docker/VPS) and forwards inbound messages
 * to a webhook. It is a different transport from Meta's official Cloud API:
 *
 *                        Meta Cloud API              Evolution API
 *   inbound payload      entry[].changes[].value     { event, instance, data }
 *   auth on webhook      HMAC x-hub-signature-256    shared `apikey` header
 *   image delivery       media id → 2 REST hops      inline base64 (opt-in)
 *   outbound send        graph.facebook.com/{id}     {base}/message/sendText/{inst}
 *
 * Both transports are supported side by side — see the webhook route, which
 * sniffs the payload shape rather than being configured for one or the other.
 *
 * Env vars:
 *   EVOLUTION_API_URL       base URL of the instance, e.g. https://evo.example.com
 *   EVOLUTION_API_KEY       global/instance API key, sent as the `apikey` header
 *   EVOLUTION_INSTANCE      instance name the number is registered under
 *   EVOLUTION_WEBHOOK_TOKEN optional shared secret guarding the inbound webhook
 */

/** Evolution wraps every webhook in this envelope, whatever the event. */
export interface EvolutionWebhookPayload {
  event?: string;
  instance?: string;
  apikey?: string;
  data?: EvolutionMessageData;
}

interface EvolutionMessageData {
  key?: {
    remoteJid?: string;
    fromMe?: boolean;
    id?: string;
  };
  pushName?: string;
  messageType?: string;
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: {
      mimetype?: string;
      caption?: string;
      /** Present on some builds when base64 delivery is enabled. */
      base64?: string;
    };
    /** The usual location of the inline image when `base64: true` is set. */
    base64?: string;
  };
  /** Some builds hoist base64 to the top of `data` instead of under `message`. */
  base64?: string;
}

/** What the webhook actually needs out of an inbound Evolution message. */
export interface ParsedEvolutionMessage {
  /** Bare MSISDN, e.g. "923001234567" — no @s.whatsapp.net suffix. */
  senderNumber: string;
  /** Original JID, kept for logging. */
  remoteJid: string;
  kind: "image" | "text" | "other";
  /** Only set when kind === "image" and base64 delivery is enabled. */
  imageBase64: string | null;
  imageMimeType: string;
  /** Caption on an image, or the body of a text message. */
  text: string | null;
}

/**
 * `true` when the body looks like an Evolution envelope rather than a Meta one.
 * Meta payloads carry `object: "whatsapp_business_account"` and no `event`.
 */
export function isEvolutionPayload(body: unknown): body is EvolutionWebhookPayload {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.event === "string" && "data" in b;
}

/** Normalises the several event spellings Evolution has shipped over time. */
export function isMessagesUpsert(event: string | undefined): boolean {
  if (!event) return false;
  return event.toLowerCase().replace(/[._-]/g, "") === "messagesupsert";
}

/**
 * Pulls the fields we care about out of a MESSAGES_UPSERT payload.
 *
 * Returns null for anything not worth running the pipeline on: our own
 * outbound echoes (`fromMe`), group traffic, and status broadcasts. Skipping
 * `fromMe` matters — Evolution echoes the bot's OWN replies back through the
 * same webhook, so processing them would loop the bot against itself.
 */
export function parseEvolutionMessage(
  payload: EvolutionWebhookPayload
): ParsedEvolutionMessage | null {
  const data = payload.data;
  const remoteJid = data?.key?.remoteJid;
  if (!data || !remoteJid) return null;

  if (data.key?.fromMe) return null;
  // Groups (@g.us) and the status feed are not 1:1 verification requests.
  if (remoteJid.endsWith("@g.us") || remoteJid.startsWith("status@")) return null;

  const senderNumber = remoteJid.split("@")[0];
  if (!senderNumber) return null;

  const message = data.message;
  const imageMessage = message?.imageMessage;

  // base64 has lived in three places across Evolution versions; accept any.
  const imageBase64 =
    message?.base64 ?? imageMessage?.base64 ?? data.base64 ?? null;

  if (imageMessage) {
    return {
      senderNumber,
      remoteJid,
      kind: "image",
      imageBase64: imageBase64 ? stripDataUrlPrefix(imageBase64) : null,
      imageMimeType: imageMessage.mimetype?.split(";")[0] || "image/jpeg",
      text: imageMessage.caption ?? null,
    };
  }

  const text = message?.conversation ?? message?.extendedTextMessage?.text ?? null;
  if (text !== null) {
    return {
      senderNumber,
      remoteJid,
      kind: "text",
      imageBase64: null,
      imageMimeType: "image/jpeg",
      text,
    };
  }

  return {
    senderNumber,
    remoteJid,
    kind: "other",
    imageBase64: null,
    imageMimeType: "image/jpeg",
    text: null,
  };
}

/** Evolution sometimes prefixes the payload with a data URL header. */
function stripDataUrlPrefix(base64: string): string {
  const comma = base64.indexOf(",");
  return base64.startsWith("data:") && comma !== -1
    ? base64.slice(comma + 1)
    : base64;
}

/** Decodes inline base64 into the Blob `verifyProduct` expects. */
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const buffer = Buffer.from(base64, "base64");
  // Copy into a plain ArrayBuffer — Buffer views a pooled allocation, so
  // handing its backing store straight to Blob can attach unrelated bytes.
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return new Blob([bytes], { type: mimeType });
}

/** Reads config at call time (not module load) so tests can vary the env. */
function evolutionConfig() {
  const baseUrl = process.env.EVOLUTION_API_URL?.replace(/\/+$/, "");
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  return { baseUrl, apiKey, instance };
}

export function isEvolutionConfigured(): boolean {
  const { baseUrl, apiKey, instance } = evolutionConfig();
  return Boolean(baseUrl && apiKey && instance);
}

/**
 * Sends a plain-text WhatsApp reply through Evolution.
 * Never throws — a failed reply must not take down the webhook.
 */
export async function sendEvolutionText(to: string, text: string): Promise<boolean> {
  const { baseUrl, apiKey, instance } = evolutionConfig();

  if (!baseUrl || !apiKey || !instance) {
    console.warn(
      "[Evolution] EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE not all set — skipping reply"
    );
    return false;
  }

  try {
    const res = await fetch(`${baseUrl}/message/sendText/${instance}`, {
      method: "POST",
      headers: {
        apikey: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ number: to, text }),
    });

    if (!res.ok) {
      console.error(
        `[Evolution] sendText failed (${res.status}):`,
        await res.text().catch(() => "<unreadable body>")
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("[Evolution] sendText threw:", err);
    return false;
  }
}

/**
 * Guards the inbound webhook. Evolution does not sign payloads the way Meta
 * does, so the only thing standing between the endpoint and the open internet
 * is a shared secret. Unset means open — logged loudly, allowed for local dev.
 */
export function isAuthorizedEvolutionRequest(headers: Headers): boolean {
  const expected = process.env.EVOLUTION_WEBHOOK_TOKEN;
  if (!expected) {
    console.warn(
      "[Evolution] EVOLUTION_WEBHOOK_TOKEN not set — webhook is unauthenticated. Set it before exposing this endpoint publicly."
    );
    return true;
  }
  const provided =
    headers.get("apikey") ??
    headers.get("x-evolution-token") ??
    headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return provided === expected;
}
