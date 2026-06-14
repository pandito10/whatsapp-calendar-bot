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
process.env.INCLUDE_SENSITIVE_APPOINTMENT_NOTES = "false";
process.env.INCLUDE_PATIENT_CONTACT_IN_CALENDAR = "false";
process.env.GOOGLE_CLIENT_ID = "google-client";
process.env.GOOGLE_CLIENT_SECRET = "google-secret";
process.env.GOOGLE_REFRESH_TOKEN = "google-refresh";
process.env.GOOGLE_CALENDAR_ID = "calendar-test";
process.env.GOOGLE_CALENDAR_EVENT_SUMMARY_PREFIX = "DRA. CARRANZA-";
process.env.GOOGLE_BUSY_CALENDAR_IDS = "busy-calendar,calendar-test";

const { buildCalendarEventPayload, createAppointment, findAvailableSlots, isClinicWorkDateISO, isSlotAvailable, resolveClinicDateISO } = await import("../src/calendar.js");

const slot = {
  start: "2030-06-17T22:40:00.000Z",
  end: "2030-06-17T23:20:00.000Z"
};

test("calendar minimiza telefono y no manda motivo sensible por default", () => {
  const payload = buildCalendarEventPayload(slot, {
    name: "Ana\nPrueba",
    phone: "5214771234567",
    email: "ana@example.com",
    reason: "dolor y datos sensibles"
  });

  assert.match(payload.summary, /Ana Prueba/);
  assert.match(payload.summary, /^DRA\. CARRANZA- \(Ana Prueba\)$/);
  assert.equal(payload.colorId, "9");
  assert.doesNotMatch(payload.summary, /ginec/i);
  assert.match(payload.description, /52147\*\*\*\*567/);
  assert.doesNotMatch(payload.description, /4771234/);
  assert.doesNotMatch(payload.description, /dolor/);
  assert.doesNotMatch(payload.description, /ana@example.com/);
});

test("resuelve mañana usando zona horaria del consultorio, no UTC del servidor", () => {
  const nearMidnightUtc = new Date("2026-06-14T04:30:00.000Z");
  assert.equal(resolveClinicDateISO("mañana", undefined, nearMidnightUtc), "2026-06-14");
});

test("valida dia laboral con fecha pura y no con zona del servidor", () => {
  assert.equal(isClinicWorkDateISO("2026-10-25"), false);
  assert.equal(isClinicWorkDateISO("2026-10-26"), true);
});

test("createAppointment falla claramente si Google Calendar rechaza el evento", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 });
    }

    return new Response(JSON.stringify({ error: { message: "calendar unavailable" } }), { status: 500 });
  };

  try {
    await assert.rejects(
      () => createAppointment(slot, { name: "Ana", phone: "5214771234567" }),
      /Google API failed: 500/
    );
    assert.ok(calls.some((call) => call.url.includes("/calendar/v3/calendars/calendar-test/events")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disponibilidad bloquea horarios ocupados en calendario configurado", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : undefined });
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 });
    }

    return new Response(
      JSON.stringify({
        calendars: {
          "busy-calendar": {
            busy: [{ start: "2030-06-17T22:40:00.000Z", end: "2030-06-17T23:20:00.000Z" }]
          },
          "calendar-test": { busy: [] }
        }
      }),
      { status: 200 }
    );
  };

  try {
    const slots = await findAvailableSlots("lunes", "2030-06-17");
    const freeBusyCall = calls.find((call) => call.url.includes("/calendar/v3/freeBusy"));
    assert.deepEqual(freeBusyCall.body.items, [{ id: "busy-calendar" }, { id: "calendar-test" }]);
    assert.ok(!slots.some((item) => item.start === "2030-06-17T22:40:00.000Z"));
    assert.equal(slots[0].start, "2030-06-17T23:20:00.000Z");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("confirmacion bloquea si un calendario configurado esta ocupado", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 });
    }

    return new Response(
      JSON.stringify({
        calendars: {
          "busy-calendar": {
            busy: [{ start: slot.start, end: slot.end }]
          },
          "calendar-test": { busy: [] }
        }
      }),
      { status: 200 }
    );
  };

  try {
    assert.equal(await isSlotAvailable(slot), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
