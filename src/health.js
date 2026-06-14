import { config } from "./config.js";
import { assessProductionReadiness } from "./readiness.js";

export function buildOperationalHealth({ db, conversationCount = 0, memorySessionCount = 0, processedMessageCount = 0 } = {}) {
  const databaseOk = Boolean(db?.ok);
  const whatsappConfigured = Boolean(config.whatsappAccessToken && config.whatsappPhoneNumberId);
  const googleConfigured = Boolean(config.googleClientId && config.googleClientSecret && config.googleRefreshToken && config.googleCalendarId);
  const inboxProtected = Boolean((config.inboxPassword || config.inboxPasswordHash) && config.cookieSecret);
  const webhookSigned = Boolean(config.whatsappAppSecret && config.requireWebhookSignature && !config.allowUnsignedWebhooks);
  const production = config.nodeEnv === "production";

  const checks = {
    database: db?.status ?? "unknown",
    whatsapp: whatsappConfigured ? "configured" : "missing-config",
    google: googleConfigured ? "configured" : "missing-config",
    inbox: inboxProtected ? "protected" : "missing-auth-config",
    webhookSignature: webhookSigned ? "required" : config.allowUnsignedWebhooks ? "unsigned-temporary" : "blocked-missing-secret"
  };

  const problems = [];
  if (!whatsappConfigured) problems.push("whatsapp_missing_config");
  if (!googleConfigured) problems.push("google_missing_config");
  if (config.requireDatabaseForAppointments && !databaseOk) problems.push("database_required_unavailable");
  if (production && !webhookSigned) problems.push("webhook_signature_not_enforced");
  if (production && !inboxProtected) problems.push("inbox_not_protected");

  const readiness = assessProductionReadiness({ dbOk: databaseOk });

  return {
    app: problems.length === 0 ? "ok" : "degraded",
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    environment: config.nodeEnv,
    ready: readiness.ready,
    missing: readiness.missing,
    warnings: readiness.warnings,
    checks,
    counters: {
      conversationsInMemory: conversationCount,
      sessionsInMemory: memorySessionCount,
      processedMessagesInMemory: processedMessageCount
    },
    calendar: {
      label: config.googleCalendarLabel,
      id: config.googleCalendarId,
      busyCalendarIds: config.googleBusyCalendarIds,
      appointmentScheduleUrlConfigured: Boolean(config.googleAppointmentScheduleUrl),
      source: config.googleCalendarIdConfigured ? "env" : "default-calendario-azul",
      usingConfiguredCalendar: config.googleCalendarIdConfigured
    },
    readiness,
    problems
  };
}

export function isOperationallyUnhealthy(health) {
  const blockingProblems = new Set([
    "whatsapp_missing_config",
    "google_missing_config",
    "database_required_unavailable",
    "webhook_signature_not_enforced"
  ]);
  return Array.isArray(health?.problems) && health.problems.some((problem) => blockingProblems.has(problem));
}
