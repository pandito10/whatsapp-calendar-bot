import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb-service-role-test";

const { acquireAppointmentLock, rememberProcessedWhatsAppMessage, saveKnowledgeSuggestion } = await import("../src/db.js");

test("dedupe persistente detecta message_id duplicado", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "23505" }), { status: 409 });

  try {
    const duplicate = await rememberProcessedWhatsAppMessage("wamid.test", "5214771234567");
    assert.equal(duplicate, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("lock de cita devuelve null cuando Supabase rechaza horario duplicado", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method });
    if (String(url).includes("appointment_locks") && options?.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ code: "23505" }), { status: 409 });
  };

  try {
    const lock = await acquireAppointmentLock({
      slotStart: "2030-06-17T22:40:00.000Z",
      slotEnd: "2030-06-17T23:20:00.000Z",
      phoneNumber: "5214771234567"
    });
    assert.equal(lock, null);
    assert.ok(calls.some((call) => call.method === "DELETE"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("guarda FAQ manual como aprobada", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    return new Response(JSON.stringify([]), { status: 201 });
  };

  try {
    await saveKnowledgeSuggestion({
      question: "Atienden sabado?",
      answer: "No, por el momento solo atendemos de lunes a viernes.",
      sourcePhone: "5214771234567",
      status: "approved"
    });
    const body = JSON.parse(calls[0].body);
    assert.equal(body.status, "approved");
    assert.ok(body.reviewed_at);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
