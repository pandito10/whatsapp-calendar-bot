import test from "node:test";
import assert from "node:assert/strict";

const { redactSecrets } = await import("../src/http.js");

test("redacta tokens y telefonos en errores", () => {
  const text = "Bearer EAAB123456 access_token=abc123 service_role=secret 5212345678901";
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes("EAAB123456"));
  assert.ok(!redacted.includes("abc123"));
  assert.ok(!redacted.includes("secret"));
  assert.ok(redacted.includes("****"));
});
