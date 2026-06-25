import { config } from "./config.js";
import { assessProductionReadiness } from "./readiness.js";
import { getLastReconciliationResult } from "./calendar.js";

export function buildOperationalHealth({ db, conversationCount = 0, memorySessionCount = 0, processedMessageCount = 0, webhookDiagnostics = null, whatsappSendDiagnostic = null, calendarReconciliation = getLastReconciliationResult() } = {}) {
  const databaseOk = Boolean(db?.ok);
  const whatsappConfigured = Boolean(config.whatsappAccessToken && config.whatsappPhoneNumberId);
  const googleConfigured = Boolean(config.googleClientId && config.googleClientSecret && config.googleRefreshToken && config.googleCalendarId);
  const inboxProtected = Boolean((config.inboxPassword || config.inboxPasswordHash) && config.cookieSecret);
  const webhookSigned = Boolean(config.whatsappAppSecret && config.requireWebhookSignature && !config.allowUnsignedWebhooks);
  const emailConfigured = Boolean(config.resendApiKey && config.resendFromEmail);
  const production = config.nodeEnv === "production";
  const googleAccessError = Boolean(calendarReconciliation?.result && calendarReconciliation.result.errors > 0);

  const checks = {
    database: db?.status ?? "unknown",
    whatsapp: whatsappConfigured ? "configured" : "missing-config",
    google: googleConfigured ? googleAccessError ? "error" : "configured" : "missing-config",
    email: emailConfigured ? "configured" : "missing-config",
    inbox: inboxProtected ? "protected" : "missing-auth-config",
    webhookSignature: webhookSigned ? "required" : config.allowUnsignedWebhooks ? "unsigned-temporary" : "blocked-missing-secret"
  };

  const problems = [];
  if (!whatsappConfigured) problems.push("whatsapp_missing_config");
  if (!googleConfigured) problems.push("google_missing_config");
  if (googleConfigured && googleAccessError) problems.push("google_calendar_access_error");
  if (config.requireDatabaseForAppointments && !databaseOk) problems.push("database_required_unavailable");
  if (production && !webhookSigned) problems.push("webhook_signature_not_enforced");
  if (production && !inboxProtected) problems.push("inbox_not_protected");

  const readiness = assessProductionReadiness({ dbOk: databaseOk });
  const reconciliation = calendarReconciliation;
  const warnings = [...readiness.warnings];
  if (googleAccessError) {
    warnings.push("Google Calendar access check is failing; reconnect GOOGLE_REFRESH_TOKEN");
  }
  const ready = readiness.ready && problems.length === 0;

  return {
    app: problems.length === 0 ? "ok" : "degraded",
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    environment: config.nodeEnv,
    ready,
    missing: readiness.missing,
    warnings,
    checks,
    counters: {
      conversationsInMemory: conversationCount,
      sessionsInMemory: memorySessionCount,
      processedMessagesInMemory: processedMessageCount
    },
    whatsapp: {
      configured: whatsappConfigured,
      phoneNumberId: maskIdentifier(config.whatsappPhoneNumberId),
      businessAccountId: maskIdentifier(config.whatsappBusinessAccountId),
      displayPhoneNumber: maskPhone(config.whatsappDisplayPhoneNumber),
      tokenSource: config.whatsappTokenSource,
      tokenVarsConfigured: config.whatsappTokenVarsConfigured,
      tokenConflict: config.whatsappTokenConflict,
      dryRun: config.whatsappSendDryRun,
      lastSend: whatsappSendDiagnostic
    },
    webhook: webhookDiagnostics,
    calendar: {
      label: config.googleCalendarLabel,
      id: config.googleCalendarId,
      busyCalendarIds: config.googleBusyCalendarIds,
      source: config.googleCalendarIdConfigured ? "env" : "default-agenda-dra-carranza",
      usingConfiguredCalendar: config.googleCalendarIdConfigured
    },
    email: {
      configured: emailConfigured,
      resendApiKeyConfigured: Boolean(config.resendApiKey),
      resendFromEmailConfigured: Boolean(config.resendFromEmail)
    },
    reconciliation: reconciliation.result
      ? {
          at: reconciliation.at,
          checked: reconciliation.result.checked,
          orphaned: reconciliation.result.orphaned,
          errors: reconciliation.result.errors,
          ok: reconciliation.result.errors === 0
        }
      : { ok: null, detail: "not yet run" },
    readiness: { ...readiness, ready, status: ready ? readiness.status : "degraded", warnings },
    problems
  };
}

function maskPhone(value) {
  const phone = String(value ?? "").replace(/\D/g, "");
  if (!phone) return "";
  if (phone.length <= 6) return "***";
  return `${phone.slice(0, 5)}****${phone.slice(-3)}`;
}

function maskIdentifier(value) {
  const id = String(value ?? "").trim();
  if (!id) return "";
  if (id.length <= 8) return "***";
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

export function isOperationallyUnhealthy(health) {
  const blockingProblems = new Set([
    "whatsapp_missing_config",
    "google_missing_config",
    "google_calendar_access_error",
    "database_required_unavailable",
    "webhook_signature_not_enforced"
  ]);
  return Array.isArray(health?.problems) && health.problems.some((problem) => blockingProblems.has(problem));
}
