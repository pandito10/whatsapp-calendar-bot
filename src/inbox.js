import { normalizeText } from "./intents.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSING_WINDOW_MS = 22.5 * 60 * 60 * 1000;

export function getWhatsAppWindowState(conversation, nowMs = Date.now()) {
  const lastPatientMessage = getLastPatientMessage(conversation);
  if (!lastPatientMessage?.timestamp) {
    return { key: "unknown", label: "Sin mensaje reciente", className: "muted", hoursLeft: undefined };
  }

  const elapsedMs = nowMs - new Date(lastPatientMessage.timestamp).getTime();
  const hoursLeft = Math.max(0, Math.round(((DAY_MS - elapsedMs) / 60 / 60 / 1000) * 10) / 10);
  if (elapsedMs >= DAY_MS) {
    return { key: "expired", label: "Requiere template Meta", className: "expired", hoursLeft: 0 };
  }
  if (elapsedMs >= CLOSING_WINDOW_MS) {
    return { key: "closing", label: `Ventana 24h por cerrar (${hoursLeft}h)`, className: "closing", hoursLeft };
  }
  return { key: "open", label: `Ventana abierta (${hoursLeft}h)`, className: "open", hoursLeft };
}

export function getConversationStatus(conversation, nowMs = Date.now()) {
  const tags = normalizedTags(conversation);
  const session = conversation?.session ?? {};
  const sessionData = session.data ?? {};
  const sessionStep = session.step;
  const last = conversation?.messages?.at(-1);
  const lastPatientMessage = getLastPatientMessage(conversation);
  const lastPatientText = normalizeText(lastPatientMessage?.body ?? "");
  const windowState = getWhatsAppWindowState(conversation, nowMs);

  if (tags.has("urgente") || /urgente|emergencia|sangrado|dolor fuerte|dolor intenso|me siento muy mal|desmayo/.test(lastPatientText)) {
    return { key: "urgent", label: "Urgente", className: "urgent", priority: 1 };
  }

  if (tags.has("bot no entendio") || hasRecentFallback(conversation)) {
    return { key: "misunderstood", label: "Bot no entendio", className: "misunderstood", priority: 2 };
  }

  if (conversation?.botPaused) {
    return { key: "human", label: "Modo humano activo", className: "human", priority: 3 };
  }

  if (sessionStep === "confirmingAppointment") {
    return { key: "awaiting_confirmation", label: "Esperando confirmacion", className: "confirming", priority: 3 };
  }

  if (sessionStep === "confirmingReschedule" || tags.has("reagendar")) {
    return { key: "reschedule", label: "Reagendar", className: "reschedule", priority: 4 };
  }

  if (sessionStep === "confirmingCancellation" || tags.has("cancelar")) {
    return { key: "cancel", label: "Cancelar", className: "cancel", priority: 4 };
  }

  if (windowState.key === "closing") {
    return { key: "closing_window", label: "Ventana 24h por cerrar", className: "closing", priority: 5 };
  }

  if (windowState.key === "expired") {
    return { key: "expired_window", label: "Requiere template Meta", className: "expired", priority: 5 };
  }

  if (last?.sender === "patient") {
    return { key: "followup", label: "Nuevo mensaje", className: "followup", priority: 6 };
  }

  if (conversation?.appointment?.status === "confirmed") {
    return { key: "confirmed", label: "Cita agendada", className: "confirmed", priority: 8 };
  }

  if (sessionStep === "collecting" && !sessionData.name) {
    return { key: "waiting_name", label: "Esperando nombre", className: "waiting", priority: 6 };
  }

  if (sessionStep === "collectingDateOnly" || (sessionStep === "collecting" && sessionData.name && !sessionData.preferredDateText)) {
    return { key: "waiting_date", label: "Esperando fecha", className: "waiting", priority: 6 };
  }

  if (sessionStep === "choosingSlot" || sessionStep === "choosingAvailabilitySlot") {
    return { key: "wants_appointment", label: "Quiere cita", className: "open", priority: 6 };
  }

  return { key: "open", label: "En atencion", className: "open", priority: 9 };
}

export function sortInboxConversations(list, nowMs = Date.now()) {
  return [...list].sort((a, b) => {
    const priorityDiff = getConversationStatus(a, nowMs).priority - getConversationStatus(b, nowMs).priority;
    if (priorityDiff !== 0) return priorityDiff;
    return new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime();
  });
}

export function filterInboxConversations(list, query = "", filter = "all", nowMs = Date.now()) {
  const normalizedQuery = normalizeText(query);
  const numericQuery = normalizePhone(query);

  return list.filter((conversation) => {
    const status = getConversationStatus(conversation, nowMs);
    const haystack = normalizeText([
      conversation.phoneNumber,
      conversation.appointment?.patientName,
      conversation.appointment?.patientEmail,
      ...(conversation.tags ?? []),
      status.label,
      conversation.session?.step,
      conversation.messages?.at(-1)?.body
    ].filter(Boolean).join(" "));
    const phone = normalizePhone(conversation.phoneNumber);
    const matchesQuery = !normalizedQuery || haystack.includes(normalizedQuery) || (numericQuery && phone.includes(numericQuery));
    const matchesFilter =
      filter === "all" ||
      (filter === "priority" && status.priority <= 5) ||
      filter === status.key ||
      (filter === "pending" && ["followup", "misunderstood", "awaiting_confirmation", "urgent", "closing_window", "expired_window"].includes(status.key)) ||
      (filter === "followup" && conversation.messages?.at(-1)?.sender === "patient") ||
      (filter === "confirmed" && conversation.appointment?.status === "confirmed") ||
      (filter === "human" && conversation.botPaused) ||
      (filter === "no_appointment" && !conversation.appointment) ||
      (filter === "new_patient" && normalizeText(conversation.appointment?.firstVisit ?? "") === "si") ||
      (filter === "returning_patient" && normalizeText(conversation.appointment?.firstVisit ?? "") === "no");
    return matchesQuery && matchesFilter;
  });
}

export function buildInboxStats(list, nowMs = Date.now()) {
  return list.reduce(
    (stats, conversation) => {
      const status = getConversationStatus(conversation, nowMs);
      stats.total += 1;
      if (conversation.appointment?.status === "confirmed") stats.confirmed += 1;
      if (["followup", "misunderstood", "awaiting_confirmation", "urgent", "closing_window", "expired_window"].includes(status.key)) {
        stats.followup += 1;
      }
      if (status.key === "open") stats.open += 1;
      if (conversation.botPaused || status.key === "human") stats.human += 1;
      if (status.key === "urgent") stats.urgent += 1;
      if (conversation.messages?.at(-1)?.sender === "patient") stats.noReply += 1;
      if (status.key === "misunderstood") stats.misunderstood += 1;
      if (status.key === "closing_window" || status.key === "expired_window") stats.windowRisk += 1;
      return stats;
    },
    { total: 0, confirmed: 0, followup: 0, open: 0, human: 0, urgent: 0, noReply: 0, misunderstood: 0, windowRisk: 0 }
  );
}

export function buildLocalConversationSummary(conversation, nowMs = Date.now()) {
  const status = getConversationStatus(conversation, nowMs);
  const lastPatientMessage = getLastPatientMessage(conversation);
  const dateMention = extractDateMention(lastPatientMessage?.body ?? conversation?.messages?.at(-1)?.body ?? "");
  return {
    name: conversation?.appointment?.patientName ?? extractNameFromMessages(conversation?.messages ?? []) ?? "Sin nombre detectado",
    intent: status.label,
    dateMention: dateMention ?? "Sin fecha clara",
    lastPatientMessage: lastPatientMessage?.body ?? "Sin mensaje de paciente",
    appointmentStatus: conversation?.appointment?.status ?? "Sin cita confirmada",
    requiresHuman: Boolean(conversation?.botPaused || status.key === "urgent" || status.key === "misunderstood"),
    windowState: getWhatsAppWindowState(conversation, nowMs)
  };
}

export function getOfferedSlots(conversation) {
  const slots = conversation?.session?.data?.offeredSlots ?? [];
  return Array.isArray(slots) ? slots.slice(0, 6) : [];
}

function normalizedTags(conversation) {
  return new Set((conversation?.tags ?? []).map((tag) => normalizeText(tag)));
}

function hasRecentFallback(conversation) {
  return [...(conversation?.messages ?? [])]
    .slice(-5)
    .some((message) => message.sender === "bot" && /no entendi|no logre entender|preguntas no reconocidas/i.test(message.body ?? ""));
}

function getLastPatientMessage(conversation) {
  return [...(conversation?.messages ?? [])].reverse().find((message) => message.sender === "patient");
}

function extractDateMention(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/\b(?:hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}\s+de\s+[a-z]+)\b/);
  return match?.[0];
}

function extractNameFromMessages(messages) {
  const appointmentNotice = [...messages]
    .reverse()
    .find((message) => message.sender === "bot" && String(message.body ?? "").includes("Nueva cita por WhatsApp:"));
  const fromNotice = appointmentNotice?.body.match(/Paciente:\s*([^\n]+)/i)?.[1]?.trim();
  if (fromNotice) return fromNotice;

  const thanks = [...messages]
    .reverse()
    .find((message) => message.sender === "bot" && String(message.body ?? "").match(/Gracias,\s*([^.\n]+)/i));
  return thanks?.body.match(/Gracias,\s*([^.\n]+)/i)?.[1]?.trim();
}

function normalizePhone(value) {
  return String(value ?? "").replace(/\D/g, "");
}
