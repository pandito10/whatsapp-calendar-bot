import { config } from "./config.js";

export function buildSlotOptionRows(slots = []) {
  return slots.slice(0, 10).map((slot, index) => ({
    id: `slot_${index + 1}`,
    title: formatSlotTitle(slot, index + 1),
    description: String(slot.label ?? formatSlotDescription(slot)).slice(0, 72)
  }));
}

export function slotOptionReplyText(id) {
  const match = String(id ?? "").match(/^slot_(\d{1,2})$/);
  return match ? match[1] : undefined;
}

function formatSlotTitle(slot, index) {
  const date = new Date(slot.start);
  const day = new Intl.DateTimeFormat("es-MX", {
    weekday: "short",
    day: "numeric",
    timeZone: config.clinicTimezone
  }).format(date).replace(/\./g, "");
  const time = new Intl.DateTimeFormat("es-MX", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: config.clinicTimezone
  }).format(date).replace(/\s+/g, " ");

  return `${index}. ${day} ${time}`.slice(0, 24);
}

function formatSlotDescription(slot) {
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: config.clinicTimezone
  }).format(new Date(slot.start));
}
