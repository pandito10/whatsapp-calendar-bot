import { config } from "./config.js";

export function assessProductionReadiness({ dbOk = false } = {}) {
  const checks = [
    readinessCheck("webhook_signature", Boolean(config.whatsappAppSecret && config.requireWebhookSignature && !config.allowUnsignedWebhooks), "Meta signature must be required"),
    readinessCheck("webhook_path_secret", Boolean(config.webhookPathSecret && config.webhookPathSecret.length >= 24), "Use a long WEBHOOK_PATH_SECRET"),
    readinessCheck("inbox_auth", Boolean((config.inboxPassword || config.inboxPasswordHash) && config.cookieSecret && config.cookieSecret.length >= 32), "Inbox must use password/hash and strong COOKIE_SECRET"),
    readinessCheck("legacy_inbox_disabled", !config.inboxAllowLegacyTokenAccess, "Legacy token access must stay disabled"),
    readinessCheck("database_required", Boolean(config.requireDatabaseForAppointments && dbOk), "Supabase must be available when confirming appointments"),
    readinessCheck("google_calendar_config", Boolean(config.googleClientId && config.googleClientSecret && config.googleRefreshToken && config.googleCalendarId), "Google Calendar credentials must be configured"),
    readinessCheck("patient_privacy", !config.includeSensitiveAppointmentNotes && !config.forwardConversationBodies, "Do not forward/store sensitive appointment notes by default"),
    readinessCheck("calendar_minimization", !config.includePatientContactInCalendar, "Keep patient contact minimized in Google Calendar unless the client explicitly needs it")
  ];

  const passed = checks.filter((check) => check.ok).length;
  const score = Math.round((passed / checks.length) * 100);
  const blocking = checks.filter((check) => !check.ok).map((check) => check.id);

  return {
    score,
    status: blocking.length === 0 ? "ready" : score >= 75 ? "almost-ready" : "not-ready",
    checks,
    blocking
  };
}

function readinessCheck(id, ok, recommendation) {
  return { id, ok: Boolean(ok), recommendation: ok ? undefined : recommendation };
}
