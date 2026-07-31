/**
 * lib/embeddings.ts
 *
 * Generates CLIP image embeddings for RAG-style vector similarity search.
 *
 * This is deliberately separate from lib/cv.ts: cv.ts calls HF's
 * zero-shot-image-classification pipeline (returns label scores), while this
 * calls the feature-extraction pipeline on the same family of CLIP models
 * (returns a raw embedding vector). Different HF pipeline, different output
 * shape, same provider/auth.
 *
 * Required env vars:
 *   HUGGINGFACE_API_KEY — shared with lib/cv.ts
 *   EMBED_MODEL_ID       — (optional) override model, default: openai/clip-vit-base-patch32
 *   EMBEDDING_DIM         — (optional) must match the model's output dimension
 *                            AND the "vector(N)" column size in prisma/sql/pgvector_setup.sql
 *
 * Fallback: returns null on error, missing key, or timeout. Never throws.
 * Callers must treat null as "no embedding available" and fall back gracefully.
 */

const DEFAULT_EMBED_MODEL = "openai/clip-vit-base-patch32";
const DEFAULT_EMBEDDING_DIM = 512;
const EMBED_TIMEOUT_MS = 6000;

export const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM) || DEFAULT_EMBEDDING_DIM;

/**
 * HF feature-extraction can return a flat vector (number[]) or a nested
 * per-token/per-patch matrix (number[][]) depending on the model. Mean-pool
 * the nested case down to a single vector.
 */
function normalizeEmbedding(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  if (typeof raw[0] === "number") {
    return raw as number[];
  }

  if (Array.isArray(raw[0])) {
    const rows = raw as number[][];
    const dim = rows[0].length;
    const pooled = new Array(dim).fill(0);
    for (const row of rows) {
      for (let i = 0; i < dim; i++) pooled[i] += row[i] ?? 0;
    }
    return pooled.map((v) => v / rows.length);
  }

  return null;
}

// ─── Local CLIP ───────────────────────────────────────────────────────────────
// HuggingFace's free serverless inference no longer serves ANY image
// feature-extraction model — CLIP, ViT and DINOv2 all return
// "Model not supported by provider hf-inference", and the old
// api-inference.huggingface.co host no longer resolves. Since the catalogue is
// useless without embeddings, the model runs locally instead: same
// architecture, same 512 dimensions, no API key, no rate limit.
//
// Weights (~90MB) download once into the transformers cache, then load in ~2s.
// getLocalEmbedder() memoises so that cost is paid once per process.

const LOCAL_MODEL_ID = process.env.LOCAL_EMBED_MODEL_ID ?? "Xenova/clip-vit-base-patch32";

type LocalEmbedder = (bytes: ArrayBuffer) => Promise<number[]>;
let embedderPromise: Promise<LocalEmbedder | null> | null = null;

function loadLocalEmbedder(): Promise<LocalEmbedder | null> {
  if (embedderPromise) return embedderPromise;

  embedderPromise = (async () => {
    try {
      const { AutoProcessor, CLIPVisionModelWithProjection, RawImage } = await import(
        "@huggingface/transformers"
      );
      const processor = await AutoProcessor.from_pretrained(LOCAL_MODEL_ID);
      const model = await CLIPVisionModelWithProjection.from_pretrained(LOCAL_MODEL_ID);

      return async (bytes: ArrayBuffer) => {
        const image = await RawImage.fromBlob(new Blob([bytes]));
        const { image_embeds } = await model(await processor(image));
        const vec = (image_embeds.tolist() as number[][])[0];
        // L2-normalise. pgvector's `<=>` is cosine distance and handles
        // magnitude itself, but unit vectors keep the stored values
        // comparable and the arithmetic well-conditioned.
        const norm = Math.hypot(...vec) || 1;
        return vec.map((v) => v / norm);
      };
    } catch (err) {
      console.error("[Embeddings] Local CLIP model failed to load:", err);
      return null;
    }
  })();

  return embedderPromise;
}

/**
 * Embed image bytes directly.
 *
 * Prefer this over getImageEmbedding() whenever the bytes are already in hand.
 * Uploading a file and then embedding its public URL looks equivalent but is
 * not: Supabase Storage serves public objects through a CDN, so an overwritten
 * object can still return the PREVIOUS image for some time. That silently
 * stores an embedding of the old picture while every log line reports success —
 * it produced a catalogue entry whose own reference photo matched it at 0.63
 * instead of 1.0, which reads exactly like a miscalibrated threshold rather
 * than stale data.
 *
 * Returns null on any failure — never throws.
 */
export async function getImageEmbeddingFromBytes(
  bytes: ArrayBuffer | Uint8Array
): Promise<number[] | null> {
  const embedder = await loadLocalEmbedder();
  if (!embedder) {
    console.warn("[Embeddings] Local model unavailable — cannot embed raw bytes");
    return null;
  }
  try {
    const buf =
      bytes instanceof Uint8Array
        ? (bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          ) as ArrayBuffer)
        : bytes;
    return await embedder(buf);
  } catch (err) {
    console.error("[Embeddings] getImageEmbeddingFromBytes failed:", err);
    return null;
  }
}

/**
 * Generate a CLIP image embedding for a (publicly reachable) image URL.
 * Returns null on any failure — never throws.
 *
 * If you have just written the object at that URL, use
 * getImageEmbeddingFromBytes() instead — see the CDN caveat above.
 *
 * Runs the model locally. Note what CLIP does and does not capture: it encodes
 * layout, colour and shape, NOT text. A pack misspelling the brand ("Nationel"
 * for "National") embeds essentially identically to the genuine article —
 * measured at cosine 1.0000 — so vector similarity alone will call that
 * counterfeit a match. The wordmark check in services/brandRouter.ts is what
 * catches it; the two signals are complementary, not redundant.
 */
export async function getImageEmbedding(imageUrl: string): Promise<number[] | null> {
  const embedder = await loadLocalEmbedder();
  if (embedder) {
    try {
      const res = await fetch(imageUrl);
      if (!res.ok) {
        console.warn(`[Embeddings] Could not fetch image (${res.status}): ${imageUrl}`);
        return null;
      }
      return await embedder(await res.arrayBuffer());
    } catch (err) {
      console.error("[Embeddings] Local embedding failed:", err);
      return null;
    }
  }

  // Remote fallback, kept for environments where the local model can't run.
  const apiKey = process.env.HUGGINGFACE_API_KEY;
  if (!apiKey) {
    console.warn("[Embeddings] No local model and HUGGINGFACE_API_KEY not set — skipping");
    return null;
  }

  const modelId = process.env.EMBED_MODEL_ID ?? DEFAULT_EMBED_MODEL;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

    const res = await fetch(
      `https://api-inference.huggingface.co/models/${modelId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ inputs: imageUrl }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[Embeddings] HuggingFace feature-extraction returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    const embedding = normalizeEmbedding(data);

    if (!embedding) {
      console.warn("[Embeddings] Unexpected feature-extraction response shape");
      return null;
    }

    return embedding;
  } catch (err) {
    console.error("[Embeddings] getImageEmbedding failed:", err);
    return null;
  }
}
