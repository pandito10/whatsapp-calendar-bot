import { understandMessage } from "../src/ai.js";

const message = process.argv.slice(2).join(" ") || "Hola, quiero una cita mañana en la tarde. Soy Ana Lopez.";
const parsed = await understandMessage(message);

console.log(JSON.stringify(parsed, null, 2));
