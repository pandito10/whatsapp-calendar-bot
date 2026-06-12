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
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
  whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN,
  whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  whatsappBusinessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
  whatsappDisplayPhoneNumber: process.env.WHATSAPP_DISPLAY_PHONE_NUMBER,
  whatsappAppSecret: process.env.WHATSAPP_APP_SECRET,
  webhookPathSecret: process.env.WEBHOOK_PATH_SECRET,
  requireWebhookSignature: process.env.REQUIRE_WEBHOOK_SIGNATURE !== "false",
  allowUnsignedWebhooks: process.env.ALLOW_UNSIGNED_WEBHOOKS === "true" || process.env.REQUIRE_WEBHOOK_SIGNATURE === "false",
  unsignedWebhookExpiresAt: process.env.UNSIGNED_WEBHOOK_EXPIRES_AT,
  doctorWhatsappNumber: process.env.DOCTOR_WHATSAPP_NUMBER,
  inboxPassword: process.env.INBOX_PASSWORD,
  inboxPasswordHash: process.env.INBOX_PASSWORD_HASH,
  cookieSecret: process.env.COOKIE_SECRET,
  inboxSessionHours: Number(process.env.INBOX_SESSION_HOURS ?? 8),
  maxRequestBytes: Number(process.env.MAX_REQUEST_BYTES ?? 256_000),
  webhookRateLimitPerMinute: Number(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE ?? 600),
  webhookPhoneRateLimitPerMinute: Number(process.env.WEBHOOK_PHONE_RATE_LIMIT_PER_MINUTE ?? 30),
  inboxRateLimitPerMinute: Number(process.env.INBOX_RATE_LIMIT_PER_MINUTE ?? 60),
  inboxSendRateLimitPerMinute: Number(process.env.INBOX_SEND_RATE_LIMIT_PER_MINUTE ?? 20),
  inboxLoginRateLimitPer15Minutes: Number(process.env.INBOX_LOGIN_RATE_LIMIT_PER_15_MINUTES ?? 5),
  enableReminderWorker: process.env.ENABLE_REMINDER_WORKER !== "false",
  reminderWorkerIntervalMs: Number(process.env.REMINDER_WORKER_INTERVAL_MS ?? 60_000),
  forwardConversationCopies: process.env.FORWARD_CONVERSATION_COPIES === "true",
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
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
  clinicAddress: process.env.CLINIC_ADDRESS ?? "",
  consultationPrice: process.env.CONSULTATION_PRICE ?? "1000",
  promotionPrice: process.env.PROMOTION_PRICE ?? "1200",
  appointmentMinutes: Number(process.env.APPOINTMENT_MINUTES ?? 40),
  maxOfferedSlots: Number(process.env.MAX_OFFERED_SLOTS ?? 6),
  workDays: (process.env.WORK_DAYS ?? "1,2,3,4,5").split(",").map((day) => Number(day.trim())),
  workStart: process.env.WORK_START ?? "16:40",
  workEnd: process.env.WORK_END ?? "20:00"
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
