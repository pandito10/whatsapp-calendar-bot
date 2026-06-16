import { config } from "./config.js";
import { googleRequest } from "./google.js";

export async function findAvailableSlots(dateText, dateISO) {
  const target = resolveClinicDateISO(dateText, dateISO);
  const windows = buildWorkWindows(target);
  const freeSlots = [];

  for (const window of windows) {
    const busy = await googleRequest("/calendar/v3/freeBusy", {
      method: "POST",
      body: JSON.stringify({
        timeMin: window.start.toISOString(),
        timeMax: window.end.toISOString(),
        timeZone: config.clinicTimezone,
        items: buildFreeBusyItems()
      })
    }, { retry: true });

    const busyRanges = collectBusyRanges(busy);

    let cursor = new Date(window.start);
    const stepMinutes = config.appointmentMinutes + config.appointmentBufferMinutes;
    while (cursor.getTime() + config.appointmentMinutes * 60_000 <= window.end.getTime()) {
      const slotEnd = new Date(cursor.getTime() + config.appointmentMinutes * 60_000);
      const bufferEnd = new Date(slotEnd.getTime() + config.appointmentBufferMinutes * 60_000);
      const overlaps = busyRanges.some((range) => cursor < range.end && bufferEnd > range.start);
      if (!overlaps && isFutureWithAdvance(cursor)) {
        freeSlots.push({
          start: cursor.toISOString(),
          end: slotEnd.toISOString(),
          label: formatSlot(cursor)
        });
      }
      cursor = new Date(cursor.getTime() + stepMinutes * 60_000);
    }
  }

  return freeSlots.slice(0, config.maxOfferedSlots);
}

export function isSlotWithinClinicRules(slot) {
  if (!slot?.start || !slot?.end) return false;
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  if (!isFutureWithAdvance(start)) return false;
  if (end.getTime() - start.getTime() !== config.appointmentMinutes * 60_000) return false;

  const parts = getZonedParts(start);
  if (!config.workDays.includes(getZonedWeekday(start))) return false;

  const startMinutes = parts.hour * 60 + parts.minute;
  const endParts = getZonedParts(end);
  const endMinutes = endParts.hour * 60 + endParts.minute;
  const [workStartHour, workStartMinute] = config.workStart.split(":").map(Number);
  const [workEndHour, workEndMinute] = config.workEnd.split(":").map(Number);
  const workStartMinutes = workStartHour * 60 + workStartMinute;
  const workEndMinutes = workEndHour * 60 + workEndMinute;

  return startMinutes >= workStartMinutes && endMinutes <= workEndMinutes;
}

function isFutureWithAdvance(date) {
  return date.getTime() >= Date.now() + config.minAdvanceHours * 60 * 60 * 1000;
}

export async function isSlotAvailable(slot) {
  const busy = await googleRequest("/calendar/v3/freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin: slot.start,
      timeMax: slot.end,
      timeZone: config.clinicTimezone,
      items: buildFreeBusyItems()
    })
  }, { retry: true });

  const busyRanges = collectBusyRanges(busy);
  return busyRanges.length === 0;
}

export async function createAppointment(slot, patient) {
  const calendarId = encodeURIComponent(config.googleCalendarId);
  return googleRequest(`/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`, {
    method: "POST",
    body: JSON.stringify(buildCalendarEventPayload(slot, patient))
  });
}

export function buildCalendarEventPayload(slot, patient) {
  const attendees = patient.email ? [{ email: patient.email }] : undefined;
  return {
    summary: buildCalendarEventSummary(patient),
    description: buildPatientDetails(patient),
    location: config.clinicAddress,
    start: { dateTime: slot.start, timeZone: config.clinicTimezone },
    end: { dateTime: slot.end, timeZone: config.clinicTimezone },
    colorId: config.googleCalendarEventColorId || undefined,
    attendees
  };
}

function buildCalendarEventSummary(patient) {
  const prefix = sanitizeCalendarText(config.googleCalendarEventSummaryPrefix || "DRA. CARRANZA-");
  const name = sanitizeCalendarText(patient.name || "Paciente");
  return `${prefix} (${name})`.slice(0, 250);
}

export async function cancelAppointment(googleEventId) {
  if (!googleEventId) return;

  const calendarId = encodeURIComponent(config.googleCalendarId);
  const eventId = encodeURIComponent(googleEventId);
  await googleRequest(`/calendar/v3/calendars/${calendarId}/events/${eventId}?sendUpdates=all`, {
    method: "DELETE",
    ignoreNotFound: true
  });
}

function buildPatientDetails(patient) {
  return [
    "Cita creada por WhatsApp",
    `Paciente: ${sanitizeCalendarText(patient.name || "Paciente")}`,
    patient.phone ? `Telefono: ${config.includePatientContactInCalendar ? sanitizePhoneForCalendar(patient.phone) : maskPhone(patient.phone)}` : undefined,
    patient.email && config.includePatientContactInCalendar ? `Correo: ${sanitizeCalendarText(patient.email)}` : undefined,
    patient.firstVisit ? `Primera vez: ${patient.firstVisit}` : undefined,
    patient.paymentType ? `Tipo de consulta: ${patient.paymentType}` : undefined,
    config.includeSensitiveAppointmentNotes && patient.reason ? `Nota interna: ${sanitizeCalendarText(patient.reason)}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function buildWorkWindows(startDateISO) {
  const windows = [];
  let dateISO = startDateISO;

  for (let i = 0; windows.length < 5 && i < 14; i += 1) {
    const day = getWeekdayFromDateISO(dateISO);
    if (config.workDays.includes(day)) {
      const parts = splitDateISO(dateISO);
      windows.push({
        start: withTime(parts, config.workStart),
        end: withTime(parts, config.workEnd)
      });
    }
    dateISO = addDaysISO(dateISO, 1);
  }

  return windows;
}

function withTime(dateParts, hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return zonedDateTimeToDate(dateParts.year, dateParts.month, dateParts.day, hours, minutes);
}

function buildFreeBusyItems() {
  return config.googleBusyCalendarIds.map((id) => ({ id }));
}

function collectBusyRanges(freeBusyResponse) {
  const calendars = freeBusyResponse?.calendars ?? {};
  return config.googleBusyCalendarIds.flatMap((calendarId) => {
    const calendar = calendars[calendarId];
    if (!calendar) {
      throw new Error(`Google Calendar freeBusy did not return calendar: ${calendarId}`);
    }
    if (Array.isArray(calendar.errors) && calendar.errors.length > 0) {
      const reason = calendar.errors.map((error) => error.reason || error.message || "unknown").join(", ");
      throw new Error(`Google Calendar freeBusy error for calendar ${calendarId}: ${reason}`);
    }
    return (calendar.busy ?? []).map((range) => ({
      start: new Date(range.start),
      end: new Date(range.end)
    }));
  });
}

function zonedDateTimeToDate(year, month, day, hours, minutes) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));
  const zonedParts = getZonedParts(utcGuess);
  const wantedLocalTime = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  const actualLocalTime = Date.UTC(
    zonedParts.year,
    zonedParts.month - 1,
    zonedParts.day,
    zonedParts.hour,
    zonedParts.minute,
    0,
    0
  );

  return new Date(utcGuess.getTime() + wantedLocalTime - actualLocalTime);
}

function getZonedParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.clinicTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function formatSlot(date) {
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: config.clinicTimezone
  }).format(date);
}

export function resolveClinicDateISO(text, dateISO, now = new Date()) {
  const lower = (text ?? "").toLowerCase();
  const today = getClinicTodayISO(now);

  if (lower.includes("pasado manana") || lower.includes("pasado mañana")) {
    return addDaysISO(today, 2);
  }
  if (lower.includes("manana") || lower.includes("mañana")) {
    return addDaysISO(today, 1);
  }
  if (dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    return dateISO;
  }
  return today;
}

export function isClinicWorkDateISO(dateISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO ?? ""))) return false;
  return config.workDays.includes(getWeekdayFromDateISO(dateISO));
}

export function isBlockedDate(dateISO) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO ?? ""))) return false;
  if (config.blockedDates.includes(dateISO)) return true;
  for (const range of config.blockedDateRanges) {
    if (dateISO >= range.start && dateISO <= range.end) return true;
  }
  return false;
}

function getZonedWeekday(date) {
  const shortDay = new Intl.DateTimeFormat("en-US", {
    timeZone: config.clinicTimezone,
    weekday: "short"
  }).format(date);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[shortDay] ?? date.getDay();
}

function getClinicTodayISO(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.clinicTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

function addDaysISO(dateISO, days) {
  const { year, month, day } = splitDateISO(dateISO);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
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
  if (phone.length <= 6) return phone ? "***" : "";
  return `${phone.slice(0, 5)}****${phone.slice(-3)}`;
}

function sanitizeCalendarText(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}
