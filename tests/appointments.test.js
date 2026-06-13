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

const {
  validateSlotSelection,
  buildAdminAppointmentNotification,
  buildPatientConfirmationMessage,
  classifyAppointmentError,
  sanitizeShortText
} = await import("../src/appointments.js");

const validSlot = {
  start: "2030-06-17T22:40:00.000Z",
  end: "2030-06-17T23:20:00.000Z",
  label: "lunes, 17 de junio de 2030, 4:40 p.m."
};

test("valida una seleccion de horario ofrecido", () => {
  const result = validateSlotSelection({ slot: validSlot, selectedSlotIndex: 1, session: { offeredSlots: [validSlot] } });
  assert.equal(result.ok, true);
});

test("rechaza una seleccion que no fue ofrecida", () => {
  const result = validateSlotSelection({ slot: validSlot, selectedSlotIndex: 2, session: { offeredSlots: [validSlot] } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "slot_not_offered");
});

test("la notificacion al admin no incluye motivo medico literal", () => {
  const message = buildAdminAppointmentNotification({
    name: "Paciente Prueba",
    from: "5214771234567",
    slot: validSlot,
    session: { reason: "tengo dolor fuerte y detalles sensibles" }
  });
  assert.match(message, /revisar conversacion en inbox/i);
  assert.doesNotMatch(message, /dolor fuerte/i);
  assert.match(message, /52147\*\*\*\*567/);
});

test("confirmacion al paciente incluye advertencia de urgencias", () => {
  const message = buildPatientConfirmationMessage({ name: "Ana", slot: validSlot, email: "ana@example.com" });
  assert.match(message, /quedo agendada/i);
  assert.match(message, /urgencias/i);
});

test("clasifica errores de calendario y base de datos", () => {
  assert.equal(classifyAppointmentError(new Error("Google Calendar 500")), "calendar");
  assert.equal(classifyAppointmentError(new Error("Supabase request failed")), "database");
});

test("sanitiza texto corto para mensajes operativos", () => {
  assert.equal(sanitizeShortText(" Hola\n\tMundo  ", 20), "Hola Mundo");
});
