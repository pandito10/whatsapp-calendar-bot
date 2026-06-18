import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const baseEnv = {
  ...process.env,
  WHATSAPP_VERIFY_TOKEN: "verify-token-test",
  WHATSAPP_PHONE_NUMBER_ID: "123456789",
  WHATSAPP_BUSINESS_ACCOUNT_ID: "",
  WHATSAPP_DISPLAY_PHONE_NUMBER: "",
  WHATSAPP_ACCESS_TOKEN: "whatsapp-token-test",
  DOCTOR_WHATSAPP_NUMBER: "5210000000000",
  AI_PROVIDER: "local",
  ENABLE_REMINDER_WORKER: "false",
  INBOX_PASSWORD: "1234567890123456",
  COOKIE_SECRET: "12345678901234567890123456789012",
  WEBHOOK_PATH_SECRET: "123456789012345678901234567890"
};

test("inbox esta protegido y login carga sin conversaciones", async () => {
  const app = await startServer(32131, { ...baseEnv, NODE_ENV: "test" });
  try {
    const root = await fetch("http://127.0.0.1:32131/", { redirect: "manual" });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get("location"), "/inbox");

    const privacy = await fetch("http://127.0.0.1:32131/privacy");
    const privacyHtml = await privacy.text();
    assert.equal(privacy.status, 200);
    assert.match(privacyHtml, /Politica de privacidad/);
    assert.ok(privacyHtml.includes("Meta/WhatsApp"));

    const inbox = await fetch("http://127.0.0.1:32131/inbox", { redirect: "manual" });
    assert.equal(inbox.status, 303);
    assert.equal(inbox.headers.get("location"), "/inbox/login");

    const login = await fetch("http://127.0.0.1:32131/inbox/login");
    const html = await login.text();
    assert.equal(login.status, 200);
    assert.match(html, /Inbox del bot/);
    assert.match(html, /Clave/);

    const csrf = html.match(/name="csrf" type="hidden" value="([^"]+)"/)?.[1];
    const loginCookie = login.headers.get("set-cookie")?.split(";")[0];
    const loginResponse = await fetch("http://127.0.0.1:32131/inbox/login", {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: loginCookie
      },
      body: new URLSearchParams({
        csrf,
        password: baseEnv.INBOX_PASSWORD
      })
    });
    assert.equal(loginResponse.status, 303);
    const inboxCookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
    const inboxHtml = await (await fetch("http://127.0.0.1:32131/inbox", { headers: { Cookie: inboxCookie } })).text();
    assert.match(inboxHtml, /Sin conversacion seleccionada/);
    assert.match(inboxHtml, /Sin cita/);
    assert.match(inboxHtml, /Primera vez/);
    assert.match(inboxHtml, /Preguntas no reconocidas/);
    assert.match(inboxHtml, /FAQs aprobadas/);
    assert.match(inboxHtml, /Guardar FAQ/);
    assert.match(inboxHtml, /Humano/);
    assert.match(inboxHtml, /Urgentes/);
    assert.match(inboxHtml, /Resultados/);
    assert.match(inboxHtml, /Atoradas/);
    assert.match(inboxHtml, /Esperando datos/);
    assert.match(inboxHtml, /Diagnostico rapido/);
    assert.match(inboxHtml, /Firma Meta/);
    assert.match(inboxHtml, /Locks/);
    assert.match(inboxHtml, /class="no-selection"/);
    assert.match(inboxHtml, /data-refresh-status/);
    assert.doesNotMatch(inboxHtml, /http-equiv="refresh"/);

    const inboxScript = await fetch("http://127.0.0.1:32131/inbox.js");
    assert.equal(inboxScript.status, 200);
    const inboxScriptText = await inboxScript.text();
    assert.match(inboxScriptText, /scrollMessagesToBottom/);
    assert.match(inboxScriptText, /data-template/);
    assert.match(inboxScriptText, /data-copy-phone/);
    assert.match(inboxScriptText, /bindSmartRefresh/);
    assert.match(inboxScriptText, /Pausado mientras escribes/);
    assert.match(inboxScriptText, /Pausado mientras lees/);

    const debug = await fetch("http://127.0.0.1:32131/debug/config", { headers: { Cookie: inboxCookie } });
    assert.equal(debug.status, 200);
    const debugJson = await debug.json();
    assert.equal(debugJson.calendarId, "ginecologiaintegralgto@gmail.com");
    assert.deepEqual(debugJson.busyCalendarIds, ["ginecologiaintegralgto@gmail.com"]);
    assert.deepEqual(debugJson.activeAppointmentLocks, []);
    assert.equal(debugJson.databaseEnabled, false);
    assert.ok(Array.isArray(debugJson.activeAppointmentLocks));
    assert.equal(debugJson.whatsappTokenSource, "WHATSAPP_ACCESS_TOKEN");
    assert.deepEqual(debugJson.whatsappTokenVarsConfigured, {
      WHATSAPP_TOKEN: false,
      WHATSAPP_ACCESS_TOKEN: true
    });
    assert.equal(debugJson.whatsappTokenConflict, false);
    assert.equal(debugJson.whatsappPhoneNumberId, "1234...6789");
    assert.equal(debugJson.webhookDiagnostics.pathSecretEnabled, true);
    assert.equal(JSON.stringify(debugJson).includes("whatsapp-token-test"), false);
    assert.equal(JSON.stringify(debugJson).includes(baseEnv.INBOX_PASSWORD), false);
  } finally {
    await app.stop();
  }
});

test("webhook en produccion rechaza POST sin firma y acepta status firmado", async () => {
  const appSecret = "app-secret-test";
  const app = await startServer(32132, {
    ...baseEnv,
    NODE_ENV: "production",
    WHATSAPP_APP_SECRET: appSecret,
    REQUIRE_WEBHOOK_SIGNATURE: "true",
    ALLOW_UNSIGNED_WEBHOOKS: "false",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb-service-role-test",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_REFRESH_TOKEN: "google-refresh",
    GOOGLE_CALENDAR_ID: "ginecologiaintegralgto@gmail.com"
  });

  try {
    const payload = buildStatusPayload();
    const unsigned = await fetch("http://127.0.0.1:32132/webhook/123456789012345678901234567890", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    assert.equal(unsigned.status, 403);

    const invalid = await fetch("http://127.0.0.1:32132/webhook/123456789012345678901234567890", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${"0".repeat(64)}`
      },
      body: payload
    });
    assert.equal(invalid.status, 403);

    const signed = await fetch("http://127.0.0.1:32132/webhook/123456789012345678901234567890", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(appSecret, payload)
      },
      body: payload
    });
    assert.equal(signed.status, 200);
    assert.equal(await signed.text(), "ok");
  } finally {
    await app.stop();
  }
});

test("webhook temporal sin firma rechaza cuando UNSIGNED_WEBHOOK_EXPIRES_AT vencio", async () => {
  const app = await startServer(32135, {
    ...baseEnv,
    NODE_ENV: "production",
    WHATSAPP_APP_SECRET: "",
    REQUIRE_WEBHOOK_SIGNATURE: "true",
    ALLOW_UNSIGNED_WEBHOOKS: "true",
    UNSIGNED_WEBHOOK_EXPIRES_AT: "2000-01-01T00:00:00.000Z",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb-service-role-test",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_REFRESH_TOKEN: "google-refresh",
    GOOGLE_CALENDAR_ID: "ginecologiaintegralgto@gmail.com"
  });

  try {
    const response = await fetch("http://127.0.0.1:32135/webhook/123456789012345678901234567890", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: buildStatusPayload()
    });
    assert.equal(response.status, 403);

    const health = await (await fetch("http://127.0.0.1:32135/health/ready")).json();
    assert.equal(health.webhook.unsignedWebhookExpired, true);
    assert.equal(health.webhook.signatureMode, "unsigned-expired");
  } finally {
    await app.stop();
  }
});

test("saludo del numero nuevo entra por webhook valido y dispara menu inicial", async () => {
  const appSecret = "app-secret-test";
  const newPhoneNumberId = "9999999999999999";
  const app = await startServer(32136, {
    ...baseEnv,
    NODE_ENV: "test",
    WHATSAPP_APP_SECRET: appSecret,
    REQUIRE_WEBHOOK_SIGNATURE: "true",
    ALLOW_UNSIGNED_WEBHOOKS: "false",
    WHATSAPP_SEND_DRY_RUN: "true",
    WHATSAPP_PHONE_NUMBER_ID: newPhoneNumberId,
    WHATSAPP_DISPLAY_PHONE_NUMBER: "5210000000000"
  });

  try {
    const payload = buildTextPayload({
      phoneNumberId: newPhoneNumberId,
      displayPhoneNumber: "+52 1 000 000 0000",
      from: "5214778811965",
      id: "wamid.saludo-numero-nuevo",
      text: "Hola"
    });
    const response = await fetch("http://127.0.0.1:32136/webhook/123456789012345678901234567890", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(appSecret, payload)
      },
      body: payload
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    await waitForOutput(app, /Incoming WhatsApp from 52147\*\*\*\*965/);
    await waitForOutput(app, /WhatsApp dry-run send to 52147\*\*\*\*965/);

    const health = await (await fetch("http://127.0.0.1:32136/health/ready")).json();
    assert.equal(health.webhook.lastMessageCount, 1);
    assert.equal(health.webhook.lastPhoneNumberId, "9999...9999");
    assert.equal(health.whatsapp.tokenSource, "WHATSAPP_ACCESS_TOKEN");
  } finally {
    await app.stop();
  }
});

test("webhook acepta WABA distinto si el phone_number_id oficial coincide", async () => {
  const appSecret = "app-secret-test";
  const app = await startServer(32133, {
    ...baseEnv,
    NODE_ENV: "production",
    WHATSAPP_APP_SECRET: appSecret,
    WHATSAPP_BUSINESS_ACCOUNT_ID: "waba-configurado-distinto",
    REQUIRE_WEBHOOK_SIGNATURE: "true",
    ALLOW_UNSIGNED_WEBHOOKS: "false",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb-service-role-test",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_REFRESH_TOKEN: "google-refresh",
    GOOGLE_CALENDAR_ID: "ginecologiaintegralgto@gmail.com"
  });

  try {
    const payload = buildStatusPayload();
    const response = await fetch("http://127.0.0.1:32133/webhook/123456789012345678901234567890", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(appSecret, payload)
      },
      body: payload
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    await app.stop();
  }
});

test("webhook acepta display_phone_number distinto si el phone_number_id oficial coincide", async () => {
  const appSecret = "app-secret-test";
  const app = await startServer(32134, {
    ...baseEnv,
    NODE_ENV: "production",
    WHATSAPP_APP_SECRET: appSecret,
    WHATSAPP_DISPLAY_PHONE_NUMBER: "5219999999999",
    REQUIRE_WEBHOOK_SIGNATURE: "true",
    ALLOW_UNSIGNED_WEBHOOKS: "false",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb-service-role-test",
    GOOGLE_CLIENT_ID: "google-client",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_REFRESH_TOKEN: "google-refresh",
    GOOGLE_CALENDAR_ID: "ginecologiaintegralgto@gmail.com"
  });

  try {
    const payload = buildStatusPayload();
    const response = await fetch("http://127.0.0.1:32134/webhook/123456789012345678901234567890", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signPayload(appSecret, payload)
      },
      body: payload
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    await app.stop();
  }
});

function buildStatusPayload() {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-test",
      changes: [{
        field: "messages",
        value: {
          metadata: {
            phone_number_id: "123456789",
            display_phone_number: "+1 555 000 0000"
          },
          statuses: [{ id: "wamid.status", status: "sent" }]
        }
      }]
    }]
  });
}

function buildTextPayload({ phoneNumberId = "123456789", displayPhoneNumber = "+1 555 000 0000", from = "5214778811965", id = "wamid.test", text = "Hola" } = {}) {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "waba-test",
      changes: [{
        field: "messages",
        value: {
          metadata: {
            phone_number_id: phoneNumberId,
            display_phone_number: displayPhoneNumber
          },
          contacts: [{ wa_id: from, profile: { name: "Paciente Test" } }],
          messages: [{
            from,
            id,
            timestamp: "1900000000",
            type: "text",
            text: { body: text }
          }]
        }
      }]
    }]
  });
}

function signPayload(appSecret, payload) {
  const signature = crypto.createHmac("sha256", appSecret).update(Buffer.from(payload)).digest("hex");
  return `sha256=${signature}`;
}

async function startServer(port, env) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: repoRoot,
    env: { ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  try {
    await waitForLive(port, child, () => output);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  return {
    stop: () => stopServer(child),
    output: () => output
  };
}

async function waitForOutput(app, regex) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (regex.test(app.output())) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`expected output ${regex}, got:\n${app.output()}`);
}

async function waitForLive(port, child, getOutput) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early: ${getOutput()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (response.status === 200) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${getOutput()}`);
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1500).unref();
  });
}
