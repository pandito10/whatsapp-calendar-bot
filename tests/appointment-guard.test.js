import test from "node:test";
import assert from "node:assert/strict";

import {
  isExistingAppointmentAcknowledgement,
  isExplicitAdditionalAppointmentRequest,
  mayNeedExistingAppointmentProtection,
  shouldProtectExistingAppointmentFromScheduling
} from "../src/appointment-guard.js";

const now = new Date("2026-06-22T18:00:00.000Z");
const upcomingCita = {
  slotStart: "2026-06-26T23:20:00.000Z",
  slotEnd: "2026-06-27T00:00:00.000Z"
};
const pastCita = {
  slotStart: "2026-06-10T23:20:00.000Z",
  slotEnd: "2026-06-11T00:00:00.000Z"
};

test("detecta que la paciente ya tiene cita aunque escriba informal", () => {
  assert.equal(isExistingAppointmentAcknowledgement("Ya tengo mi cita muchas gracias"), true);
  assert.equal(isExistingAppointmentAcknowledgement("Ya tengo la cita es el viernes a las 5:20pm"), true);
  assert.equal(isExistingAppointmentAcknowledgement("mi cita ya quedo"), true);
});

test("distingue agendar otra cita de agendar por accidente", () => {
  assert.equal(isExplicitAdditionalAppointmentRequest("quiero agendar otra cita"), true);
  assert.equal(isExplicitAdditionalAppointmentRequest("necesito una nueva consulta"), true);
  assert.equal(isExplicitAdditionalAppointmentRequest("quiero agendar"), false);
});

test("protege una cita futura cuando intentan agendar sin decir que es otra", () => {
  assert.equal(mayNeedExistingAppointmentProtection("quiero agendar", "schedule_appointment"), true);
  assert.equal(
    shouldProtectExistingAppointmentFromScheduling("quiero agendar", "schedule_appointment", upcomingCita, now),
    true
  );
});

test("no protege si la paciente pide cita adicional de forma clara", () => {
  assert.equal(
    shouldProtectExistingAppointmentFromScheduling("quiero agendar otra cita", "schedule_appointment", upcomingCita, now),
    false
  );
});

test("no protege citas pasadas", () => {
  assert.equal(
    shouldProtectExistingAppointmentFromScheduling("quiero agendar", "schedule_appointment", pastCita, now),
    false
  );
});
