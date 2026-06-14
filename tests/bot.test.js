import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

const { understandMessage } = await import("../src/ai.js");
const { isSlotWithinClinicRules } = await import("../src/calendar.js");

test("parser local detecta solicitud de agendar", async () => {
  const result = await understandMessage("Hola, quiero agendar una cita mañana", undefined);
  assert.ok(["schedule_appointment", "book_appointment"].includes(result.intent));
  assert.ok(result.preferredDateText);
});

test("parser local detecta seleccion de horario", async () => {
  const result = await understandMessage("2", { step: "choosingSlot" });
  assert.equal(result.selectedSlotIndex, 2);
});

test("parser local detecta seleccion de horario por texto", async () => {
  const result = await understandMessage("la ultima", {
    step: "choosingSlot",
    offeredSlots: [
      { start: "2030-06-17T22:40:00.000Z" },
      { start: "2030-06-17T23:20:00.000Z" },
      { start: "2030-06-18T00:00:00.000Z" }
    ]
  });
  assert.equal(result.selectedSlotIndex, 3);
});

test("parser local selecciona horario mostrado en disponibilidad", async () => {
  const result = await understandMessage("2", {
    step: "choosingAvailabilitySlot",
    availabilityOnly: true,
    offeredSlots: [
      { start: "2030-06-17T22:40:00.000Z" },
      { start: "2030-06-17T23:20:00.000Z" }
    ]
  });
  assert.equal(result.selectedSlotIndex, 2);
});

test("parser local detecta rango despues de las 5 sin IA", async () => {
  const result = await understandMessage("tienes cita despues de las 5", undefined);
  assert.equal(result.intent, "check_availability");
  assert.equal(result.preferredTimeRange.start, 17 * 60);
});

test("parser local entiende fechas con mes escrito", async () => {
  const result = await understandMessage("25 de octubre", { step: "collectingDateOnly", availabilityOnly: true });
  assert.equal(result.intent, "check_availability");
  assert.equal(result.preferredDateISO, "2026-10-25");
});

test("parser local entiende fecha con mes dentro de una pregunta", async () => {
  const result = await understandMessage("tienes cita el 25 de octubre?", undefined);
  assert.equal(result.intent, "check_availability");
  assert.equal(result.preferredDateISO, "2026-10-25");
});

test("parser local extrae correo corregido durante confirmacion", async () => {
  const result = await understandMessage("Perdon es paciente.correcto@gmail.com", {
    step: "confirmingAppointment",
    email: "mal@gmail.com"
  });
  assert.equal(result.email, "paciente.correcto@gmail.com");
});

test("valida horario dentro de reglas del consultorio", () => {
  assert.equal(
    isSlotWithinClinicRules({ start: "2030-06-17T22:40:00.000Z", end: "2030-06-17T23:20:00.000Z" }),
    true
  );
});

test("rechaza horario en fin de semana", () => {
  assert.equal(
    isSlotWithinClinicRules({ start: "2030-06-15T22:40:00.000Z", end: "2030-06-15T23:20:00.000Z" }),
    false
  );
});

test("rechaza horario con duracion incorrecta", () => {
  assert.equal(
    isSlotWithinClinicRules({ start: "2030-06-17T22:40:00.000Z", end: "2030-06-17T23:10:00.000Z" }),
    false
  );
});

test("rechaza horario que no respeta anticipacion minima", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const { isSlotWithinClinicRules } = await import('./src/calendar.js'); const start = new Date(Date.now() + 2 * 60 * 60 * 1000); const end = new Date(start.getTime() + 40 * 60_000); if (isSlotWithinClinicRules({ start: start.toISOString(), end: end.toISOString() })) process.exit(1);"
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        NODE_ENV: "test",
        WHATSAPP_VERIFY_TOKEN: "verify-token-test",
        WHATSAPP_PHONE_NUMBER_ID: "123456789",
        WHATSAPP_ACCESS_TOKEN: "whatsapp-token-test",
        DOCTOR_WHATSAPP_NUMBER: "5210000000000",
        MIN_APPOINTMENT_ADVANCE_HOURS: "24",
        CLINIC_TIMEZONE: "America/Mexico_City",
        CLINIC_WORK_DAYS: "0,1,2,3,4,5,6",
        CLINIC_START_TIME: "00:00",
        CLINIC_END_TIME: "23:59",
        APPOINTMENT_DURATION_MINUTES: "40"
      },
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
