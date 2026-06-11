import fs from "node:fs";
import path from "node:path";

loadDotEnv();

const required = [
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "DOCTOR_WHATSAPP_NUMBER"
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required env var: ${key}`);
  }
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  doctorWhatsappNumber: process.env.DOCTOR_WHATSAPP_NUMBER,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID ?? "primary",
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI ??
    (process.env.PUBLIC_BASE_URL
      ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/google/callback`
      : "http://localhost:3000/oauth/google/callback"),
  aiProvider: process.env.AI_PROVIDER ?? (process.env.GEMINI_API_KEY ? "gemini" : "local"),
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite",
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  clinicTimezone: process.env.CLINIC_TIMEZONE ?? "America/Mexico_City",
  clinicName: process.env.CLINIC_NAME ?? "Consultorio Ginecologico",
  appointmentMinutes: Number(process.env.APPOINTMENT_MINUTES ?? 45),
  workDays: (process.env.WORK_DAYS ?? "1,2,3,4,5").split(",").map((day) => Number(day.trim())),
  workStart: process.env.WORK_START ?? "09:00",
  workEnd: process.env.WORK_END ?? "18:00"
};

export function requireEnv(keys, serviceName) {
  const missing = keys.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing ${serviceName} env vars: ${missing.join(", ")}`);
  }
}

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    const key = trimmed.slice(0, equals).trim();
    const value = trimmed.slice(equals + 1).trim();
    process.env[key] ??= value;
  }
}
