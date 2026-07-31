/**
 * lib/pixelCompare.ts
 *
 * Strict image comparison of a customer scan against a brand's own catalogue
 * reference photo. Used only for brands where we hold clean, first-party
 * product photography (currently National Foods — see PIXEL_COMPARE_BRANDS in
 * lib/verifyProduct.ts). Every other brand keeps the generic CV anomaly score.
 *
 * Deliberately NOT literal pixel subtraction. Two photographs of the same
 * genuine bottle taken seconds apart differ in almost every pixel once crop,
 * rotation, white balance and sensor noise are accounted for, so a difference
 * metric would flag real products as fake. Instead:
 *
 *   SSIM  — structural similarity. Catches logo repositioning, font
 *           substitution and layout changes while tolerating lighting and
 *           noise. This is the signal that actually detects a counterfeit.
 *   Color — mean per-channel difference. Catches a pure shade swap (right
 *           layout, wrong red) which SSIM under-weights because structure is
 *           preserved.
 *
 * Never throws. On any failure — no reference URL, fetch error, decode error —
 * returns a result with `error` set so the caller can fall back to the
 * standard verdict path, matching the convention in lib/cv.ts,
 * lib/embeddings.ts and lib/vectorSearch.ts.
 */

import sharp from "sharp";
import { ssim } from "ssim.js";

// ─── Tunables ─────────────────────────────────────────────────────────────────

/**
 * Combined score at or above which a scan is considered genuine.
 *
 * ⚠ UNCALIBRATED — 0.9 is a placeholder and is almost certainly wrong.
 *
 * Measured on synthetic fixtures (a flat label re-photographed with a 2°
 * rotation, a ~7% crop and a 9% brightness lift — i.e. a MILD handheld photo):
 *
 *   genuine re-photograph ............ 0.68
 *   counterfeit, logo moved/resized .. 0.66
 *   counterfeit, wrong red shade ..... 0.65
 *   unrelated product ................ 0.51
 *
 * Two things follow. First, 0.9 marks every one of those SUSPICIOUS, genuine
 * included. Second, and more important: the gap between a genuine scan and a
 * targeted counterfeit is ~0.02, while the photography alone moves the score
 * by ~0.32 — the nuisance signal is an order of magnitude larger than the one
 * we care about, so NO fixed threshold separates the two populations on
 * uncropped phone photos.
 *
 * Before trusting this for a verdict, either (a) calibrate against real
 * catalogue photos vs. real customer scans and expect to land far below 0.9,
 * or (b) crop the scan to the pack first — most of the lost score is
 * background and framing, not the label. Until then treat the output as a
 * weak secondary signal; the CLIP embedding search in lib/vectorSearch.ts is
 * the alignment-invariant tool for this job.
 */
export const GENUINE_THRESHOLD = 0.9;

/** Both images are normalised to this square before any comparison. */
export const COMPARE_SIZE = 160;

/**
 * Search radius, in COMPARE_SIZE pixels, for the best alignment between scan
 * and reference. Raw SSIM is computed on a fixed grid, so it measures
 * displacement as if it were structural difference: a 2° rotation and a small
 * crop — present in essentially every handheld photo — drop a genuine product
 * below the score of an obvious counterfeit that happens to be squarely
 * framed. Taking the best score over a small translation sweep removes that
 * artefact so the number reflects the label, not the photographer.
 */
export const ALIGN_RADIUS = 12;
export const ALIGN_STEP = 6;

/**
 * A rotation sweep (±3° in 1.5° steps) was measured on top of the translation
 * search and rejected: it lifted a genuine re-photograph from 0.68 to 0.75 but
 * lifted counterfeits just as far, widening the genuine-vs-counterfeit gap by
 * only 0.012 while making each comparison ~5x slower (3.5s). Don't re-add it
 * without data showing it separates the two populations.
 */

/**
 * Gaussian blur applied before SSIM. Absorbs residual sub-pixel and rotational
 * misalignment that translation alone cannot cancel, plus JPEG ringing.
 */
export const PRE_BLUR_SIGMA = 1.2;

/** Grid resolution for the colour statistic (COLOR_GRID x COLOR_GRID cells). */
export const COLOR_GRID = 4;

/** Structure dominates: a counterfeit usually gets the palette roughly right. */
export const SSIM_WEIGHT = 0.7;
export const COLOR_WEIGHT = 0.3;

/** Max per-channel 8-bit distance, used to normalise the colour delta to 0–1. */
const MAX_CHANNEL_VALUE = 255;

const FETCH_TIMEOUT_MS = 8000;

/**
 * downsample is disabled because both inputs are already normalised to
 * COMPARE_SIZE; letting ssim.js shrink them again would discard the fine
 * typographic detail that distinguishes a counterfeit label.
 */
const SSIM_OPTIONS = { downsample: false as const };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PixelCompareResult {
  /** score < GENUINE_THRESHOLD. Always false when `error` is set. */
  suspicious: boolean;
  /** Combined 0.0–1.0: ssimScore * SSIM_WEIGHT + colorScore * COLOR_WEIGHT. */
  score: number;
  ssimScore: number;
  colorScore: number;
  /** Set when the comparison could not be performed. Caller should fall back. */
  error?: string;
}

function failure(error: string): PixelCompareResult {
  // suspicious:false on failure — an unavailable comparison must never be
  // read as evidence against the product.
  return { suspicious: false, score: 0, ssimScore: 0, colorScore: 0, error };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchImageBuffer(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timeoutId);
  }
}

interface Rgba {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Normalise for structural comparison: auto-orient from EXIF (phone photos are
 * routinely stored rotated), centre-crop toward square, resize, stretch
 * contrast so exposure differences don't register as structure, then blur.
 *
 * Both images are rendered on the SAME oversized canvas (COMPARE_SIZE plus the
 * alignment margin on each side). Rendering only one of them larger would
 * change its scale relative to the other, and no amount of sliding recovers
 * from a scale mismatch.
 */
async function toStructuralRgba(input: Buffer): Promise<Rgba> {
  const side = COMPARE_SIZE + ALIGN_RADIUS * 2;
  const { data, info } = await sharp(input)
    .rotate() // no argument = apply EXIF orientation
    .resize(side, side, { fit: "cover", position: "centre" })
    .normalise()
    .blur(PRE_BLUR_SIGMA)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  };
}

/** Copy a COMPARE_SIZE window out of a padded RGBA buffer. */
function windowAt(src: Rgba, left: number, top: number): Rgba {
  const out = new Uint8ClampedArray(COMPARE_SIZE * COMPARE_SIZE * 4);
  for (let y = 0; y < COMPARE_SIZE; y++) {
    const srcStart = ((top + y) * src.width + left) * 4;
    out.set(src.data.subarray(srcStart, srcStart + COMPARE_SIZE * 4), y * COMPARE_SIZE * 4);
  }
  return { data: out, width: COMPARE_SIZE, height: COMPARE_SIZE };
}

/**
 * Best SSIM over a small translation sweep. The reference is held at the
 * centre of its canvas and the scan window slides around it, so offset
 * (ALIGN_RADIUS, ALIGN_RADIUS) is the zero-shift case. See ALIGN_RADIUS for
 * why the sweep exists at all.
 */
function alignedSsim(scan: Rgba, reference: Rgba): number {
  const refWindow = windowAt(reference, ALIGN_RADIUS, ALIGN_RADIUS);
  let best = -Infinity;
  for (let dy = 0; dy <= ALIGN_RADIUS * 2; dy += ALIGN_STEP) {
    for (let dx = 0; dx <= ALIGN_RADIUS * 2; dx += ALIGN_STEP) {
      const { mssim } = ssim(windowAt(scan, dx, dy), refWindow, SSIM_OPTIONS);
      if (Number.isFinite(mssim) && mssim > best) best = mssim;
    }
  }
  return best;
}

/**
 * Mean RGB per cell of a COLOR_GRID x COLOR_GRID grid. A single whole-image
 * mean is far too coarse — averaging a recoloured label against its white
 * background washes an obvious shade swap down to a rounding error. Comparing
 * cell by cell keeps that signal while staying insensitive to small shifts.
 *
 * Contrast normalisation is deliberately NOT applied here: it would erase the
 * very shade differences this metric exists to find.
 */
async function colorGrid(input: Buffer): Promise<Float64Array> {
  const { data, info } = await sharp(input)
    .rotate()
    .resize(COLOR_GRID, COLOR_GRID, { fit: "cover", position: "centre" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cells = new Float64Array(COLOR_GRID * COLOR_GRID * 3);
  for (let i = 0; i < cells.length; i++) cells[i] = data[i];
  void info;
  return cells;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compare a scan photo against a catalogue reference photo.
 * Never throws — inspect `.error` before trusting `.suspicious`.
 */
export async function comparePixelWise(
  scanImageUrl: string,
  referenceImageUrl: string | null
): Promise<PixelCompareResult> {
  if (!referenceImageUrl) {
    return failure("No reference image on file for this product");
  }

  try {
    const [scanBuf, refBuf] = await Promise.all([
      fetchImageBuffer(scanImageUrl),
      fetchImageBuffer(referenceImageUrl),
    ]);

    const [scanRgba, refRgba, scanCells, refCells] = await Promise.all([
      toStructuralRgba(scanBuf),
      toStructuralRgba(refBuf),
      colorGrid(scanBuf),
      colorGrid(refBuf),
    ]);

    const mssim = alignedSsim(scanRgba, refRgba);

    // SSIM is defined on [-1, 1]; negative means structurally inverted, which
    // for our purposes is simply "as dissimilar as it gets".
    const ssimScore = Number.isFinite(mssim) ? Math.max(0, Math.min(1, mssim)) : NaN;
    if (Number.isNaN(ssimScore)) {
      return failure("SSIM returned a non-finite value");
    }

    let cellDelta = 0;
    for (let i = 0; i < scanCells.length; i++) {
      cellDelta += Math.abs(scanCells[i] - refCells[i]);
    }
    cellDelta /= scanCells.length;
    const colorScore = Math.max(0, Math.min(1, 1 - cellDelta / MAX_CHANNEL_VALUE));

    const score = ssimScore * SSIM_WEIGHT + colorScore * COLOR_WEIGHT;

    return {
      suspicious: score < GENUINE_THRESHOLD,
      score,
      ssimScore,
      colorScore,
    };
  } catch (err) {
    console.error("[PixelCompare] Comparison failed:", err);
    return failure(err instanceof Error ? err.message : String(err));
  }
}
