import test from "node:test";
import assert from "node:assert/strict";
import { parseMultipartForm } from "../src/form.js";

test("parsea campos y archivo multipart del inbox", () => {
  const boundary = "----codex-test-boundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="phone"\r\n\r\n5214770000000\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nAqui va el resultado\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="resultado.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
    Buffer.from("%PDF-test"),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);

  const form = parseMultipartForm(body, `multipart/form-data; boundary=${boundary}`);

  assert.equal(form.get("phone"), "5214770000000");
  assert.equal(form.get("message"), "Aqui va el resultado");
  assert.equal(form.getFile("attachment").filename, "resultado.pdf");
  assert.equal(form.getFile("attachment").contentType, "application/pdf");
  assert.equal(form.getFile("attachment").buffer.toString(), "%PDF-test");
});
