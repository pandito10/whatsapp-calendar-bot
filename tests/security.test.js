import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { verifyMetaSignature } = await import("../src/security.js");

test("acepta firma valida de Meta", () => {
  const appSecret = "super-secret-test";
  const rawBody = Buffer.from(JSON.stringify({ hello: "world" }));
  const signature = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");

  assert.equal(
    verifyMetaSignature({ appSecret, signatureHeader: `sha256=${signature}`, rawBody }),
    true
  );
});

test("rechaza firma invalida de Meta", () => {
  assert.equal(
    verifyMetaSignature({ appSecret: "super-secret-test", signatureHeader: "sha256=" + "0".repeat(64), rawBody: Buffer.from("{}") }),
    false
  );
});

test("rechaza firma mal formada", () => {
  assert.equal(
    verifyMetaSignature({ appSecret: "super-secret-test", signatureHeader: "sha1=abc", rawBody: Buffer.from("{}") }),
    false
  );
});
