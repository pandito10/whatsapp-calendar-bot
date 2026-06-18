import crypto from "node:crypto";

const baseUrl = requireValue("BASE_URL", process.env.BASE_URL ?? process.env.PUBLIC_BASE_URL);
const webhookSecret = process.env.WEBHOOK_PATH_SECRET;
const appSecret = process.env.WHATSAPP_APP_SECRET;
const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "WABA_ID_DE_PRUEBA";
const displayPhone = process.env.WHATSAPP_DISPLAY_PHONE_NUMBER;

const checks = [];

await check("health live responde 200", async () => {
  const response = await fetchUrl("/health/live");
  assertStatus(response, 200);
});

await check("readiness responde ready", async () => {
  const response = await fetchUrl("/health/ready");
  assertStatus(response, 200);
  const body = await response.json();
  if (body?.readiness?.status !== "ready") {
    throw new Error(`readiness=${body?.readiness?.status ?? "unknown"} problems=${JSON.stringify(body?.problems ?? [])}`);
  }
});

await check("inbox redirige a login", async () => {
  const response = await fetchUrl("/inbox", { redirect: "manual" });
  assertStatus(response, 303);
  const location = response.headers.get("location");
  if (location !== "/inbox/login") throw new Error(`location inesperado: ${location}`);
});

if (webhookSecret && appSecret && phoneNumberId && displayPhone) {
  await check("webhook rechaza status sin firma", async () => {
    const payload = buildStatusPayload();
    const response = await fetchUrl(`/webhook/${encodeURIComponent(webhookSecret)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    assertStatus(response, 403);
  });

  await check("webhook acepta status firmado", async () => {
    const payload = buildStatusPayload();
    const response = await fetchUrl(`/webhook/${encodeURIComponent(webhookSecret)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(payload)
      },
      body: payload
    });
    assertStatus(response, 200);
    const text = await response.text();
    if (text !== "ok") throw new Error(`respuesta inesperada: ${text}`);
  });
} else {
  checks.push({
    name: "webhook firmado",
    ok: false,
    skipped: true,
    message: "faltan WEBHOOK_PATH_SECRET, WHATSAPP_APP_SECRET, WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_DISPLAY_PHONE_NUMBER"
  });
}

printSummary();

function buildStatusPayload() {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: wabaId,
      changes: [{
        field: "messages",
        value: {
          metadata: {
            display_phone_number: displayPhone,
            phone_number_id: phoneNumberId
          },
          statuses: [{
            id: `wamid.SMOKE_STATUS_${Date.now()}`,
            status: "sent",
            timestamp: String(Math.floor(Date.now() / 1000))
          }]
        }
      }]
    }]
  });
}

function signPayload(payload) {
  const signature = crypto.createHmac("sha256", appSecret).update(Buffer.from(payload)).digest("hex");
  return `sha256=${signature}`;
}

async function fetchUrl(path, options = {}) {
  const url = new URL(path, normalizedBaseUrl()).toString();
  return fetch(url, options);
}

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, message: error?.message ?? String(error) });
  }
}

function assertStatus(response, expected) {
  if (response.status !== expected) {
    throw new Error(`HTTP ${response.status}, esperado ${expected}`);
  }
}

function normalizedBaseUrl() {
  return String(baseUrl).replace(/\/$/, "") + "/";
}

function requireValue(name, value) {
  if (!value) {
    console.error(`Falta ${name}. Ejemplo: ${name}=... npm run smoke:pilot`);
    process.exit(2);
  }
  return value;
}

function printSummary() {
  for (const result of checks) {
    const mark = result.ok ? "OK" : result.skipped ? "SKIP" : "FAIL";
    console.log(`${mark} ${result.name}${result.message ? ` - ${result.message}` : ""}`);
  }

  const failed = checks.filter((result) => !result.ok && !result.skipped);
  const skipped = checks.filter((result) => result.skipped);

  if (failed.length > 0) {
    console.error(`Smoke fallido: ${failed.length} check(s) fallaron.`);
    process.exit(1);
  }

  if (skipped.length > 0) {
    console.warn(`Smoke parcial: ${skipped.length} check(s) omitidos por falta de variables.`);
    process.exit(0);
  }

  console.log("Smoke OK: el deploy responde y el webhook firmado esta operativo.");
}
