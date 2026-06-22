import { normalizeText } from "./intents.js";

export function isExistingAppointmentAcknowledgement(value) {
  const text = normalizeText(value);
  return (
    /\b(?:ya\s+)?(?:tengo|tenia|tenemos)\s+(?:mi\s+|la\s+|una\s+)?cita\b/.test(text) ||
    /\b(?:mi\s+|la\s+)?cita\s+(?:ya\s+)?(?:quedo|esta|confirmada|agendada)\b/.test(text) ||
    /\b(?:ya\s+)?(?:quede|quedo|estoy)\s+agendad[oa]\b/.test(text) ||
    /\bya\s+esta\s+(?:mi\s+)?cita\b/.test(text)
  );
}

export function isExplicitAdditionalAppointmentRequest(value) {
  const text = normalizeText(value);
  return (
    /\bagendar\s+(?:otra|otro|nueva|nuevo)\b/.test(text) ||
    /\b(?:otra|otro|nueva|nuevo|segunda)\s+(?:cita|consulta|agenda)\b/.test(text)
  );
}

export function isUpcomingCita(cita, now = new Date()) {
  const rawDate = cita?.slotEnd ?? cita?.slotStart;
  const timestamp = rawDate ? new Date(rawDate).getTime() : 0;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return false;
  return timestamp >= now.getTime() - 15 * 60 * 1000;
}

export function mayNeedExistingAppointmentProtection(value, intent) {
  if (isExistingAppointmentAcknowledgement(value)) return true;
  if (intent === "schedule_appointment" || intent === "promo_schedule") {
    return !isExplicitAdditionalAppointmentRequest(value);
  }
  return false;
}

export function shouldProtectExistingAppointmentFromScheduling(value, intent, cita, now = new Date()) {
  if (!isUpcomingCita(cita, now)) return false;

  return mayNeedExistingAppointmentProtection(value, intent);
}
