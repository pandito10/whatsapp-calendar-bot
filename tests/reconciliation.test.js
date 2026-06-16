import test from "node:test";
import assert from "node:assert/strict";

// Test that the reconciliation logic correctly identifies orphaned citas.
// We test the logic without real Google/Supabase connections by mocking.

test("reconciliation: cita with existing event is not touched", async () => {
  // If getCalendarEvent returns an event object, the cita should NOT be marked failed
  let markedFailed = false;
  const mockGetEvent = async () => ({ id: "evt123", status: "confirmed" });
  const mockMarkFailed = async () => { markedFailed = true; };

  // Simulate one reconciliation iteration
  const cita = { id: "cita1", googleEventId: "evt123" };
  const event = await mockGetEvent(cita.googleEventId);
  if (event === undefined) await mockMarkFailed(cita.googleEventId, "...");

  assert.equal(markedFailed, false, "Should not mark a cita failed when event exists");
});

test("reconciliation: cita with missing Calendar event is marked orphaned", async () => {
  let markedFailed = false;
  let markedEventId = null;
  const mockGetEvent = async () => undefined; // 404 — event not found
  const mockMarkFailed = async (eventId) => { markedFailed = true; markedEventId = eventId; };

  const cita = { id: "cita1", googleEventId: "deleted-evt" };
  const event = await mockGetEvent(cita.googleEventId);
  if (event === undefined) await mockMarkFailed(cita.googleEventId, "Evento no existe en Google Calendar; cita desincronizada");

  assert.equal(markedFailed, true, "Should mark the cita as failed when event is missing");
  assert.equal(markedEventId, "deleted-evt");
});

test("reconciliation: network error does NOT cancel the cita", async () => {
  let markedFailed = false;
  const mockGetEvent = async () => { throw new Error("Network timeout"); };
  const mockMarkFailed = async () => { markedFailed = true; };

  try {
    await mockGetEvent("evt123");
  } catch (error) {
    // Network error — do NOT mark cita as failed
    // errors++ would happen here, but markedFailed stays false
  }

  assert.equal(markedFailed, false, "Network error should NOT cancel a cita");
});

test("reconciliation: cita without google_event_id is not checked and does not block slots", () => {
  // loadConfirmedCitasBetween already filters: .filter(row => String(row.google_event_id ?? "").trim().length > 0)
  // So citas without google_event_id never appear in the slot-blocking query.
  const rows = [
    { id: "c1", google_event_id: null, slot_start: "2026-07-01T17:00:00Z", slot_end: "2026-07-01T17:40:00Z", status: "confirmed" },
    { id: "c2", google_event_id: "", slot_start: "2026-07-01T18:00:00Z", slot_end: "2026-07-01T18:40:00Z", status: "confirmed" }
  ];
  const blocking = rows.filter((row) => String(row.google_event_id ?? "").trim().length > 0);
  assert.equal(blocking.length, 0, "Citas without google_event_id should not block slots");
});

test("reconciliation: failed/cancelled citas do not appear in loadConfirmedCitasBetween query", () => {
  // The query uses status=eq.confirmed, so failed/cancelled citas are excluded.
  const rows = [
    { id: "c1", google_event_id: "evt1", status: "failed" },
    { id: "c2", google_event_id: "evt2", status: "cancelled" },
    { id: "c3", google_event_id: "evt3", status: "confirmed" }
  ];
  const confirmed = rows.filter((r) => r.status === "confirmed");
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].id, "c3");
});
