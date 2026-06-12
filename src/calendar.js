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
    });

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

export async function isSlotAvailable(slot) {
  const busy = await googleRequest("/calendar/v3/freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin: slot.start,
      timeMax: slot.end,
      timeZone: config.clinicTimezone,
      items: [{ id: config.googleCalendarId }]
    })
  });

  const busyRanges = busy.calendars?.[config.googleCalendarId]?.busy ?? [];
  return busyRanges.length === 0;
}

export async function createAppointment(slot, patient) {
  const calendarId = encodeURIComponent(config.googleCalendarId);
  const details = buildPatientDetails(patient);
  const attendees = patient.email ? [{ email: patient.email }] : undefined;

  return googleRequest(`/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`, {
    method: "POST",
    body: JSON.stringify({
      summary: `Cita ginecologia - ${patient.name}`,
      description: details,
      location: config.clinicAddress,
      start: { dateTime: slot.start, timeZone: config.clinicTimezone },
      end: { dateTime: slot.end, timeZone: config.clinicTimezone },
      attendees
    })
  });
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
    `Paciente: ${patient.name}`,
    patient.phone ? `Telefono: ${patient.phone}` : undefined,
    patient.email ? `Correo: ${patient.email}` : undefined,
    patient.firstVisit ? `Primera vez: ${patient.firstVisit}` : undefined,
    patient.paymentType ? `Tipo de consulta: ${patient.paymentType}` : undefined,
    patient.reason ? `Motivo compartido: ${patient.reason}` : undefined
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
