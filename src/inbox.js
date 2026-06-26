import { normalizeText } from "./intents.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSING_WINDOW_MS = 22.5 * 60 * 60 * 1000;
const STUCK_FLOW_MS = 30 * 60 * 1000;

export function sanitizeInboxReportText(value, maxLength = 4000) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim()
    .slice(0, maxLength);
}

export function buildManualDailyReportEntry({ dateISO, title, body, author = "consultorio", generatedAt = new Date().toISOString() } = {}) {
  const fallbackDate = Number.isNaN(new Date(generatedAt).getTime())
    ? new Date().toISOString().slice(0, 10)
    : new Date(generatedAt).toISOString().slice(0, 10);
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(String(dateISO ?? "")) ? String(dateISO) : fallbackDate;
  const safeTitle = sanitizeInboxReportText(title, 120);
  const safeBody = sanitizeInboxReportText(body, 4000);
  if (!safeBody) {
    throw new Error("daily_report_body_required");
  }

  const header = safeTitle ? `Reporte manual - ${safeTitle}` : "Reporte manual";
  return {
    date: safeDate,
    title: safeTitle || "Reporte manual",
    text: `${header}\n\n${safeBody}`,
    body: safeBody,
    source: "manual",
    author: sanitizeInboxReportText(author, 80) || "consultorio",
    generatedAt
  };
}

export function getWhatsAppWindowState(conversation, nowMs = Date.now()) {
  const lastPatientMessage = getLastPatientMessage(conversation);
  if (!lastPatientMessage?.timestamp) {
    return { key: "unknown", label: "Sin mensaje reciente", className: "muted", hoursLeft: undefined };
  }

  const elapsedMs = nowMs - new Date(lastPatientMessage.timestamp).getTime();
  const hoursLeft = Math.max(0, Math.round(((DAY_MS - elapsedMs) / 60 / 60 / 1000) * 10) / 10);
  if (elapsedMs >= DAY_MS) {
    return { key: "expired", label: "Fuera de 24h: usa template Meta", className: "expired", hoursLeft: 0 };
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
  const urgentResolved = tags.has("urgente resuelto") || tags.has("urgencia resuelta");
  const caseResolved = tags.has("resuelto") || tags.has("caso resuelto") || tags.has("cerrado");
  const pendingUrgentText = last?.sender === "patient" && /urgente|emergencia|sangrado|dolor fuerte|dolor intenso|me siento muy mal|desmayo/.test(lastPatientText);
  const confirmedAppointment = hasConfirmedAppointment(conversation);

  if (tags.has("urgente") || (!urgentResolved && pendingUrgentText)) {
    return { key: "urgent", label: "Urgente", className: "urgent", priority: 1 };
  }

  if (caseResolved && last?.sender !== "patient") {
    return { key: "resolved", label: "Resuelto", className: "resolved", priority: 10 };
  }

  if (tags.has("resultados")) {
    return { key: "results", label: "Resultados pendientes", className: "human", priority: 3 };
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

  if (confirmedAppointment && isClosingInboxText(lastPatientText)) {
    return { key: "confirmed", label: "Cita agendada", className: "confirmed", priority: 8 };
  }

  if (confirmedAppointment && last?.sender !== "patient" && hasRecentFallback(conversation)) {
    return { key: "confirmed", label: "Cita agendada", className: "confirmed", priority: 8 };
  }

  if (tags.has("bot no entendio") || hasRecentFallback(conversation)) {
    return { key: "misunderstood", label: "Bot no entendio", className: "misunderstood", priority: 2 };
  }

  if (windowState.key === "closing") {
    return { key: "closing_window", label: "Ventana 24h por cerrar", className: "closing", priority: 5 };
  }

  if (windowState.key === "expired") {
    return { key: "expired_window", label: "Fuera de 24h", className: "expired", priority: 5 };
  }

  const flowStatus = getAppointmentFlowStatus(sessionStep, sessionData);
  if (flowStatus) {
    const waitingSince = last?.sender === "bot" && last.timestamp ? nowMs - new Date(last.timestamp).getTime() : 0;
    if (waitingSince >= STUCK_FLOW_MS) {
      return {
        key: "stuck",
        label: `Paciente atorada: ${flowStatus.shortLabel}`,
        className: "waiting",
        priority: 5
      };
    }
    return flowStatus;
  }

  if (last?.sender === "patient") {
    return { key: "followup", label: "Nuevo mensaje", className: "followup", priority: 6 };
  }

  if (confirmedAppointment) {
    return { key: "confirmed", label: "Cita agendada", className: "confirmed", priority: 8 };
  }

  return { key: "open", label: "En atencion", className: "open", priority: 9 };
}

export function sortInboxConversations(list, nowMs = Date.now(), options = {}) {
  if (options.newestPatientFirst) {
    return [...list].sort((a, b) => {
      const aLast = a?.messages?.at(-1);
      const bLast = b?.messages?.at(-1);
      const aIsPatient = aLast?.sender === "patient" ? 1 : 0;
      const bIsPatient = bLast?.sender === "patient" ? 1 : 0;
      if (aIsPatient !== bIsPatient) return bIsPatient - aIsPatient;

      const aPatientTime = getLastPatientMessageTime(a);
      const bPatientTime = getLastPatientMessageTime(b);
      if (aPatientTime !== bPatientTime) return bPatientTime - aPatientTime;

      return getConversationActivityTime(b) - getConversationActivityTime(a);
    });
  }

  return [...list].sort((a, b) => {
    const priorityDiff = getConversationStatus(a, nowMs).priority - getConversationStatus(b, nowMs).priority;
    if (priorityDiff !== 0) return priorityDiff;
    return getConversationActivityTime(b) - getConversationActivityTime(a);
  });
}

export function getConversationActivityTime(conversation) {
  const updatedAt = toTime(conversation?.updatedAt);
  const messageTimes = (conversation?.messages ?? []).map((message) => toTime(message?.timestamp));
  return Math.max(updatedAt, 0, ...messageTimes);
}

export function getConversationActivityISO(conversation) {
  const value = getConversationActivityTime(conversation);
  if (!value) return conversation?.updatedAt;
  return new Date(value).toISOString();
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
      (filter === "pending" && ["followup", "misunderstood", "awaiting_confirmation", "urgent", "results", "closing_window", "expired_window", "stuck"].includes(status.key)) ||
      (filter === "followup" && conversation.messages?.at(-1)?.sender === "patient") ||
      (filter === "waiting" && status.className === "waiting") ||
      (filter === "confirmed" && hasConfirmedAppointment(conversation)) ||
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
      if (hasConfirmedAppointment(conversation)) stats.confirmed += 1;
      if (["followup", "misunderstood", "awaiting_confirmation", "urgent", "closing_window", "expired_window", "stuck"].includes(status.key)) {
        stats.followup += 1;
      }
      if (status.key === "open") stats.open += 1;
      if (conversation.botPaused || status.key === "human") stats.human += 1;
      if (status.key === "urgent") stats.urgent += 1;
      if (conversation.messages?.at(-1)?.sender === "patient") stats.noReply += 1;
      if (status.key === "misunderstood") stats.misunderstood += 1;
      if (status.key === "closing_window" || status.key === "expired_window") stats.windowRisk += 1;
      if (status.key === "stuck") stats.stuck += 1;
      if (status.key === "resolved") stats.resolved += 1;
      return stats;
    },
    { total: 0, confirmed: 0, followup: 0, open: 0, human: 0, urgent: 0, noReply: 0, misunderstood: 0, windowRisk: 0, stuck: 0, resolved: 0 }
  );
}

export function buildReceptionChecklist(conversation, nowMs = Date.now()) {
  const status = getConversationStatus(conversation, nowMs);
  const profile = buildPatientCrmProfile(conversation, nowMs);
  const tags = normalizedTags(conversation);
  const messages = conversation?.messages ?? [];
  const appointment = conversation?.appointment;
  const sessionData = conversation?.session?.data ?? {};
  const offeredSlots = getOfferedSlots(conversation);
  const last = messages.at(-1);
  const lastPatientMessage = getLastPatientMessage(conversation);
  const patientName = profile.name ?? sessionData.name;
  const detectedEmail = profile.email ?? extractEmailFromMessages(messages) ?? sessionData.email;
  const requestedResults = tags.has("resultados") || tags.has("resultados pendientes") || /resultado|estudio|examen|papanicolaou|ultrasonido|colposcopia/i.test(lastPatientMessage?.body ?? "");
  const resultsSent = tags.has("resultados enviados") || tags.has("resultados resueltos") || tags.has("resuelto");
  const hasService =
    Boolean(profile.latestReason ?? appointment?.reason ?? sessionData.reason ?? sessionData.service) ||
    [...tags].some((tag) => /promo|consulta|ultrasonido|papanicolau|papanicolaou|colposcopia|control prenatal|revision/.test(tag));
  const hasDate =
    Boolean(appointment?.slotStart ?? sessionData.dateISO ?? sessionData.preferredDateText) ||
    offeredSlots.length > 0 ||
    Boolean(extractDateMention(lastPatientMessage?.body ?? ""));
  const isResponded = last?.sender !== "patient" || status.key === "resolved";
  const hasOutcome = Boolean(
    appointment?.status === "confirmed" ||
    status.key === "resolved" ||
    status.key === "results" ||
    conversation?.botPaused ||
    tags.has("humano requerido")
  );

  const items = [
    {
      key: "name",
      label: "Nombre",
      done: Boolean(patientName),
      detail: patientName ? `Detectado: ${patientName}` : "Pedir nombre completo."
    },
    {
      key: "phone",
      label: "Telefono",
      done: Boolean(profile.phoneNumber ?? conversation?.phoneNumber),
      detail: profile.phoneNumber ?? conversation?.phoneNumber ? "Listo para seguimiento." : "No hay telefono registrado."
    },
    {
      key: "email",
      label: "Correo",
      done: Boolean(detectedEmail),
      detail: detectedEmail ? `Confirmar si es necesario: ${maskEmailForReception(detectedEmail)}` : "Pedir correo confirmado para citas y archivos."
    },
    {
      key: "service",
      label: "Servicio",
      done: hasService,
      detail: hasService ? profile.latestReason ?? appointment?.reason ?? sessionData.reason ?? "Interes detectado." : "Aclarar si quiere promo, consulta, ultrasonido u otro motivo."
    },
    {
      key: "date",
      label: "Fecha/horario",
      done: hasDate,
      detail: appointment?.slotStart
        ? "Ya tiene cita registrada."
        : offeredSlots.length
          ? `${offeredSlots.length} horarios ofrecidos.`
          : hasDate
            ? "Fecha mencionada o flujo en progreso."
            : "Pedir dia u horario deseado."
    },
    {
      key: "reply",
      label: "Respuesta",
      done: isResponded,
      detail: isResponded ? "No hay mensaje entrante sin responder." : "La paciente escribio de ultimo; responder primero."
    },
    {
      key: "outcome",
      label: "Cierre",
      done: hasOutcome,
      detail: appointment?.status === "confirmed"
        ? "Cita confirmada."
        : status.key === "resolved"
          ? "Caso marcado como resuelto."
          : status.key === "results"
            ? "Solicitud de resultados en modo humano."
            : conversation?.botPaused
              ? "Modo humano activo."
              : "Aun falta agendar, resolver o pasar a humano."
    }
  ];

  if (requestedResults) {
    items.push({
      key: "results",
      label: "Resultados",
      done: Boolean(detectedEmail) && resultsSent,
      detail: !detectedEmail
        ? "Pedir correo confirmado antes de enviar archivos."
        : resultsSent
          ? "Solicitud de resultados atendida o cerrada."
          : "Enviar solo por correo confirmado o cerrar con humano."
    });
  }

  const completeCount = items.filter((item) => item.done).length;
  const nextMissing = items.find((item) => !item.done);
  return {
    items,
    completeCount,
    total: items.length,
    nextMissing,
    readyForReception: completeCount === items.length,
    status
  };
}

export function buildReceptionQueueSummary(list, nowMs = Date.now()) {
  const summary = {
    total: list.length,
    needsReply: 0,
    missingEmail: 0,
    readyToConfirm: 0,
    resultsPending: 0,
    stuck: 0,
    resolved: 0,
    nextTasks: []
  };

  const tasks = [];
  for (const conversation of list) {
    const status = getConversationStatus(conversation, nowMs);
    const checklist = buildReceptionChecklist(conversation, nowMs);
    const tags = normalizedTags(conversation);
    const emailItem = checklist.items.find((item) => item.key === "email");

    if (conversation?.messages?.at(-1)?.sender === "patient" && status.key !== "resolved") summary.needsReply += 1;
    if (emailItem && !emailItem.done && status.key !== "resolved") summary.missingEmail += 1;
    if (status.key === "awaiting_confirmation") summary.readyToConfirm += 1;
    if (status.key === "results" || tags.has("resultados") || tags.has("resultados pendientes")) summary.resultsPending += 1;
    if (status.key === "stuck") summary.stuck += 1;
    if (status.key === "resolved") summary.resolved += 1;

    if (checklist.nextMissing && status.key !== "resolved") {
      tasks.push({
        phoneNumber: conversation.phoneNumber,
        name: buildPatientCrmProfile(conversation, nowMs).name ?? extractNameFromMessages(conversation?.messages ?? []) ?? conversation.phoneNumber,
        status: status.label,
        nextLabel: checklist.nextMissing.label,
        nextDetail: checklist.nextMissing.detail,
        priority: status.priority,
        activity: getConversationActivityTime(conversation)
      });
    }
  }

  summary.nextTasks = tasks
    .sort((a, b) => a.priority - b.priority || b.activity - a.activity)
    .slice(0, 5);

  return summary;
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

export function buildCrmNextAction(conversation, nowMs = Date.now()) {
  if (!conversation) {
    return {
      key: "select",
      level: "info",
      title: "Selecciona una conversacion",
      detail: "Abre una paciente para ver mensajes, cita, notas y acciones sugeridas.",
      cta: "Ver pacientes"
    };
  }

  const status = getConversationStatus(conversation, nowMs);
  const windowState = getWhatsAppWindowState(conversation, nowMs);
  const profile = buildPatientCrmProfile(conversation, nowMs);
  const last = conversation?.messages?.at(-1);
  const tags = normalizedTags(conversation);

  if (status.key === "urgent") {
    return {
      key: "urgent",
      level: "danger",
      title: "Atender posible urgencia",
      detail: "Usa respuesta segura, no diagnostiques y marca como resuelto solo cuando una persona ya reviso el caso.",
      cta: "Marcar urgente resuelto"
    };
  }

  if (status.key === "results" || tags.has("resultados pendientes")) {
    return {
      key: "results_email",
      level: "danger",
      title: "Resultados: solo correo confirmado",
      detail: "Verifica identidad y correo. El archivo se envia por correo desde el inbox; no por WhatsApp.",
      cta: "Archivo al correo"
    };
  }

  if (windowState.key === "expired") {
    return {
      key: "template",
      level: "warning",
      title: "Fuera de 24h: usa plantilla Meta",
      detail: "No mandes texto libre si la paciente no ha escrito en las ultimas 24 horas.",
      cta: "Abrir plantillas"
    };
  }

  if (status.key === "misunderstood") {
    return {
      key: "misunderstood",
      level: "warning",
      title: "Bot no entendio",
      detail: "Responde con una plantilla rapida o convierte la pregunta en FAQ si aplica. Si toca tema medico sensible, pasalo a humano.",
      cta: "Revisar FAQ"
    };
  }

  if (status.key === "awaiting_confirmation") {
    return {
      key: "awaiting_confirmation",
      level: "info",
      title: "Falta confirmar la cita",
      detail: "La paciente debe confirmar antes de crear o modificar la cita. Si confirma por otro canal, revisa Calendar/Supabase antes de cerrar.",
      cta: "Leer chat"
    };
  }

  if (status.key === "reschedule") {
    return {
      key: "reschedule",
      level: "info",
      title: "Reagenda en proceso",
      detail: "Ofrece nuevos horarios y confirma antes de mover la cita. No dupliques la cita anterior.",
      cta: "Reenviar paso"
    };
  }

  if (status.key === "cancel") {
    return {
      key: "cancel",
      level: "warning",
      title: "Cancelacion pendiente",
      detail: "Cancela solo con confirmacion clara de la paciente y deja nota si requiere seguimiento.",
      cta: "Leer chat"
    };
  }

  if (status.className === "waiting") {
    return {
      key: "waiting",
      level: "info",
      title: `Pedir ${status.shortLabel ?? "dato faltante"}`,
      detail: "El flujo esta esperando una respuesta especifica. Reenvia el paso actual si la paciente se atoró.",
      cta: "Reenviar paso"
    };
  }

  if (last?.sender === "patient") {
    return {
      key: "reply",
      level: "info",
      title: "Responder mensaje nuevo",
      detail: "Lee el ultimo mensaje y usa una respuesta rapida si encaja. Si pide archivos/resultados, usa correo confirmado.",
      cta: "Leer chat"
    };
  }

  if (conversation?.botPaused) {
    return {
      key: "human",
      level: "warning",
      title: "Modo humano activo",
      detail: "El bot esta pausado para esta paciente. Devuelvelo al bot cuando ya no necesite atencion manual.",
      cta: "Devolver al bot"
    };
  }

  if (status.key === "resolved") {
    return {
      key: "resolved",
      level: "success",
      title: "Caso resuelto",
      detail: "La conversacion esta cerrada. Si la paciente vuelve a escribir, regresara automaticamente a pendientes.",
      cta: "Ver chat"
    };
  }

  if (conversation?.appointment?.status === "confirmed" || profile.nextAppointment) {
    return {
      key: "confirmed",
      level: "success",
      title: "Cita lista",
      detail: "La paciente ya tiene cita. Solo da seguimiento si escribe, necesita cambiar horario o pide resultados.",
      cta: "Ver cita"
    };
  }

  return {
    key: "followup",
    level: "info",
    title: "Dar seguimiento",
    detail: "Mantén la conversacion simple: agendar, costos, ubicacion, formas de pago o pasar a humano si es sensible.",
    cta: "Leer chat"
  };
}

export function getPatientTemperature(conversation, nowMs = Date.now()) {
  if (!conversation) return { key: "unknown", label: "Sin paciente", className: "muted" };

  const status = getConversationStatus(conversation, nowMs);
  const tags = normalizedTags(conversation);
  const last = conversation?.messages?.at(-1);

  if (
    status.priority <= 3 ||
    tags.has("lead caliente") ||
    tags.has("humano requerido") ||
    last?.sender === "patient"
  ) {
    return { key: "hot", label: "Lead caliente", className: "hot" };
  }

  if (tags.has("lead frio") || (conversation?.appointment?.status === "confirmed" && last?.sender !== "patient")) {
    return { key: "cold", label: "Lead frio", className: "cold" };
  }

  return { key: "warm", label: "Lead tibio", className: "warm" };
}

export function buildPatientCrmProfile(conversation, nowMs = Date.now()) {
  const persisted = conversation?.patient ?? {};
  const appointments = normalizeAppointments(conversation);
  const confirmed = appointments.filter((appointment) => appointment.status === "confirmed");
  const cancelled = appointments.filter((appointment) => appointment.status === "cancelled");
  const failed = appointments.filter((appointment) => appointment.status === "failed");
  const noShows = appointments.filter((appointment) => appointment.status === "no_show");
  const futureConfirmed = confirmed
    .filter((appointment) => toTime(appointment.slotStart) >= nowMs)
    .sort((a, b) => toTime(a.slotStart) - toTime(b.slotStart));
  const pastConfirmed = confirmed
    .filter((appointment) => toTime(appointment.slotStart) < nowMs)
    .sort((a, b) => toTime(b.slotStart) - toTime(a.slotStart));
  const lastConfirmed = pastConfirmed[0] ?? [...confirmed].sort((a, b) => toTime(b.slotStart) - toTime(a.slotStart))[0];
  const nextAppointment = futureConfirmed[0];
  const firstTouch = findFirstTouch(conversation, appointments);
  const lastPatientMessage = getLastPatientMessage(conversation);
  const appointmentCount = confirmed.length;
  const effectiveAppointmentCount = Math.max(appointmentCount, persisted.appointmentCount ?? 0);
  const effectiveCancelledCount = Math.max(cancelled.length, persisted.cancelledCount ?? 0);
  const effectiveFailedCount = Math.max(failed.length, persisted.failedCount ?? 0);
  const effectiveNoShowCount = Math.max(noShows.length, persisted.noShowCount ?? 0);
  const effectiveNextAppointment = nextAppointment ?? (persisted.nextAppointmentAt ? { slotStart: persisted.nextAppointmentAt } : undefined);
  const effectiveLastAppointment = lastConfirmed ?? (persisted.lastAppointmentAt ? { slotStart: persisted.lastAppointmentAt } : undefined);

  return {
    name: conversation?.appointment?.patientName ?? lastConfirmed?.patientName ?? persisted.name ?? extractNameFromMessages(conversation?.messages ?? []) ?? undefined,
    email: conversation?.appointment?.patientEmail ?? lastConfirmed?.patientEmail ?? persisted.email ?? undefined,
    phoneNumber: conversation?.phoneNumber ?? persisted.phoneNumber,
    firstTouch: firstTouch ?? persisted.firstSeenAt,
    lastPatientMessageAt: lastPatientMessage?.timestamp,
    messageCount: conversation?.messages?.length ?? 0,
    notesCount: Math.max(conversation?.notes?.length ?? 0, persisted.notesCount ?? 0),
    appointmentCount: effectiveAppointmentCount,
    cancelledCount: effectiveCancelledCount,
    failedCount: effectiveFailedCount,
    noShowCount: effectiveNoShowCount,
    nextAppointment: effectiveNextAppointment,
    lastAppointment: effectiveLastAppointment,
    latestReason: nextAppointment?.reason ?? lastConfirmed?.reason ?? conversation?.appointment?.reason ?? persisted.lastService,
    latestPaymentType: nextAppointment?.paymentType ?? lastConfirmed?.paymentType ?? conversation?.appointment?.paymentType ?? persisted.lastPaymentType,
    firstVisit: conversation?.appointment?.firstVisit ?? lastConfirmed?.firstVisit ?? persisted.firstVisit,
    patientStage: buildPatientStage({ appointmentCount: effectiveAppointmentCount, nextAppointment: effectiveNextAppointment, cancelledCount: effectiveCancelledCount, noShowCount: effectiveNoShowCount }),
    riskFlags: buildPatientRiskFlags(conversation, { appointmentCount: effectiveAppointmentCount, cancelledCount: effectiveCancelledCount, failedCount: effectiveFailedCount, noShowCount: effectiveNoShowCount })
  };
}

export function getOfferedSlots(conversation) {
  const slots = conversation?.session?.data?.offeredSlots ?? [];
  return Array.isArray(slots) ? slots.slice(0, 6) : [];
}

function normalizeAppointments(conversation) {
  const list = Array.isArray(conversation?.appointments) ? conversation.appointments : [];
  if (list.length > 0) return list.filter(Boolean);
  return conversation?.appointment ? [conversation.appointment] : [];
}

function hasConfirmedAppointment(conversation) {
  return normalizeAppointments(conversation).some((appointment) => appointment?.status === "confirmed") ||
    hasAppointmentConfirmationMessage(conversation);
}

function hasAppointmentConfirmationMessage(conversation) {
  const recentMessages = [...(conversation?.messages ?? [])].reverse();
  for (const message of recentMessages) {
    if (message?.sender !== "bot") continue;
    const body = normalizeText(message?.body ?? "");
    if (/\b(?:tu cita|cita)\s+(?:fue|ha sido|quedo|queda)?\s*(?:cancelada|cancelado)\b/.test(body)) {
      return false;
    }
    if (
      /\b(?:tu cita|cita)\s+(?:quedo|queda|fue)\s+(?:agendada|confirmada|registrada)\b/.test(body) ||
      /\blisto\b.*\btu cita\b.*\b(?:agendada|confirmada|registrada)\b/.test(body)
    ) {
      return true;
    }
  }
  return false;
}

function findFirstTouch(conversation, appointments) {
  const times = [
    conversation?.updatedAt,
    ...(conversation?.messages ?? []).map((message) => message.timestamp),
    ...appointments.map((appointment) => appointment.createdAt ?? appointment.slotStart)
  ]
    .map(toTime)
    .filter(Boolean);
  if (times.length === 0) return undefined;
  return new Date(Math.min(...times)).toISOString();
}

function buildPatientStage({ appointmentCount, nextAppointment, cancelledCount, noShowCount }) {
  if (nextAppointment) return "Con proxima cita";
  if (appointmentCount >= 2) return `Paciente recurrente (${appointmentCount} citas)`;
  if (appointmentCount === 1) return "Paciente con 1 cita";
  if (cancelledCount > 0 || noShowCount > 0) return "Paciente sin cita activa";
  return "Lead sin cita confirmada";
}

function buildPatientRiskFlags(conversation, counts) {
  const flags = [];
  const tags = normalizedTags(conversation);
  if (conversation?.botPaused) flags.push("Modo humano");
  if (tags.has("resultados")) flags.push("Resultados pendientes");
  if (tags.has("urgente")) flags.push("Urgente");
  if (tags.has("bot no entendio")) flags.push("Bot no entendio");
  if (counts.cancelledCount >= 2) flags.push("Varias cancelaciones");
  if (counts.failedCount > 0) flags.push("Citas fallidas para revisar");
  if (counts.noShowCount > 0) flags.push("No asistio antes");
  if (counts.appointmentCount === 0 && !hasAppointmentConfirmationMessage(conversation)) flags.push("Sin cita confirmada");
  return flags;
}

function normalizedTags(conversation) {
  return new Set([...(conversation?.tags ?? []), ...(conversation?.patient?.tags ?? [])].map((tag) => normalizeText(tag)));
}

function getAppointmentFlowStatus(sessionStep, sessionData = {}) {
  if (sessionStep === "collecting" && !sessionData.name) {
    return { key: "waiting_name", label: "Esperando nombre", shortLabel: "nombre", className: "waiting", priority: 6 };
  }
  if (sessionStep === "collectingEmail") {
    return { key: "waiting_email", label: "Esperando correo", shortLabel: "correo", className: "waiting", priority: 6 };
  }
  if (sessionStep === "collectingFirstVisit") {
    return { key: "waiting_first_visit", label: "Esperando primera vez", shortLabel: "primera vez", className: "waiting", priority: 6 };
  }
  if (sessionStep === "collectingService") {
    return { key: "waiting_service", label: "Esperando servicio", shortLabel: "servicio", className: "waiting", priority: 6 };
  }
  if (sessionStep === "collectingPaymentType") {
    return { key: "waiting_payment", label: "Esperando tipo de consulta", shortLabel: "tipo de consulta", className: "waiting", priority: 6 };
  }
  if (sessionStep === "collectingDateOnly" || (sessionStep === "collecting" && sessionData.name && !sessionData.preferredDateText)) {
    return { key: "waiting_date", label: "Esperando fecha", shortLabel: "fecha", className: "waiting", priority: 6 };
  }
  if (sessionStep === "choosingSlot" || sessionStep === "choosingAvailabilitySlot") {
    return { key: "waiting_slot", label: "Esperando horario", shortLabel: "horario", className: "waiting", priority: 6 };
  }
  if (sessionStep === "waitlistOffer") {
    return { key: "waiting_waitlist", label: "Esperando lista de espera", shortLabel: "lista de espera", className: "waiting", priority: 6 };
  }
  return undefined;
}

function hasRecentFallback(conversation) {
  return [...(conversation?.messages ?? [])]
    .slice(-5)
    .some((message) => message.sender === "bot" && /no entendi|no logre entender|preguntas no reconocidas/i.test(message.body ?? ""));
}

function isClosingInboxText(text) {
  const cleanText = String(text ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /^(?:gracias|muchas gracias|ok gracias|okay gracias|listo gracias|perfecto gracias|esta bien gracias|sale gracias|va gracias|ya gracias|gracias eso seria todo|eso es todo|listo|ok|okay|va|sale|perfecto|todo bien|esta bien|si esta bien|de acuerdo|entendido)$/.test(cleanText);
}

function getLastPatientMessage(conversation) {
  return [...(conversation?.messages ?? [])].reverse().find((message) => message.sender === "patient");
}

function getLastPatientMessageTime(conversation) {
  const timestamp = getLastPatientMessage(conversation)?.timestamp;
  return toTime(timestamp);
}

function toTime(value) {
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractDateMention(text) {
  const normalized = normalizeText(text);
  const match = normalized.match(/\b(?:hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}\s+de\s+[a-z]+)\b/);
  return match?.[0];
}

function extractEmailFromMessages(messages) {
  for (const message of [...(messages ?? [])].reverse()) {
    const match = String(message?.body ?? "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) return match[0];
  }
  return undefined;
}

function maskEmailForReception(email) {
  const value = String(email ?? "");
  const [user, domain] = value.split("@");
  if (!user || !domain) return value;
  return `${user.slice(0, 1)}***@${domain}`;
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
