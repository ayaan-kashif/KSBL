import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
dotenv.config({ path: path.resolve(process.cwd(), ".env") });

async function main() {
  const targetUrl = process.argv[2] || "http://localhost:3000/api/whatsapp-webhook";
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || "shelfwatch_verify_2026";

  console.log("=================================================");
  console.log(" Webhook Tester for ShelfWatch WhatsApp API");
  console.log(" Target URL:", targetUrl);
  console.log("=================================================\n");

  // 1. Test GET Verification Challenge
  console.log("1️⃣ Testing GET Verification Challenge...");
  const challengeStr = "test_challenge_12345";
  const challengeUrl = `${targetUrl}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
    verifyToken
  )}&hub.challenge=${challengeStr}`;

  try {
    const res = await fetch(challengeUrl);
    const bodyText = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(`Response Body: "${bodyText}"`);

    if (res.status === 200 && bodyText === challengeStr) {
      console.log("✅ GET Verification test PASSED!\n");
    } else {
      console.error(
        `❌ GET Verification failed. Expected 200 with "${challengeStr}". Got ${res.status} "${bodyText}"\n`
      );
    }
  } catch (err) {
    console.error("❌ Failed to reach target URL for GET challenge:", err);
  }

  // 2. Test POST Incoming Message Payload
  console.log("2️⃣ Testing POST Mock WhatsApp Text Message...");
  const mockPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID_TEST",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "15555555555",
                phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID || "1234567890",
              },
              messages: [
                {
                  from: "923001234567",
                  id: "wamid.HBgLMTIzNDU2Nzg5MA==",
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  text: { body: "Hi ShelfWatch verification test" },
                  type: "text",
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };

  try {
    const postRes = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mockPayload),
    });
    const postJson = await postRes.json();
    console.log(`Status: ${postRes.status}`);
    console.log("Response:", JSON.stringify(postJson, null, 2));

    if (postRes.ok) {
      console.log("✅ POST Mock Message test PASSED!\n");
    } else {
      console.error("❌ POST test returned error status.\n");
    }
  } catch (err) {
    console.error("❌ Failed to send POST request to target URL:", err);
  }
}

main();
