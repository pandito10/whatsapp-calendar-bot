import { findAvailableSlots } from "../src/calendar.js";

const dateText = process.argv.slice(2).join(" ") || "mañana";
const slots = await findAvailableSlots(dateText);

console.log(`Horarios disponibles para "${dateText}":`);
if (slots.length === 0) {
  console.log("Sin horarios disponibles.");
} else {
  for (const [index, slot] of slots.entries()) {
    console.log(`${index + 1}. ${slot.label}`);
  }
}
