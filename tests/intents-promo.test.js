import test from "node:test";
import assert from "node:assert/strict";
import { detectIntent, normalizeText } from "../src/intents.js";

// featured_promo tests
test("detecta featured_promo desde 'informes'", () => {
  assert.equal(detectIntent("informes").intent, "featured_promo");
});

test("detecta featured_promo desde 'vi el anuncio'", () => {
  assert.equal(detectIntent("vi el anuncio").intent, "featured_promo");
});

test("detecta featured_promo desde '1200'", () => {
  assert.equal(detectIntent("cuanto cuesta el de 1200").intent, "featured_promo");
});

test("detecta featured_promo desde 'cuanto es el de 1200'", () => {
  assert.equal(detectIntent("cuanto es el de 1200").intent, "featured_promo");
});

test("detecta featured_promo desde facebook", () => {
  assert.equal(detectIntent("vi algo en facebook").intent, "featured_promo");
});

test("detecta featured_promo desde instagram", () => {
  assert.equal(detectIntent("vi tu anuncio en instagram").intent, "featured_promo");
});

test("detecta featured_promo desde vi la promo", () => {
  assert.equal(detectIntent("vi la promo").intent, "featured_promo");
});

test("detecta featured_promo desde chequeo ginecologico", () => {
  assert.equal(detectIntent("quiero el chequeo ginecologico").intent, "featured_promo");
});

test("detecta featured_promo desde paquete ginecologico", () => {
  assert.equal(detectIntent("me interesa el paquete ginecologico").intent, "featured_promo");
});

test("detecta featured_promo desde me interesa la promo", () => {
  assert.equal(detectIntent("me interesa la promo").intent, "featured_promo");
});

test("detecta featured_promo desde respuestas cortas de anuncios", () => {
  assert.equal(detectIntent("info").intent, "featured_promo");
  assert.equal(detectIntent("me interesa").intent, "featured_promo");
  assert.equal(detectIntent("mas info").intent, "featured_promo");
  assert.equal(detectIntent("paquete 1200").intent, "featured_promo");
});

test("detecta featured_promo desde leads reales de anuncios", () => {
  assert.equal(detectIntent("me podria brindar informacion").intent, "featured_promo");
  assert.equal(detectIntent("me puedes dar mas informacion").intent, "featured_promo");
  assert.equal(detectIntent("vi su publicacion").intent, "featured_promo");
  assert.equal(detectIntent("me salio el anuncio").intent, "featured_promo");
  assert.equal(detectIntent("quisiera informacion").intent, "featured_promo");
});

test("detecta featured_promo desde preguntas de que incluye", () => {
  assert.equal(detectIntent("que contiene la promo").intent, "featured_promo");
  assert.equal(detectIntent("que trae el chequeo").intent, "featured_promo");
  assert.equal(detectIntent("que viene incluido").intent, "featured_promo");
  assert.equal(detectIntent("en que consiste").intent, "featured_promo");
});

test("normaliza errores comunes de leads de promo", () => {
  assert.equal(detectIntent("informasion de la promosion").intent, "featured_promo");
  assert.equal(detectIntent("me intereza el pakete").intent, "featured_promo");
  assert.equal(detectIntent("chekeo ginecologico completoo").intent, "featured_promo");
});

test("detecta promo_schedule cuando quieren agendar la promocion", () => {
  assert.equal(detectIntent("quiero agendar la promo").intent, "promo_schedule");
  assert.equal(detectIntent("apartar el paquete de 1200").intent, "promo_schedule");
});

// recent_sex_before_exam tests
test("detecta recent_sex_before_exam desde tuve relaciones hoy", () => {
  assert.equal(detectIntent("tuve relaciones hoy").intent, "recent_sex_before_exam");
});

test("detecta recent_sex_before_exam desde tuve relaciones ayer", () => {
  assert.equal(detectIntent("tuve relaciones ayer").intent, "recent_sex_before_exam");
});

test("detecta recent_sex_before_exam desde sexo anoche", () => {
  assert.equal(detectIntent("tuve sexo anoche").intent, "recent_sex_before_exam");
});

test("detecta recent_sex_before_exam desde relaciones antes del papanicolaou", () => {
  assert.equal(detectIntent("tuve relaciones antes del papanicolaou").intent, "recent_sex_before_exam");
});

test("detecta recent_sex_before_exam desde si tuve relaciones", () => {
  assert.equal(detectIntent("si tuve relaciones").intent, "recent_sex_before_exam");
});

// contact_info tests
test("detecta contact_info desde telefono (solo)", () => {
  assert.equal(detectIntent("telefono").intent, "contact_info");
});

test("detecta contact_info desde cual es el numero", () => {
  assert.equal(detectIntent("cual es el numero").intent, "contact_info");
});

test("detecta contact_info desde me pasas el telefono", () => {
  assert.equal(detectIntent("me pasas el telefono").intent, "contact_info");
});

test("detecta contact_info desde numero de telefono", () => {
  assert.equal(detectIntent("numero de telefono").intent, "contact_info");
});

// Verify priority ordering
test("medical_urgent tiene prioridad sobre recent_sex", () => {
  // If someone says they had sex AND they have heavy bleeding, medical_urgent wins
  assert.equal(detectIntent("tuve relaciones y tengo sangrado abundante").intent, "medical_urgent");
});

test("greeting NO detecta informes (informes va a featured_promo)", () => {
  assert.notEqual(detectIntent("informes").intent, "greeting");
  assert.equal(detectIntent("informes").intent, "featured_promo");
});

test("greeting sigue detectando hola", () => {
  assert.equal(detectIntent("Hola").intent, "greeting");
});

test("greeting sigue detectando buenas", () => {
  assert.equal(detectIntent("buenas").intent, "greeting");
});

// Verify normalizeText works for promo queries
test("normaliza correctamente palabras con acento para promo", () => {
  // "chequeo ginecológico" normalized should still be detectable
  assert.equal(detectIntent("chequeo ginecologico completo").intent, "featured_promo");
});
