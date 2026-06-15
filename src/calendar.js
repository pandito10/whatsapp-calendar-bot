import { config } from "./config.js";
import { googleRequest } from "./google.js";

export async function findAvailableSlots(dateText, dateISO) {
  const slots = [];
  for (const win of buildWorkWindows(resolveClinicDateISO(dateText, dateISO))) {
    const busy = collectBusyRanges(await googleRequest("/calendar/v3/freeBusy", {
      method: "POST",
      body: JSON.stringify({ timeMin: win.start.toISOString(), timeMax: win.end.toISOString(), timeZone: config.clinicTimezone, items: buildFreeBusyItems() })
    }, { retry: true }));
    const step = (config.appointmentMinutes + config.appointmentBufferMinutes) * 60_000;
    for (let start = new Date(win.start); start.getTime() + config.appointmentMinutes * 60_000 <= win.end.getTime(); start = new Date(start.getTime() + step)) {
      const end = new Date(start.getTime() + config.appointmentMinutes * 60_000);
      const bufferEnd = new Date(end.getTime() + config.appointmentBufferMinutes * 60_000);
      if (!busy.some((range) => start < range.end && bufferEnd > range.start) && isFutureWithAdvance(start)) {
        slots.push({ start: start.toISOString(), end: end.toISOString(), label: formatSlot(start) });
      }
    }
  }
  return slots.slice(0, config.maxOfferedSlots);
}

export function isSlotWithinClinicRules(slot) {
  if (!slot?.start || !slot?.end) return false;
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  if (!isFutureWithAdvance(start)) return false;
  if (end.getTime() - start.getTime() !== config.appointmentMinutes * 60_000) return false;
  if (!config.workDays.includes(getZonedWeekday(start))) return false;
  const s = getZonedParts(start);
  const e = getZonedParts(end);
  const [sh, sm] = config.workStart.split(":").map(Number);
  const [eh, em] = config.workEnd.split(":").map(Number);
  return s.hour * 60 + s.minute >= sh * 60 + sm && e.hour * 60 + e.minute <= eh * 60 + em;
}

export async function isSlotAvailable(slot) {
  const busy = await googleRequest("/calendar/v3/freeBusy", {
    method: "POST",
    body: JSON.stringify({ timeMin: slot.start, timeMax: slot.end, timeZone: config.clinicTimezone, items: buildFreeBusyItems() })
  }, { retry: true });
  return collectBusyRanges(busy).length === 0;
}

export async function createAppointment(slot, patient) {
  const calendarId = encodeURIComponent(config.googleCalendarId);
  return googleRequest(`/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`, {
    method: "POST",
    body: JSON.stringify(buildCalendarEventPayload(slot, patient))
  });
}

export function buildCalendarEventPayload(slot, patient) {
  return {
    summary: `${sanitizeCalendarText(config.googleCalendarEventSummaryPrefix || "DRA. CARRANZA-")} (${sanitizeCalendarText(patient.name || "Registro")})`.slice(0, 250),
    description: buildDetails(patient),
    location: config.clinicAddress,
    start: { dateTime: slot.start, timeZone: config.clinicTimezone },
    end: { dateTime: slot.end, timeZone: config.clinicTimezone },
    colorId: config.googleCalendarEventColorId || undefined,
    attendees: patient.email ? [{ email: patient.email }] : undefined
  };
}

export async function cancelAppointment(googleEventId) {
  if (!googleEventId) return;
  await googleRequest(`/calendar/v3/calendars/${encodeURIComponent(config.googleCalendarId)}/events/${encodeURIComponent(googleEventId)}?sendUpdates=all`, {
    method: "DELETE",
    ignoreNotFound: true
  });
}

export function resolveClinicDateISO(text, dateISO, now = new Date()) {
  const lower = String(text ?? "").toLowerCase();
  const today = getClinicTodayISO(now);
  if (lower.includes("pasado manana") || lower.includes("pasado mañana")) return addDaysISO(today, 2);
  if (lower.includes("manana") || lower.includes("mañana")) return addDaysISO(today, 1);
  if (dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return dateISO;
  return today;
}

export function isClinicWorkDateISO(dateISO) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateISO ?? "")) && config.workDays.includes(getWeekdayFromDateISO(dateISO));
}

function buildDetails(patient) {
  const lines = [
    "Created by WhatsApp",
    `Name: ${sanitizeCalendarText(patient.name || "Registro")}`,
    patient.phone ? `Phone: ${config.includePatientContactInCalendar ? sanitizePhoneForCalendar(patient.phone) : maskPhone(patient.phone)}` : undefined,
    patient.email && config.includePatientContactInCalendar ? `Email: ${sanitizeCalendarText(patient.email)}` : undefined,
    patient.firstVisit ? `First visit: ${sanitizeCalendarText(patient.firstVisit)}` : undefined,
    patient.paymentType ? `Type: ${sanitizeCalendarText(patient.paymentType)}` : undefined,
    config.includeSensitiveAppointmentNotes && patient.reason ? `Note: ${sanitizeCalendarText(patient.reason)}` : undefined
  ];
  return lines.filter(Boolean).join("\n");
}

function buildWorkWindows(dateISO) {
  const windows = [];
  for (let i = 0; windows.length < 5 && i < 14; i += 1, dateISO = addDaysISO(dateISO, 1)) {
    if (config.workDays.includes(getWeekdayFromDateISO(dateISO))) {
      const parts = splitDateISO(dateISO);
      windows.push({ start: withTime(parts, config.workStart), end: withTime(parts, config.workEnd) });
    }
  }
  return windows;
}

function withTime({ year, month, day }, hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  return zonedDateTimeToDate(year, month, day, hour, minute);
}

function buildFreeBusyItems() {
  return config.googleBusyCalendarIds.map((id) => ({ id }));
}

function collectBusyRanges(response) {
  const calendars = response?.calendars ?? {};
  return config.googleBusyCalendarIds.flatMap((calendarId) => {
    const calendar = calendars[calendarId];
    if (!calendar) throw new Error(`Missing freeBusy calendar: ${calendarId}`);
    if (Array.isArray(calendar.errors) && calendar.errors.length > 0) {
      throw new Error(`freeBusy error: ${calendar.errors.map((error) => error.reason || error.message || "unknown").join(", ")}`);
    }
    return (calendar.busy ?? []).map((range) => ({ start: new Date(range.start), end: new Date(range.end) }));
  });
}

function isFutureWithAdvance(date) {
  return date.getTime() >= Date.now() + config.minAdvanceHours * 60 * 60 * 1000;
}

function zonedDateTimeToDate(year, month, day, hour, minute) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const parts = getZonedParts(utcGuess);
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  return new Date(utcGuess.getTime() + wanted - actual);
}

function getZonedParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: config.clinicTimezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function formatSlot(date) {
  return new Intl.DateTimeFormat("es-MX", { dateStyle: "full", timeStyle: "short", timeZone: config.clinicTimezone }).format(date);
}

function getZonedWeekday(date) {
  const shortDay = new Intl.DateTimeFormat("en-US", { timeZone: config.clinicTimezone, weekday: "short" }).format(date);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[shortDay] ?? date.getDay();
}

function getClinicTodayISO(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.clinicTimezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function addDaysISO(dateISO, days) {
  const { year, month, day } = splitDateISO(dateISO);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function splitDateISO(dateISO) {
  const [year, month, day] = dateISO.split("-").map(Number);
  return { year, month, day };
}

function getWeekdayFromDateISO(dateISO) {
  const { year, month, day } = splitDateISO(dateISO);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0)).getUTCDay();
}

function sanitizePhoneForCalendar(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 15);
}

function maskPhone(value) {
  const phone = sanitizePhoneForCalendar(value);
  return phone.length <= 6 ? (phone ? "***" : "") : `${phone.slice(0, 5)}****${phone.slice(-3)}`;
}

function sanitizeCalendarText(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
}
