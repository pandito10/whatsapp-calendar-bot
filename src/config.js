import fs from "node:fs";
import path from "node:path";

loadDotEnv();

// ALLOW_UNSIGNED_WEBHOOKS=false is the secure default.
// Unsigned webhooks are only accepted when ALLOW_UNSIGNED_WEBHOOKS=true is
// explicitly set. If the variable is absent or any other value, it is false.
const allowUnsignedWebhooks = process.env.ALLOW_UNSIGNED_WEBHOOKS === "true";
const defaultGoogleCalendarId = "ginecologiaintegralgto@gmail.com";
const defaultGoogleCalendarLabel = "agenda de citas DRA. CARRANZA";
const legacyGoogleCalendarIds = new Set([
    "b96c51c36ae4dc56e6618c6da02e4002a1810aacabf241a63380d58821f4c620@group.calendar.google.com",
    "primary"
]);
const legacyGoogleCalendarLabels = new Set(["calendario azul GINECOLOGIA INTEGRAL"]);
const defaultGoogleBusyCalendarIds = [defaultGoogleCalendarId];
const rawGoogleCalendarId = String(process.env.GOOGLE_CALENDAR_ID ?? "").trim();
const googleCalendarId = normalizeGoogleCalendarId(rawGoogleCalendarId);
const googleCalendarIdConfigured = Boolean(rawGoogleCalendarId) && googleCalendarId === rawGoogleCalendarId;

const required = [
    "WHATSAPP_VERIFY_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "DOCTOR_WHATSAPP_NUMBER"
  ];

for (const key of required) {
    if (!process.env[key]) {
          throw new Error(`Missing required env var: ${key}`);
    }
}

if (!process.env.WHATSAPP_ACCESS_TOKEN && !process.env.WHATSAPP_TOKEN) {
    throw new Error("Missing required env var: WHATSAPP_ACCESS_TOKEN or WHATSAPP_TOKEN");
}

export const config = {
    nodeEnv: process.env.NODE_ENV ?? "development",
    port: Number(process.env.PORT ?? 3000),
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? process.env.WHATSAPP_TOKEN,
    whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    whatsappBusinessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    whatsappDisplayPhoneNumber: process.env.WHATSAPP_DISPLAY_PHONE_NUMBER,
    whatsappAppSecret: process.env.WHATSAPP_APP_SECRET,
    whatsappTemplateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "es_MX",
    whatsappReminderTemplate24h: process.env.WHATSAPP_REMINDER_TEMPLATE_24H,
    whatsappReminderTemplate2h: process.env.WHATSAPP_REMINDER_TEMPLATE_2H,
    webhookPathSecret: process.env.WEBHOOK_PATH_SECRET,
    requireWebhookSignature: process.env.REQUIRE_WEBHOOK_SIGNATURE !== "false",
    allowUnsignedWebhooks: allowUnsignedWebhooks,
    unsignedWebhookExpiresAt: allowUnsignedWebhooks ? process.env.UNSIGNED_WEBHOOK_EXPIRES_AT : undefined,
    doctorWhatsappNumber: process.env.DOCTOR_WHATSAPP_NUMBER,
    inboxPassword: process.env.INBOX_PASSWORD,
    inboxPasswordHash: process.env.INBOX_PASSWORD_HASH,
    cookieSecret: process.env.COOKIE_SECRET,
    inboxSessionHours: Number(process.env.INBOX_SESSION_HOURS ?? 8),
    maxRequestBytes: Number(process.env.MAX_REQUEST_BYTES ?? 128_000),
    inboxMediaMaxBytes: Number(process.env.INBOX_MEDIA_MAX_BYTES ?? 16_000_000),
    webhookRateLimitPerMinute: Number(process.env.WEBHOOK_RATE_LIMIT_PER_MINUTE ?? 120),
    webhookPhoneRateLimitPerMinute: Number(process.env.WEBHOOK_PHONE_RATE_LIMIT_PER_MINUTE ?? 10),
    inboxRateLimitPerMinute: Number(process.env.INBOX_RATE_LIMIT_PER_MINUTE ?? 60),
    inboxSendRateLimitPerMinute: Number(process.env.INBOX_SEND_RATE_LIMIT_PER_MINUTE ?? 20),
    inboxActionRateLimitPerMinute: Number(process.env.INBOX_ACTION_RATE_LIMIT_PER_MINUTE ?? 30),
    inboxLoginRateLimitPer15Minutes: Number(process.env.INBOX_LOGIN_RATE_LIMIT_PER_15_MINUTES ?? 5),
    inboxAllowLegacyTokenAccess: process.env.INBOX_ALLOW_LEGACY_TOKEN_ACCESS === "true",
    externalRequestTimeoutMs: Number(process.env.EXTERNAL_REQUEST_TIMEOUT_MS ?? 8000),
    externalRequestRetries: Number(process.env.EXTERNAL_REQUEST_RETRIES ?? 2),
    botPauseTimeoutMinutes: Number(process.env.BOT_PAUSE_TIMEOUT_MINUTES ?? 120),
    enableReminderWorker: process.env.ENABLE_REMINDER_WORKER === "true",
    enablePatientReminderTemplates: process.env.ENABLE_PATIENT_REMINDER_TEMPLATES === "true",
    emailOptional: process.env.EMAIL_OPTIONAL === "true",
    enableDailyReport: process.env.ENABLE_DAILY_REPORT === "true",
    dailyReportHour: Number(process.env.DAILY_REPORT_HOUR ?? 20),
    requireDatabaseForAppointments:
          process.env.REQUIRE_SUPABASE_FOR_APPOINTMENTS === "true" ||
          process.env.REQUIRE_DB_FOR_APPOINTMENTS === "true" ||
          process.env.NODE_ENV === "production",
    appointmentLockMinutes: Number(process.env.APPOINTMENT_LOCK_MINUTES ?? 10),
    reminderWorkerIntervalMs: Number(process.env.REMINDER_WORKER_INTERVAL_MS ?? 60_000),
    forwardConversationCopies: process.env.FORWARD_CONVERSATION_COPIES === "true",
    forwardConversationBodies: process.env.FORWARD_CONVERSATION_BODIES === "true",
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    googleCalendarId,
    googleCalendarLabel: normalizeGoogleCalendarLabel(process.env.GOOGLE_CALENDAR_LABEL),
    googleCalendarEventColorId: process.env.GOOGLE_CALENDAR_EVENT_COLOR_ID ?? "9",
    googleCalendarEventSummaryPrefix: process.env.GOOGLE_CALENDAR_EVENT_SUMMARY_PREFIX ?? "DRA. CARRANZA-",
    googleCalendarIdConfigured,
    googleBusyCalendarIds: parseGoogleBusyCalendarIds(process.env.GOOGLE_BUSY_CALENDAR_IDS, googleCalendarId, defaultGoogleBusyCalendarIds),
    googleRedirectUri:
          process.env.GOOGLE_REDIRECT_URI ??
          (process.env.PUBLIC_BASE_URL
                 ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/oauth/google/callback`
                 : "http://localhost:3000/oauth/google/callback"),
    aiProvider: normalizeAiProvider(process.env.AI_PROVIDER, process.env.GEMINI_API_KEY),
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite",
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    clinicTimezone: process.env.CLINIC_TIMEZONE ?? "America/Mexico_City",
    clinicName: process.env.CLINIC_NAME ?? "Consultorio Ginecologico",
    clinicAddress: process.env.CLINIC_ADDRESS ?? "",
    consultationPrice: process.env.CONSULTATION_PRICE ?? "1000",
    includeSensitiveAppointmentNotes: process.env.INCLUDE_SENSITIVE_APPOINTMENT_NOTES === "true",
    maskPatientPhoneInCalendar: process.env.MASK_PATIENT_PHONE_IN_CALENDAR !== "false",
    includePatientContactInCalendar:
          process.env.INCLUDE_PATIENT_CONTACT_IN_CALENDAR === "true" &&
          process.env.MASK_PATIENT_PHONE_IN_CALENDAR === "false",
    promotionPrice: process.env.PROMOTION_PRICE ?? "1200",
    appointmentMinutes: Number(process.env.APPOINTMENT_DURATION_MINUTES ?? process.env.APPOINTMENT_MINUTES ?? 40),
    appointmentBufferMinutes: Number(process.env.APPOINTMENT_BUFFER_MINUTES ?? 0),
    minAdvanceHours: Number(process.env.MIN_APPOINTMENT_ADVANCE_HOURS ?? 0),
    maxOfferedSlots: Number(process.env.MAX_OFFERED_SLOTS ?? 6),
    workDays: (process.env.CLINIC_WORK_DAYS ?? process.env.WORK_DAYS ?? "1,2,3,4,5").split(",").map((day) => Number(day.trim())),
    workStart: process.env.CLINIC_START_TIME ?? process.env.WORK_START ?? "16:40",
    workEnd: process.env.CLINIC_END_TIME ?? process.env.WORK_END ?? "20:00",
    sheetsEnabled: process.env.SHEETS_ENABLED === "true",
    googleSheetsId: process.env.GOOGLE_SHEETS_ID ?? "",
    googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? "",
    coldLeadFollowupEnabled: process.env.COLD_LEAD_FOLLOWUP_ENABLED === "true",
    coldLeadFollowupHours: Number(process.env.COLD_LEAD_FOLLOWUP_HOURS ?? 6)
};

validateStartupConfig();

function validateStartupConfig() {
    if (config.nodeEnv === "production") {
          if (config.requireWebhookSignature && !config.whatsappAppSecret && !config.allowUnsignedWebhooks) {
                throw new Error("WHATSAPP_APP_SECRET is required in production when REQUIRE_WEBHOOK_SIGNATURE=true");
          }
          if (config.requireDatabaseForAppointments && (!config.supabaseUrl || !config.supabaseServiceRoleKey)) {
                throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production when REQUIRE_DB_FOR_APPOINTMENTS=true");
          }
    }

    if (config.appointmentMinutes <= 0 || config.appointmentMinutes > 240) {
          throw new Error("APPOINTMENT_DURATION_MINUTES must be between 1 and 240");
    }

    if (config.appointmentBufferMinutes < 0 || config.appointmentBufferMinutes > 120) {
          throw new Error("APPOINTMENT_BUFFER_MINUTES must be between 0 and 120");
    }

    if (config.minAdvanceHours < 0 || config.minAdvanceHours > 720) {
          throw new Error("MIN_APPOINTMENT_ADVANCE_HOURS must be between 0 and 720");
    }

    if (config.maxOfferedSlots <= 0 || config.maxOfferedSlots > 20) {
          throw new Error("MAX_OFFERED_SLOTS must be between 1 and 20");
    }

    if (!Array.isArray(config.workDays) || config.workDays.length === 0 || config.workDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
          throw new Error("CLINIC_WORK_DAYS must contain weekday numbers from 0 to 6");
    }

    const start = parseMinutes(config.workStart, "CLINIC_START_TIME");
    const end = parseMinutes(config.workEnd, "CLINIC_END_TIME");
    if (start >= end) {
          throw new Error("CLINIC_START_TIME must be earlier than CLINIC_END_TIME");
    }

    if (config.externalRequestTimeoutMs < 1000 || config.externalRequestTimeoutMs > 30000) {
          throw new Error("EXTERNAL_REQUEST_TIMEOUT_MS must be between 1000 and 30000");
    }

    if (config.externalRequestRetries < 0 || config.externalRequestRetries > 5) {
          throw new Error("EXTERNAL_REQUEST_RETRIES must be between 0 and 5");
    }

    if (config.googleCalendarEventColorId && !/^(?:[1-9]|10|11)$/.test(config.googleCalendarEventColorId)) {
          throw new Error("GOOGLE_CALENDAR_EVENT_COLOR_ID must be a Google Calendar color id from 1 to 11");
    }

    validatePositiveInteger(config.port, "PORT", 1, 65535);
    validatePositiveInteger(config.maxRequestBytes, "MAX_REQUEST_BYTES", 10_000, 2_000_000);
    validatePositiveInteger(config.inboxMediaMaxBytes, "INBOX_MEDIA_MAX_BYTES", 100_000, 100_000_000);
    validatePositiveInteger(config.webhookRateLimitPerMinute, "WEBHOOK_RATE_LIMIT_PER_MINUTE", 1, 10_000);
    validatePositiveInteger(config.webhookPhoneRateLimitPerMinute, "WEBHOOK_PHONE_RATE_LIMIT_PER_MINUTE", 1, 1_000);
    validatePositiveInteger(config.inboxRateLimitPerMinute, "INBOX_RATE_LIMIT_PER_MINUTE", 1, 10_000);
    validatePositiveInteger(config.inboxSendRateLimitPerMinute, "INBOX_SEND_RATE_LIMIT_PER_MINUTE", 1, 1_000);
    validatePositiveInteger(config.inboxActionRateLimitPerMinute, "INBOX_ACTION_RATE_LIMIT_PER_MINUTE", 1, 1_000);
    validatePositiveInteger(config.inboxLoginRateLimitPer15Minutes, "INBOX_LOGIN_RATE_LIMIT_PER_15_MINUTES", 1, 100);
    validatePositiveInteger(config.inboxSessionHours, "INBOX_SESSION_HOURS", 1, 168);
    validatePositiveInteger(config.appointmentLockMinutes, "APPOINTMENT_LOCK_MINUTES", 1, 60);
    validatePositiveInteger(config.reminderWorkerIntervalMs, "REMINDER_WORKER_INTERVAL_MS", 10_000, 3_600_000);

    if (!/^\d{10,15}$/.test(String(config.doctorWhatsappNumber ?? "").replace(/\D/g, ""))) {
          throw new Error("DOCTOR_WHATSAPP_NUMBER must be a WhatsApp phone number with country code");
    }

    if (config.nodeEnv === "production" && config.forwardConversationCopies && config.forwardConversationBodies) {
          throw new Error("FORWARD_CONVERSATION_BODIES=true is not allowed in production because it can leak patient data");
    }
}

function validatePositiveInteger(value, key, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
          throw new Error(`${key} must be an integer between ${min} and ${max}`);
    }
}

function parseMinutes(value, key) {
    if (!/^\d{2}:\d{2}$/.test(String(value))) {
          throw new Error(`${key} must use HH:mm format`);
    }
    const [hour, minute] = String(value).split(":").map(Number);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
          throw new Error(`${key} must be a valid time`);
    }
    return hour * 60 + minute;
}

function normalizeAiProvider(value, geminiApiKey) {
    const provider = String(value ?? "").trim().toLowerCase();
    if (!provider || ["local", "off", "none", "false", "disabled"].includes(provider)) return "local";
    if (["gemini", "openai"].includes(provider)) return provider;
    return geminiApiKey ? "gemini" : "local";
}

function parseGoogleBusyCalendarIds(value, eventCalendarId, defaultBusyCalendarIds = [eventCalendarId]) {
    const configuredIds = String(value ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean)
          .map(normalizeGoogleCalendarId);
    if (configuredIds.length > 0) return [...new Set(configuredIds)];

    return [...new Set(defaultBusyCalendarIds.filter(Boolean))];
}

function normalizeGoogleCalendarId(value) {
    const id = String(value ?? "").trim();
    if (!id || legacyGoogleCalendarIds.has(id)) return defaultGoogleCalendarId;
    return id;
}

function normalizeGoogleCalendarLabel(value) {
    const label = String(value ?? "").trim();
    if (!label || legacyGoogleCalendarLabels.has(label)) return defaultGoogleCalendarLabel;
    return label;
}

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
