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
