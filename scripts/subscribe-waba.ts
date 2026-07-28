import dotenv from "dotenv";
import path from "path";

// Load environment variables from .env.local if available, else .env
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function main() {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  let wabaId = process.env.WHATSAPP_WABA_ID;

  console.log("=================================================");
  console.log(" Meta WhatsApp Cloud API - WABA Subscription Tool");
  console.log("=================================================\n");

  if (!accessToken) {
    console.error("❌ ERROR: WHATSAPP_ACCESS_TOKEN is missing in .env.local / env vars.");
    process.exit(1);
  }

  // Step 1: If WABA_ID is not provided, query Meta Graph API
  if (!wabaId) {
    console.log("🔍 Looking up WABA ID using access token...");
    try {
      const res = await fetch(
        `https://graph.facebook.com/v19.0/me/whatsapp_business_accounts`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      const data = (await res.json()) as {
        data?: Array<{ id: string; name: string }>;
        error?: { message: string };
      };

      if (res.ok && data.data && data.data.length > 0) {
        wabaId = data.data[0].id;
        console.log(`✅ Found WABA ID automatically: ${wabaId}\n`);
      } else {
        console.log("\n⚠️ WABA ID missing in environment variables.");
        console.log("💡 How to find your WABA ID:");
        console.log("   1. Open Meta Developer Dashboard: https://developers.facebook.com");
        console.log("   2. Go to WhatsApp -> API Setup");
        console.log("   3. Under 'WhatsApp Business Account ID', copy the ID number.");
        console.log("   4. Add it to .env.local: WHATSAPP_WABA_ID=\"your_waba_id_here\"\n");
        process.exit(1);
      }
    } catch (err) {
      console.warn("⚠️ WABA lookup error:", err);
      process.exit(1);
    }
  }

  // Step 2: Check existing subscriptions
  console.log(`📋 Checking current subscribed apps for WABA (${wabaId})...`);
  try {
    const getRes = await fetch(
      `https://graph.facebook.com/v19.0/${wabaId}/subscribed_apps`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const getData = await getRes.json();
    console.log("Current subscriptions response:", JSON.stringify(getData, null, 2));

    // Step 3: Subscribe App to WABA
    console.log(`\n🚀 Subscribing App to WABA (${wabaId})...`);
    const postRes = await fetch(
      `https://graph.facebook.com/v19.0/${wabaId}/subscribed_apps`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    const postData = await postRes.json();

    if (postRes.ok && postData.success) {
      console.log("\n=================================================");
      console.log("🎉 SUCCESS! Your Meta App is now subscribed to WABA.");
      console.log("=================================================");
      console.log("Next Steps:");
      console.log("1. Ensure Meta Developer Dashboard -> WhatsApp -> Configuration:");
      console.log("   - Callback URL: https://<YOUR-DOMAIN>/api/whatsapp-webhook");
      console.log("   - Verify Token: Matches WHATSAPP_VERIFY_TOKEN in environment.");
      console.log("2. Under 'Webhook fields', click 'Manage' and check 'messages'.");
    } else {
      console.error("\n❌ Failed to subscribe WABA:", JSON.stringify(postData, null, 2));
    }
  } catch (err) {
    console.error("❌ Exception occurred during subscription request:", err);
    process.exit(1);
  }
  process.exit(0);
}

main();
