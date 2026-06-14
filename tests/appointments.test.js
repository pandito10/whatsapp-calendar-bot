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
process.env.CLINIC_ADDRESS = "Consultorio Seguro 123";
process.env.ENABLE_PATIENT_REMINDER_TEMPLATES = "false";

const {
  validateSlotSelection,
  buildAdminAppointmentNotification,
  buildAppointmentReviewMessage,
  buildLocationMessage,
  buildPatientReminderJobs,
  buildPatientConfirmationMessage,
  buildAppointmentFailureMessage,
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

test("resumen previo pide confirmacion antes de agendar", () => {
  const message = buildAppointmentReviewMessage({
    name: "Ana",
    slot: validSlot,
    email: "ana@example.com",
    firstVisit: "Si",
    paymentType: "Particular"
  });
  assert.match(message, /antes de confirmar/i);
  assert.match(message, /responde SI/i);
  assert.match(message, /NO para elegir otro horario/i);
});

test("ubicacion usa CLINIC_ADDRESS configurable", () => {
  assert.match(buildLocationMessage(), /Consultorio Seguro 123/);
});

test("no programa recordatorios de paciente sin templates aprobados", () => {
  const jobs = buildPatientReminderJobs({
    phoneNumber: "5214771234567",
    session: { name: "Ana" },
    slot: validSlot,
    slotStartMs: new Date(validSlot.start).getTime()
  });
  assert.deepEqual(jobs, []);
});

test("clasifica errores de calendario y base de datos", () => {
  assert.equal(classifyAppointmentError(new Error("Google Calendar 500")), "calendar");
  assert.equal(classifyAppointmentError(new Error("Supabase request failed")), "database");
  assert.equal(
    classifyAppointmentError(new Error("Supabase request failed: 409 duplicate key value violates unique constraint")),
    "double_booking"
  );
  assert.equal(
    classifyAppointmentError(new Error("PGRST204 Could not find the 'error_message' column in the schema cache")),
    "database_schema"
  );
});

test("mensaje de falla por doble cita ofrece revisar otro horario", () => {
  const message = buildAppointmentFailureMessage("double_booking");
  assert.match(message, /se acaba de ocupar/i);
  assert.match(message, /nuevos horarios/i);
});

test("sanitiza texto corto para mensajes operativos", () => {
  assert.equal(sanitizeShortText(" Hola\n\tMundo  ", 20), "Hola Mundo");
});
