import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
process.env.AI_PROVIDER = "local";
process.env.CLINIC_TIMEZONE = "America/Mexico_City";
process.env.APPOINTMENT_DURATION_MINUTES = "40";
process.env.CLINIC_WORK_DAYS = "1,2,3,4,5";
process.env.CLINIC_START_TIME = "16:40";
process.env.CLINIC_END_TIME = "20:00";
process.env.INCLUDE_SENSITIVE_APPOINTMENT_NOTES = "false";
process.env.INCLUDE_PATIENT_CONTACT_IN_CALENDAR = "false";

const { buildCalendarEventPayload } = await import("../src/calendar.js");

const slot = {
  start: "2030-06-17T22:40:00.000Z",
  end: "2030-06-17T23:20:00.000Z"
};

test("calendar minimiza telefono y no manda motivo sensible por default", () => {
  const payload = buildCalendarEventPayload(slot, {
    name: "Ana\nPrueba",
    phone: "5214771234567",
    email: "ana@example.com",
    reason: "dolor y datos sensibles"
  });

  assert.match(payload.summary, /Ana Prueba/);
  assert.match(payload.description, /52147\*\*\*\*567/);
  assert.doesNotMatch(payload.description, /4771234/);
  assert.doesNotMatch(payload.description, /dolor/);
  assert.doesNotMatch(payload.description, /ana@example.com/);
});
