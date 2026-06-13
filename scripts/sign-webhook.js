import crypto from "node:crypto";
import fs from "node:fs";

const [secret, payloadArg] = process.argv.slice(2);

if (!secret || !payloadArg) {
  console.error("Usage: node scripts/sign-webhook.js WHATSAPP_APP_SECRET payload.json");
  process.exit(1);
}

const payload = fs.existsSync(payloadArg) ? fs.readFileSync(payloadArg) : Buffer.from(payloadArg);
const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
console.log(`sha256=${signature}`);
