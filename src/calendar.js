import { config } from "./config.js";
import { googleRequest } from "./google.js";

export async function findAvailableSlots(dateText, dateISO) {
  const target = parseDate(dateText, dateISO);
  const windows = buildWorkWindows(target);
  const freeSlots = [];

  for (const window of windows) {
    const busy = await googleRequest("/calendar/v3/freeBusy", {
      method: "POST",
      body: JSON.stringify({
        timeMin: window.start.toISOString(),
        timeMax: window.end.toISOString(),
        timeZone: config.clinicTimezone,
        items: [{ id: config.googleCalendarId }]
      })
    }, { retry: true });

    const busyRanges = (busy.calendars?.[config.googleCalendarId]?.busy ?? []).map((range) => ({
      start: new Date(range.start),
      end: new Date(range.end)
    }));

    let cursor = new Date(window.start);
    while (cursor.getTime() + config.appointmentMinutes * 60_000 <= window.end.getTime()) {
      const slotEnd = new Date(cursor.getTime() + config.appointmentMinutes * 60_000);
      const overlaps = busyRanges.some((range) => cursor < range.end && slotEnd > range.start);
      if (!overlaps && cursor > new Date()) {
        freeSlots.push({
          start: cursor.toISOString(),
          end: slotEnd.toISOString(),
          label: formatSlot(cursor)
        });
      }
      cursor = new Date(cursor.getTime() + config.appointmentMinutes * 60_000);
    }
  }

  return freeSlots.slice(0, config.maxOfferedSlots);
}

export function isSlotWithinClinicRules(slot) {
  if (!slot?.start || !slot?.end) return false;
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  if (start <= new Date()) return false;
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

export async function isSlotAvailable(slot) {
  const busy = await googleRequest("/calendar/v3/freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin: slot.start,
      timeMax: slot.end,
      timeZone: config.clinicTimezone,
      items: [{ id: config.googleCalendarId }]
    })
  }, { retry: true });

  const busyRanges = busy.calendars?.[config.googleCalendarId]?.busy ?? [];
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
    summary: `Cita ginecologia - ${sanitizeCalendarText(patient.name || "Paciente")}`,
    description: buildPatientDetails(patient),
    location: config.clinicAddress,
    start: { dateTime: slot.start, timeZone: config.clinicTimezone },
    end: { dateTime: slot.end, timeZone: config.clinicTimezone },
    attendees
  };
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

function buildWorkWindows(startDate) {
  const windows = [];
  const date = new Date(startDate);

  for (let i = 0; windows.length < 5 && i < 14; i += 1) {
    const day = date.getDay();
    if (config.workDays.includes(day)) {
      windows.push({
        start: withTime(date, config.workStart),
        end: withTime(date, config.workEnd)
      });
    }
    date.setDate(date.getDate() + 1);
  }

  return windows;
}

function withTime(date, hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return zonedDateTimeToDate(date.getFullYear(), date.getMonth() + 1, date.getDate(), hours, minutes);
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

function parseDate(text, dateISO) {
  if (dateISO && /^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    return new Date(`${dateISO}T12:00:00`);
  }

  const lower = (text ?? "").toLowerCase();
  const date = new Date();
  if (lower.includes("pasado manana") || lower.includes("pasado mañana")) {
    date.setDate(date.getDate() + 2);
    return date;
  }
  if (lower.includes("manana") || lower.includes("mañana")) {
    date.setDate(date.getDate() + 1);
    return date;
  }
  return date;
}

function getZonedWeekday(date) {
  const shortDay = new Intl.DateTimeFormat("en-US", {
    timeZone: config.clinicTimezone,
    weekday: "short"
  }).format(date);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[shortDay] ?? date.getDay();
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
