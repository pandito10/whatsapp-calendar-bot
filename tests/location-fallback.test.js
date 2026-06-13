import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
process.env.AI_PROVIDER = "local";
process.env.CLINIC_ADDRESS = "";

const { buildLocationMessage } = await import("../src/appointments.js");

test("ubicacion vacia usa respuesta segura sin direccion hardcodeada", () => {
  const message = buildLocationMessage();
  assert.match(message, /consultorio compartira la ubicacion directamente/i);
  assert.doesNotMatch(message, /Plaza de la Paz/i);
});
