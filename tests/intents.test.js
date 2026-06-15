import test from "node:test";
import assert from "node:assert/strict";

import { detectIntent, normalizeText } from "../src/intents.js";

test("normaliza acentos, signos y mala escritura comun", () => {
  assert.equal(normalizeText("¿KUANTO cuesta??"), "cuanto cuesta");
  assert.equal(normalizeText("kiero cita"), "quiero cita");
  assert.equal(normalizeText("colposkopia"), "colposcopia");
});

test("detecta saludo y menu", () => {
  assert.equal(detectIntent("Hola").intent, "greeting");
  assert.equal(detectIntent("informes").intent, "greeting");
});

test("detecta agenda, disponibilidad y horarios", () => {
  assert.equal(detectIntent("kiero cita").intent, "schedule_appointment");
  assert.equal(detectIntent("q horarios tienen").intent, "check_availability");
  assert.equal(detectIntent("tienen citas mañana?").intent, "check_availability");
});

test("pide reservar por el flujo normal sin link externo", () => {
  assert.equal(detectIntent("me pasas el link para reservar").intent, "schedule_appointment");
  assert.equal(detectIntent("quiero reservar por google calendar").intent, "schedule_appointment");
});

test("detecta costo, ubicacion y formas de pago", () => {
  assert.equal(detectIntent("kuanto cuesta").intent, "cost");
  assert.equal(detectIntent("donde estan").intent, "location");
  assert.equal(detectIntent("puedo pagar con tarjeta").intent, "payment_methods");
});

test("detecta servicios ginecologicos administrativos sin IA", () => {
  assert.equal(detectIntent("tienen ultrasonido").intent, "medical_services");
  assert.equal(detectIntent("hacen papanicolao").intent, "medical_services");
  assert.equal(detectIntent("colposkopia").intent, "medical_services");
  assert.equal(detectIntent("atienden embarazadas").intent, "medical_services");
});

test("detecta cancelar, reagendar y humano", () => {
  assert.equal(detectIntent("kiero cancelar").intent, "cancel_appointment");
  assert.equal(detectIntent("kiero cambiar mi cita").intent, "reschedule_appointment");
  assert.equal(detectIntent("ocupo hablar con alguien").intent, "direct_contact");
});

test("prioriza urgencia medica", () => {
  assert.equal(detectIntent("estoy embarazada y me duele mucho").intent, "medical_urgent");
  assert.equal(detectIntent("tengo sangrado").intent, "medical_urgent");
});

test("marca desconocidos con categoria aproximada", () => {
  const result = detectIntent("me interesa saber del taller azul");
  assert.equal(result.intent, "fallback");
  assert.equal(result.category, "desconocido");
});
