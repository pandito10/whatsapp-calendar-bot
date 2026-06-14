import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "sb-service-role-test";

const {
  acquireAppointmentLock,
  loadConfirmedCitasBetween,
  rememberProcessedWhatsAppMessage,
  saveCita,
  saveKnowledgeSuggestion,
  saveWaitlistEntry,
  setConversationTags
} = await import("../src/db.js");

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

test("saveCita reintenta con payload legacy si falta una columna nueva", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = options?.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: String(url), method: options?.method, body });

    if (calls.length === 1) {
      return new Response(
        JSON.stringify({
          code: "PGRST204",
          message: "Could not find the 'error_message' column of 'citas' in the schema cache"
        }),
        { status: 400 }
      );
    }

    return new Response(
      JSON.stringify([
        {
          id: 7,
          phone_number: "5214771234567",
          slot_start: "2030-06-17T22:40:00.000Z",
          slot_end: "2030-06-17T23:20:00.000Z",
          status: "confirmed"
        }
      ]),
      { status: 201 }
    );
  };

  try {
    const cita = await saveCita({
      phoneNumber: "5214771234567",
      patientName: "Ana Lopez",
      patientEmail: "ana@example.com",
      googleEventId: "calendar-event-1",
      slotStart: "2030-06-17T22:40:00.000Z",
      slotEnd: "2030-06-17T23:20:00.000Z",
      status: "confirmed",
      firstVisit: "Si",
      paymentType: "Particular",
      reason: "Consulta",
      errorMessage: "test"
    });

    assert.equal(cita.id, 7);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.error_message, "test");
    assert.equal(calls[1].body.error_message, undefined);
    assert.equal(calls[1].body.first_visit, undefined);
    assert.equal(calls[1].body.payment_type, undefined);
    assert.equal(calls[1].body.reason, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("carga citas confirmadas en un rango para filtrar disponibilidad", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(
      JSON.stringify([
        {
          id: 3,
          slot_start: "2030-06-17T22:40:00.000Z",
          slot_end: "2030-06-17T23:20:00.000Z",
          status: "confirmed"
        }
      ]),
      { status: 200 }
    );
  };

  try {
    const citas = await loadConfirmedCitasBetween("2030-06-17T22:00:00.000Z", "2030-06-18T01:00:00.000Z");
    assert.match(requestedUrl, /status=eq\.confirmed/);
    assert.match(requestedUrl, /slot_start=lt\./);
    assert.match(requestedUrl, /slot_end=gt\./);
    assert.equal(citas.length, 1);
    assert.equal(citas[0].slotStart, "2030-06-17T22:40:00.000Z");
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

test("guarda pregunta no reconocida pendiente sin respuesta", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    return new Response(JSON.stringify([]), { status: 201 });
  };

  try {
    await saveKnowledgeSuggestion({
      question: "Que es el paquete azul?",
      sourcePhone: "5214771234567",
      category: "desconocido",
      status: "pending"
    });
    const body = JSON.parse(calls[0].body);
    assert.equal(body.status, "pending");
    assert.equal(body.answer, null);
    assert.equal(body.category, "desconocido");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("guarda entrada de lista de espera", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    return new Response(JSON.stringify([]), { status: 201 });
  };

  try {
    await saveWaitlistEntry({
      phoneNumber: "5214771234567",
      patientName: "Ana Lopez",
      desiredDate: "2030-06-17",
      desiredRange: "tarde",
      service: "Consulta"
    });
    const body = JSON.parse(calls[0].body);
    assert.equal(body.phone_number, "5214771234567");
    assert.equal(body.status, "waiting");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("guarda etiquetas de conversacion", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    return new Response(JSON.stringify([]), { status: 201 });
  };

  try {
    await setConversationTags("5214771234567", ["Urgente", "Humano requerido"]);
    const body = JSON.parse(calls[0].body);
    assert.deepEqual(body.tags, ["Urgente", "Humano requerido"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
