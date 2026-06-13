import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
process.env.GOOGLE_CLIENT_ID = "google-client";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
process.env.GOOGLE_REFRESH_TOKEN = "refresh-token";
process.env.COOKIE_SECRET = "12345678901234567890123456789012";
process.env.INBOX_PASSWORD = "1234567890123456";
process.env.WHATSAPP_APP_SECRET = "app-secret";
process.env.REQUIRE_WEBHOOK_SIGNATURE = "true";
process.env.ALLOW_UNSIGNED_WEBHOOKS = "false";
process.env.REQUIRE_DB_FOR_APPOINTMENTS = "true";

const { buildOperationalHealth, isOperationallyUnhealthy } = await import("../src/health.js");

test("health reporta app ok cuando lo critico esta configurado", () => {
  const health = buildOperationalHealth({ db: { ok: true, status: "ok" }, conversationCount: 2 });
  assert.equal(health.app, "ok");
  assert.equal(health.checks.webhookSignature, "required");
  assert.equal(isOperationallyUnhealthy(health), false);
});

test("health reporta problema si la base requerida no esta disponible", () => {
  const health = buildOperationalHealth({ db: { ok: false, status: "error" } });
  assert.ok(health.problems.includes("database_required_unavailable"));
  assert.equal(isOperationallyUnhealthy(health), true);
});
