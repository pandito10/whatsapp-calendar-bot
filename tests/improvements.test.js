import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_VERIFY_TOKEN = "test";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123";
process.env.WHATSAPP_ACCESS_TOKEN = "test";
process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
process.env.AI_PROVIDER = "local";
process.env.CLINIC_TIMEZONE = "America/Mexico_City";
process.env.APPOINTMENT_DURATION_MINUTES = "40";
process.env.CLINIC_WORK_DAYS = "1,2,3,4,5";
process.env.CLINIC_START_TIME = "16:40";
process.env.CLINIC_END_TIME = "20:00";

const { isSheetsEnabled } = await import("../src/sheets.js");
const { detectIntent } = await import("../src/intents.js");

test("sheets deshabilitado por defecto no rompe nada", () => {
  assert.equal(isSheetsEnabled(), false);
});

test("agendar promo detecta intento de agendar", () => {
  const result = detectIntent("agendar promo");
  assert.ok(result.intent);
});

test("isSkipEmailText patterns", () => {
  const result1 = detectIntent("sin correo");
  assert.ok(result1.intent !== "medical_urgent");

  const result2 = detectIntent("no tengo correo");
  assert.ok(result2.intent !== "medical_urgent");
});

test("sheets disabled: bot works normally", () => {
  assert.equal(isSheetsEnabled(), false);
});
