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
  return `✅ Listo, ${safeName}. Tu cita quedo agendada para ${slot.label}.${config.clinicAddress ? `\n\n📍 Ubicacion: ${config.clinicAddress}` : ""}${email ? "\n\n📩 Google Calendar tambien enviara la confirmacion a tu correo." : ""}\n\n⚠️ Si tienes dolor intenso, sangrado abundante o una urgencia, por favor acude a urgencias o contacta directamente al consultorio.`;
}

export function buildAppointmentReviewMessage({ name, slot, email, firstVisit, paymentType }) {
  const lines = [
    "Antes de confirmar, revisa que todo este correcto 😊",
    "",
    `👤 Paciente: ${sanitizeShortText(name || "Paciente", 80)}`,
    `📅 Fecha y hora: ${slot.label}`,
    email ? `📩 Correo: ${sanitizeShortText(email, 120)}` : undefined,
    firstVisit ? `📝 Primera vez: ${sanitizeShortText(firstVisit, 40)}` : undefined,
    paymentType ? `💳 Tipo: ${sanitizeShortText(paymentType, 80)}` : undefined,
    config.clinicAddress ? `📍 Ubicacion: ${config.clinicAddress}` : undefined,
    "",
    "¿Confirmo esta cita?",
    "Responde SI para agendarla o NO para elegir otro horario."
  ];

  return lines.filter(Boolean).join("\n");
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

export function classifyAppointmentError(error) {
  const message = String(error?.message ?? error ?? "").toLowerCase();
  if (message.includes("database") || message.includes("supabase")) return "database";
  if (message.includes("google") || message.includes("calendar") || message.includes("oauth")) return "calendar";
  if (message.includes("lock") || message.includes("duplicate") || message.includes("409")) return "double_booking";
  if (message.includes("whatsapp")) return "whatsapp";
  return "unknown";
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
