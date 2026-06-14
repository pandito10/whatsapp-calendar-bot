import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
process.env.WHATSAPP_APP_SECRET = "app-secret";
process.env.REQUIRE_WEBHOOK_SIGNATURE = "true";
process.env.ALLOW_UNSIGNED_WEBHOOKS = "false";
process.env.WEBHOOK_PATH_SECRET = "123456789012345678901234567890";
process.env.COOKIE_SECRET = "12345678901234567890123456789012";
process.env.INBOX_PASSWORD = "1234567890123456";
process.env.REQUIRE_DB_FOR_APPOINTMENTS = "true";
process.env.GOOGLE_CLIENT_ID = "google-client";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
process.env.GOOGLE_REFRESH_TOKEN = "refresh-token";
process.env.GOOGLE_CALENDAR_ID = "ginecologiaintegralgto@gmail.com";
process.env.INCLUDE_SENSITIVE_APPOINTMENT_NOTES = "false";
process.env.FORWARD_CONVERSATION_BODIES = "false";
process.env.INCLUDE_PATIENT_CONTACT_IN_CALENDAR = "false";
process.env.AI_PROVIDER = "local";

const { assessProductionReadiness } = await import("../src/readiness.js");

test("readiness marca listo cuando lo critico esta configurado", () => {
  const result = assessProductionReadiness({ dbOk: true });
  assert.equal(result.status, "ready");
  assert.equal(result.ready, true);
  assert.equal(result.score, 100);
  assert.deepEqual(result.missing, []);
  assert.ok(Array.isArray(result.warnings));
});

test("readiness bloquea si la base requerida no esta disponible", () => {
  const result = assessProductionReadiness({ dbOk: false });
  assert.ok(result.blocking.includes("database_required"));
  assert.equal(result.ready, false);
  assert.ok(result.missing.length > 0);
  assert.notEqual(result.status, "ready");
});
