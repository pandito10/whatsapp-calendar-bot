import { config } from "./config.js";
import { isSlotWithinClinicRules } from "./calendar.js";

export const appointmentStatuses = Object.freeze({
  pending: "pending",
  confirmed: "confirmed",
  cancelled: "cancelled",
  failed: "failed",
  expired: "expired"
});

export function validateSlotSelection({ slot, session, selectedSlotIndex }) {
  if (!Number.isInteger(selectedSlotIndex) || selectedSlotIndex < 1) {
    return { ok: false, code: "invalid_selection", message: "Seleccion invalida" };
  }

  if (!slot) {
    return { ok: false, code: "slot_not_found", message: "Ese horario ya no esta en la lista" };
  }

  if (!session?.offeredSlots?.[selectedSlotIndex - 1]) {
    return { ok: false, code: "slot_not_offered", message: "Ese horario no fue ofrecido en esta sesion" };
  }

  if (!isSlotWithinClinicRules(slot)) {
    return { ok: false, code: "slot_outside_rules", message: "Ese horario ya no es valido" };
  }

  return { ok: true };
}

export function buildPatientConfirmationMessage({ name, slot, email }) {
  const safeName = sanitizeShortText(name || "Paciente", 80);
  return `✅ Listo, ${safeName}. Tu cita quedo agendada para ${slot.label}.${config.clinicAddress ? `\n\n📍 Ubicacion: ${config.clinicAddress}` : ""}${email ? "\n\n📩 Google Calendar tambien enviara la confirmacion a tu correo." : "\n\n📩 Te recomendamos guardar esta fecha en tu agenda."}\n\n⚠️ Si tienes dolor intenso, sangrado abundante o una urgencia, por favor acude a urgencias o contacta directamente al consultorio.`;
}

export function buildLocationMessage() {
  return config.clinicAddress
    ? `📍 Estamos ubicados en ${config.clinicAddress}.`
    : "Por ahora el consultorio compartira la ubicacion directamente.";
}

export function buildAppointmentReviewMessage({ name, slot, email, firstVisit, paymentType, reason }) {
  const displayService = reason && /promo|1200|paquete|chequeo/i.test(reason)
    ? "Chequeo ginecologico completo $1,200"
    : (reason ? sanitizeShortText(reason, 80) : undefined);

  const slotDate = slot?.label ?? "";
  const lines = [
    "Te confirmo los datos:",
    "",
    `👤 Nombre: ${sanitizeShortText(name || "Paciente", 80)}`,
    displayService ? `🩺 Servicio: ${displayService}` : undefined,
    `📅 ${slotDate}`,
    email ? `📩 Correo: ${sanitizeShortText(email, 120)}` : undefined,
    firstVisit ? `📝 Primera vez: ${sanitizeShortText(firstVisit, 40)}` : undefined,
    paymentType ? `💳 Tipo: ${sanitizeShortText(paymentType, 80)}` : undefined,
    config.clinicAddress ? `📍 ${config.clinicAddress}` : undefined,
    "",
    "¿Confirmo tu cita?"
  ];

  return lines.filter(Boolean).join("\n");
}

export function buildPatientReminderJobs({ phoneNumber, session, slot, slotStartMs }) {
  if (!config.enablePatientReminderTemplates) return [];

  const jobs = [];
  if (config.whatsappReminderTemplate24h) {
    jobs.push({
      phoneNumber,
      reminderType: "patient_24h",
      remindAt: new Date(slotStartMs - 24 * 60 * 60 * 1000),
      payload: {
        patientName: session.name,
        slotLabel: slot.label,
        slotStart: slot.start
      }
    });
  }

  if (config.whatsappReminderTemplate2h) {
    jobs.push({
      phoneNumber,
      reminderType: "patient_2h",
      remindAt: new Date(slotStartMs - 2 * 60 * 60 * 1000),
      payload: {
        patientName: session.name,
        slotLabel: slot.label,
        slotStart: slot.start
      }
    });
  }

  return jobs;
}

export function filterSlotsAgainstBusyRanges(slots, busyRanges) {
  if (!Array.isArray(slots) || slots.length === 0) return [];
  if (!Array.isArray(busyRanges) || busyRanges.length === 0) return slots;

  return slots.filter((slot) => {
    const slotStart = new Date(slot.start);
    const slotEnd = new Date(slot.end);
    if (Number.isNaN(slotStart.getTime()) || Number.isNaN(slotEnd.getTime())) return false;

    return !busyRanges.some((range) => {
      const busyStart = new Date(range.slotStart ?? range.start);
      const busyEnd = new Date(range.slotEnd ?? range.end);
      if (Number.isNaN(busyStart.getTime()) || Number.isNaN(busyEnd.getTime())) return false;
      return slotStart < busyEnd && slotEnd > busyStart;
    });
  });
}

export function buildAdminAppointmentNotification({ name, from, slot, session }) {
  const lines = [
    "📅 Nueva cita por WhatsApp:",
    `Paciente: ${sanitizeShortText(name || "Paciente", 80)}`,
    `Fecha: ${slot.label}`,
    `Telefono: ${maskPhone(from)}`
  ];

  if (session?.email) lines.push(`Correo: ${sanitizeShortText(session.email, 120)}`);
  if (session?.firstVisit) lines.push(`Primera vez: ${sanitizeShortText(session.firstVisit, 40)}`);
  if (session?.paymentType) lines.push(`Tipo: ${sanitizeShortText(session.paymentType, 80)}`);
  if (session?.reason) lines.push("Nota: paciente compartio un motivo; revisar conversacion en inbox.");
  return lines.join("\n");
}

export function buildManualReviewMessage() {
  return "No pude confirmar ese horario de forma automatica. Para no darte una cita falsa, el consultorio lo va a revisar manualmente y te confirma por aqui.";
}

export function buildAppointmentFailureMessage(failureType) {
  if (failureType === "double_booking") {
    return "😕 Ese horario se acaba de ocupar. Dime que dia te gustaria revisar y te paso nuevos horarios disponibles.";
  }

  return buildManualReviewMessage();
}

export function classifyAppointmentError(error) {
  const message = errorMessageChain(error).toLowerCase();
  if (
    message.includes("23505") ||
    message.includes("duplicate") ||
    message.includes("unique constraint") ||
    message.includes("409") ||
    message.includes("lock")
  ) {
    return "double_booking";
  }
  if (
    message.includes("pgrst204") ||
    message.includes("schema cache") ||
    (message.includes("could not find") && message.includes("column"))
  ) {
    return "database_schema";
  }
  if (message.includes("google") || message.includes("calendar") || message.includes("oauth")) return "calendar";
  if (message.includes("whatsapp")) return "whatsapp";
  if (message.includes("database") || message.includes("supabase")) return "database";
  return "unknown";
}

function errorMessageChain(error) {
  const messages = [];
  let current = error;
  while (current) {
    messages.push(String(current?.message ?? current));
    current = current?.cause;
  }
  return messages.join(" | ");
}

export function sanitizeShortText(value, maxLength = 120) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function maskPhone(value) {
  const phone = String(value ?? "").replace(/\D/g, "");
  if (phone.length <= 6) return phone ? "***" : "";
  return `${phone.slice(0, 5)}****${phone.slice(-3)}`;
}
