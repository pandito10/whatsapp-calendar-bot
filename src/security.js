import crypto from "node:crypto";

export function verifyMetaSignature({ appSecret, signatureHeader, rawBody }) {
  if (!appSecret || !signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const actualHex = signatureHeader.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(actualHex)) return false;

  const expectedHex = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expected = Buffer.from(expectedHex, "hex");
  const actual = Buffer.from(actualHex, "hex");

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
