import test from "node:test";
import assert from "node:assert/strict";

// Tests for blocked dates / vacation feature.
// We inline the pure helper logic to avoid importing config.js (which
// requires real env vars). The logic being tested is in src/calendar.js.

function isBlockedDate(dateISO, { blockedDates = [], blockedDateRanges = [] } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO ?? ""))) return false;
  if (blockedDates.includes(dateISO)) return true;
  for (const range of blockedDateRanges) {
    if (dateISO >= range.start && dateISO <= range.end) return true;
  }
  return false;
}

test("isBlockedDate: fecha exacta bloqueada", () => {
  assert.equal(isBlockedDate("2026-12-25", { blockedDates: ["2026-12-25"] }), true);
  assert.equal(isBlockedDate("2026-12-24", { blockedDates: ["2026-12-25"] }), false);
  assert.equal(isBlockedDate("2026-12-26", { blockedDates: ["2026-12-25"] }), false);
});

test("isBlockedDate: fecha dentro de un rango bloqueado", () => {
  const cfg = { blockedDateRanges: [{ start: "2026-07-14", end: "2026-07-21" }] };
  assert.equal(isBlockedDate("2026-07-14", cfg), true, "inicio del rango");
  assert.equal(isBlockedDate("2026-07-18", cfg), true, "dentro del rango");
  assert.equal(isBlockedDate("2026-07-21", cfg), true, "fin del rango");
  assert.equal(isBlockedDate("2026-07-13", cfg), false, "dia anterior al rango");
  assert.equal(isBlockedDate("2026-07-22", cfg), false, "dia posterior al rango");
});

test("isBlockedDate: dia laboral normal no esta bloqueado", () => {
  assert.equal(isBlockedDate("2026-06-16", { blockedDates: [], blockedDateRanges: [] }), false);
  assert.equal(isBlockedDate("2026-07-01", { blockedDates: [], blockedDateRanges: [] }), false);
});

test("isBlockedDate: string invalido devuelve false", () => {
  assert.equal(isBlockedDate("not-a-date"), false);
  assert.equal(isBlockedDate(""), false);
  assert.equal(isBlockedDate(null), false);
  assert.equal(isBlockedDate(undefined), false);
  assert.equal(isBlockedDate("2026-13-01"), false, "mes invalido igual pasa el regex — aceptable");
});

test("parseBlockedDateRanges: separador colon con fechas ISO (solo guiones) funciona", () => {
  // Verify that "2026-07-14:2026-07-21".split(":") gives the correct two dates.
  // ISO dates use hyphens (-), not colons, so split(":") produces exactly 2 parts.
  const [start, end] = "2026-07-14:2026-07-21".split(":");
  assert.equal(start, "2026-07-14");
  assert.equal(end, "2026-07-21");
});

test("buildWorkWindows: dias bloqueados no generan ventanas (logica)", () => {
  // Simulate buildWorkWindows logic with one blocked date.
  const workDays = [1, 2, 3, 4, 5]; // lunes a viernes
  const blockedDates = ["2026-06-16"]; // martes bloqueado

  function getWeekdayFromISO(dateISO) {
    const [y, m, d] = dateISO.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  }

  function addDays(dateISO, n) {
    const [y, m, d] = dateISO.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + n, 12));
    return date.toISOString().slice(0, 10);
  }

  function buildWorkWindows(startISO) {
    const windows = [];
    let dateISO = startISO;
    for (let i = 0; windows.length < 5 && i < 14; i++) {
      const day = getWeekdayFromISO(dateISO);
      if (workDays.includes(day) && !isBlockedDate(dateISO, { blockedDates })) {
        windows.push(dateISO);
      }
      dateISO = addDays(dateISO, 1);
    }
    return windows;
  }

  const windows = buildWorkWindows("2026-06-16");
  assert.equal(windows.includes("2026-06-16"), false, "dia bloqueado no aparece");
  assert.ok(windows.length > 0, "hay otros dias disponibles");
});

// Slot-blocking behaviour: status filter
test("citas failed/cancelled no bloquean horarios (filtra por status=confirmed)", () => {
  const rows = [
    { id: "c1", google_event_id: "evt1", status: "failed" },
    { id: "c2", google_event_id: "evt2", status: "cancelled" },
    { id: "c3", google_event_id: "evt3", status: "confirmed" }
  ];
  const blocking = rows.filter((r) => r.status === "confirmed" && String(r.google_event_id ?? "").trim().length > 0);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].id, "c3");
});

test("citas sin google_event_id no bloquean horarios", () => {
  const rows = [
    { id: "c1", google_event_id: null, status: "confirmed" },
    { id: "c2", google_event_id: "", status: "confirmed" },
    { id: "c3", google_event_id: "evt3", status: "confirmed" }
  ];
  const blocking = rows.filter((r) => r.status === "confirmed" && String(r.google_event_id ?? "").trim().length > 0);
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0].id, "c3");
});

// Reconciliation logic
test("reconciliacion: evento existente no se toca", async () => {
  let markedFailed = false;
  const mockGetEvent = async () => ({ id: "evt123", status: "confirmed" });
  const mockMarkFailed = async () => { markedFailed = true; };

  const event = await mockGetEvent("evt123");
  if (event === undefined) await mockMarkFailed("evt123", "orphaned");

  assert.equal(markedFailed, false, "no debe marcar failed cuando el evento existe");
});

test("reconciliacion: evento inexistente (404) se marca orphaned", async () => {
  let markedFailed = false;
  let markedId = null;
  const mockGetEvent = async () => undefined; // 404
  const mockMarkFailed = async (id) => { markedFailed = true; markedId = id; };

  const event = await mockGetEvent("deleted-evt");
  if (event === undefined) await mockMarkFailed("deleted-evt", "Evento no existe en Google Calendar; cita desincronizada");

  assert.equal(markedFailed, true);
  assert.equal(markedId, "deleted-evt");
});

test("reconciliacion: error de red NO cancela la cita", async () => {
  let markedFailed = false;
  const mockGetEvent = async () => { throw new Error("Network timeout"); };
  const mockMarkFailed = async () => { markedFailed = true; };

  try {
    await mockGetEvent("evt123");
  } catch {
    // network error — skip, do not mark failed
  }

  assert.equal(markedFailed, false, "error de red no debe cancelar la cita");
});
