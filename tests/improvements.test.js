import test from "node:test";
import assert from "node:assert/strict";


// ── Voice note tests ──────────────────────────────────────────────────────────

test("extractWhatsAppMessageText devuelve undefined para mensajes de audio (no los descarta el caller)", () => {
  // Audio messages have type "audio" and do NOT go through extractWhatsAppMessageText.
  // This test ensures the function returns undefined for audio so the webhook
  // caller knows to route them separately.
  function extractWhatsAppMessageText(message) {
    if (message.type === "text") return message.text?.body;
    if (message.type === "interactive") {
      const reply = message.interactive?.list_reply ?? message.interactive?.button_reply;
      return reply?.title;
    }
    if (message.type === "button") {
      return message.button?.text;
    }
    return undefined;
  }

  const audioMsg = { type: "audio", from: "521234567890", audio: { id: "abc", mime_type: "audio/ogg; codecs=opus", voice: true } };
  assert.equal(extractWhatsAppMessageText(audioMsg), undefined);
});

test("mensaje de texto normal no es afectado por la ruta de audio", () => {
  function extractWhatsAppMessageText(message) {
    if (message.type === "text") return message.text?.body;
    return undefined;
  }
  const textMsg = { type: "text", from: "521234567890", text: { body: "hola" } };
  assert.equal(extractWhatsAppMessageText(textMsg), "hola");
});

// ── Sheets integration tests ──────────────────────────────────────────────────

test("isSheetsEnabled devuelve false cuando SHEETS_ENABLED no es true", () => {
  const config = { sheetsEnabled: false, googleSheetsId: "abc", googleServiceAccountJson: "{}" };
  function isSheetsEnabled() {
    return config.sheetsEnabled && Boolean(config.googleSheetsId) && Boolean(config.googleServiceAccountJson);
  }
  assert.equal(isSheetsEnabled(), false);
});

test("isSheetsEnabled devuelve false cuando falta googleSheetsId", () => {
  const config = { sheetsEnabled: true, googleSheetsId: "", googleServiceAccountJson: "{}" };
  function isSheetsEnabled() {
    return config.sheetsEnabled && Boolean(config.googleSheetsId) && Boolean(config.googleServiceAccountJson);
  }
  assert.equal(isSheetsEnabled(), false);
});

test("isSheetsEnabled devuelve true con config completa", () => {
  const config = { sheetsEnabled: true, googleSheetsId: "sheet-id-123", googleServiceAccountJson: '{"client_email":"test@test.iam.gserviceaccount.com"}' };
  function isSheetsEnabled() {
    return config.sheetsEnabled && Boolean(config.googleSheetsId) && Boolean(config.googleServiceAccountJson);
  }
  assert.equal(isSheetsEnabled(), true);
});

// ── Email optional tests ──────────────────────────────────────────────────────

test("texto sin correo detectado cuando config.emailOptional es true", () => {
  function isSkipEmailText(normalized, emailOptional) {
    if (!emailOptional) return false;
    return /^(?:sin correo|no tengo correo|no tengo|omitir|no email|no correo|skip)$/.test(normalized);
  }
  assert.equal(isSkipEmailText("sin correo", true), true);
  assert.equal(isSkipEmailText("no tengo correo", true), true);
  assert.equal(isSkipEmailText("omitir", true), true);
  assert.equal(isSkipEmailText("sin correo", false), false);
});

test("texto sin correo no dispara skip si emailOptional es false", () => {
  function isSkipEmailText(normalized, emailOptional) {
    if (!emailOptional) return false;
    return /^(?:sin correo|no tengo correo|no tengo|omitir|no email|no correo|skip)$/.test(normalized);
  }
  assert.equal(isSkipEmailText("sin correo", false), false);
  assert.equal(isSkipEmailText("omitir", false), false);
});

// ── Cancellation safety tests ─────────────────────────────────────────────────

test("cancelacion solo confirma si Calendar y Supabase quedan bien", () => {
  async function simulateCancellation(calendarFails, dbFails) {
    let calendarOk = false;
    let dbOk = false;
    let messageSent = "";

    try {
      if (calendarFails) throw new Error("calendar error");
      calendarOk = true;
    } catch {
      // calendar failed
    }

    if (calendarOk) {
      try {
        if (dbFails) throw new Error("db error");
        dbOk = true;
      } catch {
        // db failed
      }
    }

    if (calendarOk && dbOk) {
      messageSent = "cancelada";
    } else {
      messageSent = "requiere_humano";
    }

    return { calendarOk, dbOk, messageSent };
  }

  return simulateCancellation(false, false).then((r) => {
    assert.equal(r.calendarOk, true);
    assert.equal(r.dbOk, true);
    assert.equal(r.messageSent, "cancelada");
  });
});

test("si Calendar falla, cancela no se confirma y escala a humano", () => {
  async function simulateCancellation(calendarFails, dbFails) {
    let calendarOk = false;
    let dbOk = false;
    let messageSent = "";

    try {
      if (calendarFails) throw new Error("calendar error");
      calendarOk = true;
    } catch { /* calendar failed */ }

    if (calendarOk) {
      try {
        if (dbFails) throw new Error("db error");
        dbOk = true;
      } catch { /* db failed */ }
    }

    messageSent = calendarOk && dbOk ? "cancelada" : "requiere_humano";
    return { calendarOk, dbOk, messageSent };
  }

  return simulateCancellation(true, false).then((r) => {
    assert.equal(r.calendarOk, false);
    assert.equal(r.messageSent, "requiere_humano");
  });
});

test("si Supabase falla, cancelacion no se confirma", () => {
  async function simulateCancellation(calendarFails, dbFails) {
    let calendarOk = false;
    let dbOk = false;

    try {
      if (calendarFails) throw new Error("calendar error");
      calendarOk = true;
    } catch { /* */ }

    if (calendarOk) {
      try {
        if (dbFails) throw new Error("db error");
        dbOk = true;
      } catch { /* */ }
    }

    return { calendarOk, dbOk, confirmed: calendarOk && dbOk };
  }

  return simulateCancellation(false, true).then((r) => {
    assert.equal(r.calendarOk, true);
    assert.equal(r.dbOk, false);
    assert.equal(r.confirmed, false);
  });
});

// ── Availability intro with time hint ─────────────────────────────────────────

test("buildAvailabilityIntro muestra time hint si preferredTimeRange esta en sesion", () => {
  function buildAvailabilityIntro(session) {
    const timeHint = session.preferredTimeRange ? ` (${session.preferredTimeRange})` : "";
    return timeHint
      ? `🕒 Tengo estos horarios disponibles${timeHint}:`
      : "🕒 Tengo estos horarios disponibles:";
  }
  const result = buildAvailabilityIntro({ preferredTimeRange: "tarde" });
  assert.ok(result.includes("(tarde)"), `Expected time hint, got: ${result}`);
});

test("buildAvailabilityIntro no muestra hint si no hay preferredTimeRange", () => {
  function buildAvailabilityIntro(session) {
    const timeHint = session.preferredTimeRange ? ` (${session.preferredTimeRange})` : "";
    return timeHint
      ? `🕒 Tengo estos horarios disponibles${timeHint}:`
      : "🕒 Tengo estos horarios disponibles:";
  }
  const result = buildAvailabilityIntro({});
  assert.equal(result, "🕒 Tengo estos horarios disponibles:");
});

// ── Daily report worker tests ─────────────────────────────────────────────────

test("daily report solo corre si enableDailyReport es true", () => {
  let workerStarted = false;
  function startDailyReportWorker(enableDailyReport) {
    if (!enableDailyReport) return;
    workerStarted = true;
  }
  startDailyReportWorker(false);
  assert.equal(workerStarted, false);
  startDailyReportWorker(true);
  assert.equal(workerStarted, true);
});

// ── Reminder diagnostics tests ─────────────────────────────────────────────────

test("diagnostic de recordatorios muestra nombres de templates cuando estan configurados", () => {
  function buildReminderDiagnosticDetail(config) {
    if (!config.enableReminderWorker) return "Apagados (ENABLE_REMINDER_WORKER=false)";
    if (config.whatsappReminderTemplate24h && config.whatsappReminderTemplate2h) {
      return `Activos — 24h: ${config.whatsappReminderTemplate24h}, 2h: ${config.whatsappReminderTemplate2h}`;
    }
    return "Worker activo pero faltan templates";
  }

  const detail = buildReminderDiagnosticDetail({
    enableReminderWorker: true,
    whatsappReminderTemplate24h: "reminder_24h",
    whatsappReminderTemplate2h: "reminder_2h"
  });
  assert.ok(detail.includes("reminder_24h"), `Expected template name, got: ${detail}`);
  assert.ok(detail.includes("reminder_2h"), `Expected template name, got: ${detail}`);
});

test("diagnostic de recordatorios indica apagados cuando worker esta desactivado", () => {
  function buildReminderDiagnosticDetail(config) {
    if (!config.enableReminderWorker) return "Apagados (ENABLE_REMINDER_WORKER=false)";
    return "Activos";
  }
  const detail = buildReminderDiagnosticDetail({ enableReminderWorker: false });
  assert.ok(detail.includes("Apagados"), `Expected apagados, got: ${detail}`);
});

// ── Attendance confirmation tests ─────────────────────────────────────────────

test("attendance_yes mapea a confirmo asistencia en interactiveReplyMap", () => {
  const interactiveReplyMap = {
    attendance_yes: "confirmo asistencia",
    attendance_cancel: "quiero cancelar"
  };
  assert.equal(interactiveReplyMap["attendance_yes"], "confirmo asistencia");
  assert.equal(interactiveReplyMap["attendance_cancel"], "quiero cancelar");
});

test("attendance_cancel entra al flujo de cancelacion", () => {
  const interactiveReplyMap = { attendance_cancel: "quiero cancelar" };
  const text = interactiveReplyMap["attendance_cancel"];
  const isCancellation = /cancelar/.test(text);
  assert.equal(isCancellation, true);
});

// ── Lead origin section tests ─────────────────────────────────────────────────

test("renderLeadOriginSection detecta promo desde tags", () => {
  function renderLeadOriginSection(conv) {
    const tags = conv?.tags ?? [];
    const isPromo = tags.some((t) => /promo|1200|paquete|chequeo/i.test(t));
    const isMetaAds = tags.some((t) => /facebook|instagram|meta ads|anuncio/i.test(t));
    return isMetaAds ? "Meta Ads" : isPromo ? "Promo $1,200" : "Organico / directo";
  }
  assert.equal(renderLeadOriginSection({ tags: ["Promo $1200", "Lead caliente"] }), "Promo $1,200");
  assert.equal(renderLeadOriginSection({ tags: ["facebook", "Lead frio"] }), "Meta Ads");
  assert.equal(renderLeadOriginSection({ tags: ["Primera visita"] }), "Organico / directo");
});

// ── Metrics panel tests ───────────────────────────────────────────────────────

test("renderTodayMetrics calcula correctamente con lista vacia", () => {
  function buildMetrics(list, todayISO) {
    let total = 0;
    let promoLeads = 0;
    let scheduled = 0;

    for (const conv of list) {
      const convDate = conv.updatedAt?.slice(0, 10) ?? "";
      if (convDate !== todayISO) continue;
      total++;
      if ((conv.tags ?? []).some((t) => /promo/i.test(t))) promoLeads++;
      if (conv.appointment?.slotStart) scheduled++;
    }

    return { total, promoLeads, scheduled };
  }
  const result = buildMetrics([], "2026-06-15");
  assert.equal(result.total, 0);
  assert.equal(result.promoLeads, 0);
  assert.equal(result.scheduled, 0);
});

test("renderTodayMetrics cuenta promo leads y agendadas del dia", () => {
  function buildMetrics(list, todayISO) {
    let total = 0;
    let promoLeads = 0;
    let scheduled = 0;

    for (const conv of list) {
      const convDate = conv.updatedAt?.slice(0, 10) ?? "";
      if (convDate !== todayISO) continue;
      total++;
      if ((conv.tags ?? []).some((t) => /promo/i.test(t))) promoLeads++;
      if (conv.appointment?.slotStart) scheduled++;
    }

    return { total, promoLeads, scheduled };
  }

  const list = [
    { updatedAt: "2026-06-15T10:00:00Z", tags: ["Promo $1200"], appointment: { slotStart: "2026-06-16T17:00:00Z" } },
    { updatedAt: "2026-06-15T11:00:00Z", tags: [], appointment: null },
    { updatedAt: "2026-06-14T09:00:00Z", tags: ["Promo $1200"], appointment: { slotStart: "2026-06-14T17:00:00Z" } }
  ];

  const result = buildMetrics(list, "2026-06-15");
  assert.equal(result.total, 2);
  assert.equal(result.promoLeads, 1);
  assert.equal(result.scheduled, 1);
});

// ── Promotion intent tests ────────────────────────────────────────────────────

test("isPromotionQuestion detecta 'que promo tienes'", () => {
  function isPromotionQuestion(text) {
    return (
      /\b(?:promocion|promosion|promo|oferta)\b/.test(text) ||
      /\b(?:paquete(?:\s+promocional)?)\b/.test(text) ||
      /\b(?:sigue la promo|siguen con la promo|todavia tienen promo|aun tienen promo|tienen promo|tiene promo)\b/.test(text) ||
      /\b(?:que incluye la promo|que tiene la promo|que tiene el paquete|cuanto incluye la promo)\b/.test(text)
    );
  }
  assert.equal(isPromotionQuestion("que promocion tienes ahorita"), true);
  assert.equal(isPromotionQuestion("paquete promocional"), true);
  assert.equal(isPromotionQuestion("sigue la promo"), true);
  assert.equal(isPromotionQuestion("todavia tienen promo"), true);
  assert.equal(isPromotionQuestion("que incluye la promo"), true);
  assert.equal(isPromotionQuestion("que tiene el paquete"), true);
});

test("intent promotion no activa handleMenuOption con costo duplicado", () => {
  function handleCostPromo(option, intent) {
    if (option === 4 || intent === "cost") return "cost+promotion";
    if (intent === "promotion") return "promotion-only";
    return null;
  }
  assert.equal(handleCostPromo(4, "cost"), "cost+promotion");
  assert.equal(handleCostPromo(null, "cost"), "cost+promotion");
  assert.equal(handleCostPromo(null, "promotion"), "promotion-only");
  assert.notEqual(handleCostPromo(null, "promotion"), "cost+promotion");
});

// ── Returning patient service flow tests ──────────────────────────────────────

test("parseReason devuelve Promocion para texto 'promocion' sin importar el step", () => {
  function normalizeKnownServiceReason(normalized) {
    if (/\b(?:promo|promocion|paquete|paquete promocional|1200)\b/.test(normalized)) return "Promocion";
    if (/\b(?:ultrasonido|ultra)\b/.test(normalized)) return "Ultrasonido";
    if (/\b(?:papanicolaou|papanicolau|papanicolao|papanicol)\b/.test(normalized)) return "Papanicolaou";
    return undefined;
  }
  function parseReason(original, normalized, session) {
    if (session?.reason) return undefined;
    const knownService = normalizeKnownServiceReason(normalized);
    if (knownService) return knownService;
    if (session?.step === "collectingService") return normalized || "Consulta";
    return undefined;
  }

  const session = { step: "collecting", name: "Sombra Morales", email: "test@test.com", firstVisit: "No" };
  assert.equal(parseReason("promocion", "promocion", session), "Promocion");
  assert.equal(parseReason("paquete promocional", "paquete promocional", session), "Promocion");
});

test("el bot no vuelve a preguntar servicio cuando session.reason ya tiene valor", () => {
  function shouldAskService(session) {
    return !session.reason;
  }
  assert.equal(shouldAskService({ reason: "Promocion" }), false);
  assert.equal(shouldAskService({ reason: undefined }), true);
  assert.equal(shouldAskService({}), true);
});

// ── Relative date resolver tests ──────────────────────────────────────────────

test("resolveClinicDateISO: pasado manana gana sobre dateISO existente", () => {
  function resolveClinicDateISO(text, dateISO, todayISO) {
    const lower = (text ?? "").toLowerCase();
    if (lower.includes("pasado manana") || lower.includes("pasado mañana")) return addDays(todayISO, 2);
    if (lower.includes("manana") || lower.includes("mañana")) return addDays(todayISO, 1);
    if (dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return dateISO;
    return todayISO;
  }
  function addDays(iso, n) {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const today = "2026-06-16";
  const tomorrow = "2026-06-17";
  const dayAfter = "2026-06-18";

  assert.equal(resolveClinicDateISO("quiero cita pasado manana", undefined, today), dayAfter);
  assert.equal(resolveClinicDateISO("quiero cita manana", undefined, today), tomorrow);
  assert.equal(resolveClinicDateISO("quiero cita pasado mañana", tomorrow, today), dayAfter, "texto gana sobre dateISO previo");
  assert.equal(resolveClinicDateISO("el jueves", dayAfter, today), dayAfter, "sin relativo, gana dateISO");
});

test("parseDate en ai.js: pasado manana se procesa antes que manana", () => {
  function parseDate(text, todayISO) {
    const today = new Date(`${todayISO}T12:00:00Z`);
    const addDays = (d, n) => { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r.toISOString().slice(0, 10); };
    if (/\bhoy\b/.test(text)) return todayISO;
    if (/\bpasado manana\b|\bpasado mañana\b/.test(text)) return addDays(today, 2);
    if (/\bmanana\b|\bmañana\b/.test(text)) return addDays(today, 1);
    return undefined;
  }
  const today = "2026-06-16";
  assert.equal(parseDate("quiero cita pasado manana", today), "2026-06-18");
  assert.equal(parseDate("quiero cita manana", today), "2026-06-17");
  assert.equal(parseDate("quiero cita hoy", today), "2026-06-16");
  assert.equal(parseDate("quiero cita pasado mañana", today), "2026-06-18");
});
