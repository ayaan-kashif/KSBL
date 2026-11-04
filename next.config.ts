import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig: NextConfig = {
  // Required for Prisma Client to work correctly inside Next.js App Router
  // serverless functions on Vercel. Prisma's native query engine binary must
  // not be bundled by Next.js — it needs to be loaded externally at runtime.
  // sharp is added for the same reason: lib/pixelCompare.ts loads it server-side
  // and its native libvips binding cannot be bundled — it must be required at
  // runtime from node_modules.
  // @huggingface/transformers loads onnxruntime-node, a native addon, and
  // resolves model weights from disk at runtime — neither survives bundling.
  // zxing-wasm (services/barcodeDecoder.ts) is ESM + a .wasm binary that is
  // read from node_modules at runtime rather than fetched from its default CDN.
  serverExternalPackages: [
    "@prisma/client",
    "prisma",
    "sharp",
    "@huggingface/transformers",
    "onnxruntime-node",
    "zxing-wasm",
  ],
};

// The decoder loads the .wasm with readFileSync, which file tracing can't
// see — without this the binary is missing from the Vercel function bundle.
// Build/start only: tracing does nothing in `next dev`, and with this option
// set, Turbopack's dev server intermittently 404'd API routes (HTML instead of
// JSON — "Unexpected token '<'" on login).
const outputFileTracingIncludes: NextConfig["outputFileTracingIncludes"] = {
  "/api/*": ["./node_modules/zxing-wasm/dist/reader/zxing_reader.wasm"],
};

export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) return nextConfig;
  return { ...nextConfig, outputFileTracingIncludes };
}
