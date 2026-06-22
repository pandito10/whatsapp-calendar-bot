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
  assert.equal(detectIntent("informes").intent, "featured_promo");
});

test("detecta agenda, disponibilidad y horarios", () => {
  assert.equal(detectIntent("kiero cita").intent, "schedule_appointment");
  assert.equal(detectIntent("q horarios tienen").intent, "check_availability");
  assert.equal(detectIntent("tienen citas mañana?").intent, "check_availability");
  assert.equal(detectIntent("tienen cupos para hoy").intent, "check_availability");
  assert.equal(detectIntent("hay espacios mañana").intent, "check_availability");
});

test("pide reservar por el flujo normal sin link externo", () => {
  assert.equal(detectIntent("me pasas el link para reservar").intent, "schedule_appointment");
  assert.equal(detectIntent("quiero reservar por google calendar").intent, "schedule_appointment");
});

test("detecta costo, ubicacion y formas de pago", () => {
  assert.equal(detectIntent("kuanto cuesta").intent, "cost");
  assert.equal(detectIntent("donde estan").intent, "location");
  assert.equal(detectIntent("me mandas google maps").intent, "location");
  assert.equal(detectIntent("hay estacionamiento o referencias?").intent, "location");
  assert.equal(detectIntent("puedo pagar con tarjeta").intent, "payment_methods");
  assert.equal(detectIntent("aceptan transferencia o deposito").intent, "payment_methods");
  assert.equal(detectIntent("tienen terminal").intent, "payment_methods");
});

test("detecta horario del consultorio y red medica sin mandar a fallback", () => {
  assert.equal(detectIntent("a que hora atienden").intent, "clinic_hours");
  assert.equal(detectIntent("que dias trabajan").intent, "clinic_hours");
  assert.equal(detectIntent("horario de atencion").intent, "clinic_hours");
  assert.equal(detectIntent("aceptan seguro o red medica").intent, "insurance_network");
  assert.equal(detectIntent("voy por aseguradora").intent, "insurance_network");
});

test("detecta servicios ginecologicos administrativos sin IA", () => {
  assert.equal(detectIntent("tienen ultrasonido").intent, "medical_services");
  assert.equal(detectIntent("hacen papanicolao").intent, "medical_services");
  assert.equal(detectIntent("colposkopia").intent, "medical_services");
  assert.equal(detectIntent("atienden embarazadas").intent, "medical_services");
  assert.equal(detectIntent("hacen revision de mamas").intent, "medical_services");
  assert.equal(detectIntent("atienden adolescentes").intent, "medical_services");
});

test("detecta duracion y condiciones para presentarse", () => {
  assert.equal(detectIntent("Cuanto se tardan en cada cita y en que condiciones hay que presentarse????").intent, "appointment_preparation");
  assert.equal(detectIntent("condisiones para presentarce a mi cita").intent, "appointment_preparation");
  assert.equal(detectIntent("en que condicionez tengo que ir").intent, "appointment_preparation");
  assert.equal(detectIntent("como voy preparada para el chequeo").intent, "appointment_preparation");
  assert.equal(detectIntent("puedo ir con regla").intent, "appointment_preparation");
  assert.equal(detectIntent("puedo llevar acompañante").intent, "appointment_preparation");
});

test("detecta solicitud de resultados sin confundir servicios", () => {
  assert.equal(detectIntent("me mandas mis resultados").intent, "patient_results");
  assert.equal(detectIntent("ya estan mis estudios?").intent, "patient_results");
  assert.equal(detectIntent("quiero mi diagnostico del paquete").intent, "patient_results");
  assert.equal(detectIntent("que estudios hacen").intent, "medical_services");
});

test("detecta cancelar, reagendar y humano", () => {
  assert.equal(detectIntent("kiero cancelar").intent, "cancel_appointment");
  assert.equal(detectIntent("kiero cambiar mi cita").intent, "reschedule_appointment");
  assert.equal(detectIntent("necesito otra hora para mi cita").intent, "reschedule_appointment");
  assert.equal(detectIntent("ocupo hablar con alguien").intent, "direct_contact");
  assert.equal(detectIntent("me pasas con una asesora").intent, "direct_contact");
});

test("detecta paciente nueva con variaciones reales", () => {
  assert.equal(detectIntent("soy nueva").intent, "new_patient");
  assert.equal(detectIntent("voy por primera vez").intent, "new_patient");
});

test("prioriza urgencia medica", () => {
  assert.equal(detectIntent("estoy embarazada y me duele mucho").intent, "medical_urgent");
  assert.equal(detectIntent("tengo sangrado").intent, "medical_urgent");
});

test("detecta cierres sin seguir empujando el flujo", () => {
  assert.equal(detectIntent("todo bien").intent, "closing");
  assert.equal(detectIntent("ya tengo mi cita gracias").intent, "closing");
});

test("marca desconocidos con categoria aproximada", () => {
  const result = detectIntent("me interesa saber del taller azul");
  assert.equal(result.intent, "fallback");
  assert.equal(result.category, "desconocido");
});
