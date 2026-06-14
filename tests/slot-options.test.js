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

const { buildSlotOptionRows, slotOptionReplyText } = await import("../src/slot-options.js");

test("construye filas interactivas para horarios disponibles", () => {
  const rows = buildSlotOptionRows([
    {
      start: "2026-06-15T22:40:00.000Z",
      end: "2026-06-15T23:20:00.000Z",
      label: "lunes, 15 de junio de 2026, 4:40 p.m."
    },
    {
      start: "2026-06-15T23:20:00.000Z",
      end: "2026-06-16T00:00:00.000Z",
      label: "lunes, 15 de junio de 2026, 5:20 p.m."
    }
  ]);

  assert.equal(rows[0].id, "slot_1");
  assert.match(rows[0].title, /^1\./);
  assert.match(rows[0].description, /4:40/);
  assert.equal(rows[1].id, "slot_2");
});

test("convierte seleccion interactiva de horario a numero", () => {
  assert.equal(slotOptionReplyText("slot_2"), "2");
  assert.equal(slotOptionReplyText("date_2026-06-15"), undefined);
});
