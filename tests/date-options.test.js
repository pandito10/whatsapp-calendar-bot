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

const { buildDateOptionRows, dateOptionReplyText } = await import("../src/date-options.js");

test("construye opciones de fecha usando la zona horaria del consultorio", () => {
  const rows = buildDateOptionRows(new Date("2026-06-14T18:00:00.000Z"));

  assert.equal(rows[0].id, "date_2026-06-15");
  assert.equal(rows[0].title, "Mañana");
  assert.equal(rows[1].id, "date_2026-06-16");
  assert.equal(rows[1].title, "Pasado mañana");
  assert.equal(rows[2].id, "date_2026-06-17");
  assert.equal(rows.length, 8);
});

test("convierte seleccion interactiva de fecha a texto entendible", () => {
  assert.equal(dateOptionReplyText("date_2026-06-15"), "lunes, 15 de junio de 2026");
  assert.equal(dateOptionReplyText("main_schedule"), undefined);
});
