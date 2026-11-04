/**
 * scripts/create-admin.ts
 *
 * Creates (or updates the password of) a row in the Admin table, so a new
 * person can sign in at /settings.
 *
 * Why this exists: nothing else creates admins. prisma/seed.ts seeds brands,
 * products and scans but never an Admin row, and there is no sign-up route for
 * the portal — by design, since anyone with a row gets full brand-protection
 * access. That left no supported way to add the second admin, which is why a
 * fresh email hitting /settings only ever gets "Invalid email or password".
 *
 * The password is read from a hidden prompt, never from argv — an argument
 * would land in shell history and in the process list.
 *
 * Run:
 *   npm run admin:create -- someone@example.com
 */

import readline from "node:readline";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
// Named import, matching scripts/seed-demo-reference-photos.ts: @next/env is
// CommonJS with no default export, so under ts-node's CJS interop the default
// binding is undefined and destructuring it throws.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

// Supabase's pooler presents a self-signed chain Node does not trust. The Pool's
// own `ssl` option below is NOT sufficient on its own here — Prisma 7's pg
// adapter still rejects the handshake without this — which is why every other
// script in this folder sets it too.
//
// Acceptable here and NOT in server code: this is a short-lived local CLI whose
// only outbound connection is to the developer's own database. The same line in
// a long-running route handler would relax TLS for every third-party API call
// the server makes for as long as the process lives.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const pool = new Pool({
  connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/** Prompts without echoing, so the password never appears on screen. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const input = process.stdin;
    const output = process.stdout;
    const rl = readline.createInterface({ input, output, terminal: true });

    output.write(question);

    // readline still emits keypresses to the output; muting the write callback
    // is what actually suppresses the echo.
    const originalWrite = output.write.bind(output);
    let muted = true;
    (output as NodeJS.WriteStream & { write: typeof originalWrite }).write = ((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => {
      if (muted && typeof chunk === "string" && !chunk.includes("\n")) return true;
      return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof originalWrite;

    rl.question("", (answer) => {
      muted = false;
      (output as NodeJS.WriteStream & { write: typeof originalWrite }).write = originalWrite;
      output.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("Usage: npm run admin:create -- someone@example.com");
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) {
    console.log(`⚠️  ${email} already exists — this will RESET its password.`);
  }

  const password = await promptHidden("New password (min 8 chars): ");
  if (password.length < 8) {
    console.error("❌ Password must be at least 8 characters.");
    process.exitCode = 1;
    return;
  }

  const confirm = await promptHidden("Confirm password: ");
  if (password !== confirm) {
    console.error("❌ Passwords do not match.");
    process.exitCode = 1;
    return;
  }

  // Cost 10 matches what the login route's bcrypt.compare expects to verify
  // against; the factor is embedded in the hash, so this only sets the cost for
  // newly written rows.
  const password_hash = await bcrypt.hash(password, 10);

  await prisma.admin.upsert({
    where: { email },
    update: { password_hash },
    create: { email, password_hash },
  });

  console.log(`✅ Admin ready: ${email}`);
  console.log("   Sign in at /settings");
}

main()
  .catch((err) => {
    console.error("❌ Failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
