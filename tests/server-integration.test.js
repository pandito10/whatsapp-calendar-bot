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
    assert.match(inboxHtml, /Guardar FAQ/);
    assert.match(inboxHtml, /class="no-selection"/);

    const inboxScript = await fetch("http://127.0.0.1:32131/inbox.js");
    assert.equal(inboxScript.status, 200);
    const inboxScriptText = await inboxScript.text();
    assert.match(inboxScriptText, /scrollMessagesToBottom/);
    assert.match(inboxScriptText, /data-template/);
    assert.match(inboxScriptText, /data-copy-phone/);
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
    GOOGLE_CALENDAR_ID: "primary"
  });

  try {
    const payload = buildStatusPayload();
    const unsigned = await fetch("http://127.0.0.1:32132/webhook/123456789012345678901234567890", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    assert.equal(unsigned.status, 403);

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
    stop: () => stopServer(child)
  };
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
