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

  return freeSlots.slice(0, 3);
}

export async function createAppointment(slot, patientName, reason) {
  const calendarId = encodeURIComponent(config.googleCalendarId);
  return googleRequest(`/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    body: JSON.stringify({
      summary: `Cita ginecologia - ${patientName}`,
      description: reason ? `Motivo compartido por WhatsApp: ${reason}` : "Cita creada por WhatsApp",
      start: { dateTime: slot.start, timeZone: config.clinicTimezone },
      end: { dateTime: slot.end, timeZone: config.clinicTimezone }
    })
  });
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
  const copy = new Date(date);
  copy.setHours(hours, minutes, 0, 0);
  return copy;
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
