import { config } from "./config.js";

const relativeDateLabels = [
  { offset: 0, title: "Hoy" },
  { offset: 1, title: "Mañana" },
  { offset: 2, title: "Pasado mañana" }
];

export function buildDateOptionRows(now = new Date()) {
  const todayISO = clinicDateISO(now);
  const seen = new Set();
  const rows = [];

  for (const item of relativeDateLabels) {
    const dateISO = addDaysISO(todayISO, item.offset);
    if (!config.workDays.includes(weekdayFromISO(dateISO))) continue;
    rows.push(buildDateRow(dateISO, item.title));
    seen.add(dateISO);
  }

  let cursor = todayISO;
  for (let i = 0; rows.length < 8 && i < 21; i += 1) {
    cursor = addDaysISO(cursor, 1);
    if (seen.has(cursor)) continue;
    if (!config.workDays.includes(weekdayFromISO(cursor))) continue;
    rows.push(buildDateRow(cursor, formatShortDate(cursor)));
    seen.add(cursor);
  }

  return rows;
}

export function dateOptionReplyText(id) {
  const match = String(id ?? "").match(/^date_(\d{4}-\d{2}-\d{2})$/);
  if (!match) return undefined;
  return formatDateOptionText(match[1]);
}

export function formatDateOptionText(dateISO) {
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "full",
    timeZone: "UTC"
  }).format(new Date(`${dateISO}T12:00:00Z`));
}

function buildDateRow(dateISO, title) {
  return {
    id: `date_${dateISO}`,
    title: String(title).slice(0, 24),
    description: formatDateOptionText(dateISO)
  };
}

function clinicDateISO(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.clinicTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(now);
}

function addDaysISO(dateISO, days) {
  const date = new Date(`${dateISO}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekdayFromISO(dateISO) {
  return new Date(`${dateISO}T12:00:00Z`).getUTCDay();
}

function formatShortDate(dateISO) {
  return new Intl.DateTimeFormat("es-MX", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  })
    .format(new Date(`${dateISO}T12:00:00Z`))
    .replace(/\./g, "");
}
