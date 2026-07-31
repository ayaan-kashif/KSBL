import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Required for Prisma Client to work correctly inside Next.js App Router
  // serverless functions on Vercel. Prisma's native query engine binary must
  // not be bundled by Next.js — it needs to be loaded externally at runtime.
  // sharp is added for the same reason: lib/pixelCompare.ts loads it server-side
  // and its native libvips binding cannot be bundled — it must be required at
  // runtime from node_modules.
  // @huggingface/transformers loads onnxruntime-node, a native addon, and
  // resolves model weights from disk at runtime — neither survives bundling.
  serverExternalPackages: [
    "@prisma/client",
    "prisma",
    "sharp",
    "@huggingface/transformers",
    "onnxruntime-node",
  ],
};

export default nextConfig;
