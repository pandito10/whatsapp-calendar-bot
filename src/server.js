import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { readFile } from "node:fs/promises";
import { understandMessage, transcribeAudio } from "./ai.js";
import { mayNeedExistingAppointmentProtection, shouldProtectExistingAppointmentFromScheduling } from "./appointment-guard.js";
import { cancelAppointment, createAppointment, findAvailableSlots, isBlockedDate, isClinicWorkDateISO, isSlotAvailable, reconcileConfirmedCitasWithGoogleCalendar, getLastReconciliationResult } from "./calendar.js";
import { config } from "./config.js";
import { buildDateOptionRows, dateOptionReplyText } from "./date-options.js";
import { readForm, readRawBody } from "./form.js";
import { isHumanPauseExpiredState } from "./human-mode.js";
import { redactSecrets } from "./http.js";
import { buildSlotOptionRows, slotOptionReplyText } from "./slot-options.js";
import {
  buildAdminAppointmentNotification,
  buildAppointmentFailureMessage,
  buildAppointmentReviewMessage,
  buildLocationMessage,
  filterSlotsAgainstBusyRanges,
  buildPatientReminderJobs,
  buildPatientConfirmationMessage,
  classifyAppointmentError,
  validateSlotSelection
} from "./appointments.js";
import { buildOperationalHealth, isOperationallyUnhealthy } from "./health.js";
import { detectIntent, hasAny, isAppointmentLikeQuestion, looksLikeDateRequest, meaningfulWords, normalizeText } from "./intents.js";
import {
  buildInboxStats as buildInboxMetrics,
  buildCrmNextAction,
  buildManualDailyReportEntry,
  buildReceptionChecklist,
  buildReceptionQueueSummary,
  getConversationActivityISO,
  buildLocalConversationSummary,
  buildPatientCrmProfile,
  filterInboxConversations as filterInboxConversationList,
  getConversationStatus as getInboxConversationStatus,
  getOfferedSlots,
  getPatientTemperature,
  getWhatsAppWindowState,
  sortInboxConversations
} from "./inbox.js";
import { verifyMetaSignature } from "./security.js";
import {
  acquireAppointmentLock,
  checkDatabaseHealth,
  cancelCita,
  cleanupExpiredAppointmentLocks,
  cleanupProcessedWhatsAppMessages,
  deleteSession,
  failUnlinkedConfirmedCitas,
  getConversationState,
  getLatestConfirmedCitaByPhone,
  getSession,
  isDatabaseEnabled,
  loadActiveAppointmentLocks,
  loadDueReminders,
  loadDailyReports,
  loadConversations,
  loadConfirmedCitasBetween,
  loadConfirmedCitasByDay,
  loadWaitingListByDate,
  markReminderFailed,
  markReminderSent,
  markCitaFailedByGoogleEvent,
  markConversationHumanReply,
  releaseAppointmentLock,
  releaseAppointmentLocksForPhone,
  rememberProcessedWhatsAppMessage,
  loadKnowledgeSuggestions,
  deleteKnowledgeSuggestion,
  reviewKnowledgeSuggestion,
  saveCita,
  saveConversationMessage,
  saveConversationNote,
  saveDailyReport,
  saveKnowledgeSuggestion,
  saveWaitlistEntry,
  scheduleReminder,
  setConversationHumanMode,
  setConversationTags,
  setSession,
  updateKnowledgeSuggestion
} from "./db.js";
import { downloadWhatsAppAudio, getLastWhatsAppSendDiagnostic, sendMessageWithOptions, sendWhatsAppButtons, sendWhatsAppList, sendWhatsAppTemplate, sendWhatsAppText } from "./whatsapp.js";
import { appendLeadToSheet, appendAppointmentToSheet, appendUnknownQuestionToSheet, isSheetsEnabled } from "./sheets.js";
import { classifyEmailDeliveryError, isEmailEnabled, sendAppointmentConfirmationEmail, sendCancellationEmail, sendMedicalResultEmail } from "./email.js";
import {
  buildResultSentWhatsAppNotice,
  buildResultsEmailAuditText,
  buildResultsEmailMessageMetadata,
  isValidPatientEmail,
  maskEmail,
  resolveResultsEmailRecipient,
  sanitizeResultNote,
  validateResultsEmailRequest
} from "./results-email.js";
import {
  INBOX_ATTACHMENT_EMAIL_ONLY_ERROR,
  MEDICAL_CHAT_SAFE_TEXT,
  MEDICAL_FAQ_BLOCK_ERROR,
  MEDICAL_URGENCY_TEXT,
  PRIVACY_CONSENT_TEXT,
  RESULTS_PRIVACY_TEXT,
  buildMedicalPolicyWarnings,
  buildPatientResultsHumanNote,
  isMedicalFaqAutoReplyBlocked
} from "./medical-policy.js";

const sessions = new Map();
const processedMessages = new Map();
const processedMessageTtlMs = 24 * 60 * 60 * 1000;
const phoneCurrentlyProcessing = new Set();
const conversations = new Map();
const maxMessagesPerConversation = 100;
const rateLimitBuckets = new Map();
const warnedWebhookBusinessAccountIds = new Set();
const warnedWebhookDisplayPhones = new Set();
const webhookRuntimeDiagnostics = {
  lastReceivedAt: null,
  lastAcceptedAt: null,
  lastRejectedAt: null,
  lastRejectedReason: null,
  lastRejectedStatus: null,
  lastMessageAt: null,
  lastStatusOnlyAt: null,
  lastBotPausedAt: null,
  lastPhoneNumberId: null,
  lastDisplayPhoneNumber: null,
  lastMessageCount: 0,
  lastStatusCount: 0
};
let appSecretWarningShown = false;
let isShuttingDown = false;
const dailyReportsLog = [];
const maxDailyReports = 30;

function rememberDailyReport(entry) {
  if (!entry?.date || !entry?.text) return entry;
  const duplicateIndex = dailyReportsLog.findIndex((item) =>
    (entry.id && item.id === entry.id) ||
    (item.generatedAt && item.generatedAt === entry.generatedAt && item.text === entry.text)
  );
  if (duplicateIndex >= 0) {
    dailyReportsLog.splice(duplicateIndex, 1);
  }
  dailyReportsLog.unshift(entry);
  if (dailyReportsLog.length > maxDailyReports) dailyReportsLog.length = maxDailyReports;
  return entry;
}

async function persistDailyReport(entry) {
  rememberDailyReport(entry);
  try {
    const saved = await saveDailyReport(entry);
    if (saved) rememberDailyReport(saved);
  } catch (error) {
    logSafeError("Could not persist daily report", error);
  }
  return entry;
}

function mergeDailyReports(persisted = [], memory = []) {
  const seen = new Set();
  return [...persisted, ...memory]
    .filter((entry) => entry?.date && entry?.text)
    .sort((a, b) => new Date(b.generatedAt ?? 0) - new Date(a.generatedAt ?? 0))
    .filter((entry) => {
      const key = entry.id ?? `${entry.generatedAt ?? ""}:${entry.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxDailyReports);
}

const mainMenuRows = [
  { id: "main_schedule", title: "Agendar cita", description: "Iniciar registro y elegir horario" },
  { id: "main_availability", title: "Ver horarios", description: "Revisar fechas disponibles" },
  { id: "main_promo", title: "Promo $1200", description: "Que incluye el chequeo" },
  { id: "main_services", title: "Servicios", description: "Dudas generales de servicios" },
  { id: "main_costs", title: "Costos", description: "Consulta y promocion" },
  { id: "main_location", title: "Ubicacion", description: "Direccion del consultorio" },
  { id: "main_preparation", title: "Preparacion", description: "Como presentarte a la cita" },
  { id: "main_hours", title: "Horario", description: "Dias y horas de atencion" },
  { id: "main_payments", title: "Formas de pago", description: "Efectivo o transferencia" },
  { id: "main_results", title: "Resultados", description: "Solicitar estudios aprobados" }
];

const interactiveReplyMap = {
  main_schedule: "1",
  main_availability: "2",
  main_promo: "3",
  main_services: "4",
  main_costs: "5",
  main_location: "6",
  main_preparation: "7",
  main_hours: "8",
  main_payments: "9",
  main_results: "10",
  main_human: "quiero hablar con una persona",
  main_menu: "menu",
  returning_schedule: "quiero agendar otra cita",
  returning_next: "tengo cita",
  returning_reschedule: "quiero reagendar",
  returning_cancel: "quiero cancelar",
  returning_results: "quiero mis resultados",
  returning_human: "quiero hablar con una persona",
  appointment_confirm_yes: "si",
  appointment_change_time: "no",
  appointment_cancel_review: "no",
  cancel_yes: "1",
  cancel_no: "2",
  reschedule_yes: "1",
  reschedule_no: "2",
  reschedule_human: "3",
  waitlist_yes: "1",
  waitlist_other_day: "2",
  waitlist_human: "3",
  service_consultation: "consulta",
  service_promotion: "promocion",
  service_ultrasound: "ultrasonido",
  service_papanicolau: "papanicolaou",
  service_colposcopy: "colposcopia",
  service_prenatal: "control prenatal",
  service_other: "otro motivo general",
  first_visit_yes: "si",
  first_visit_no: "no",
  payment_private: "particular",
  payment_network: "red medica",
  payment_human: "quiero hablar con una persona",
  active_continue: "continuar",
  active_restart: "empezar de nuevo",
  active_human: "quiero hablar con una persona",
  // Attendance confirmation buttons
  attendance_yes: "confirmo asistencia",
  attendance_cancel: "quiero cancelar",
  // Post-appointment survey buttons
  survey_great: "encuesta excelente",
  survey_good: "encuesta bien",
  survey_regular: "encuesta regular",
  // Promo campaign buttons
  promo_schedule: "agendar promo",
  promo_info: "vi el anuncio",
  promo_includes: "que incluye el chequeo",
  payment_methods: "formas de pago",
  location: "ubicacion",
  talk_human: "quiero hablar con una persona",
  reschedule: "quiero reagendar",
  cancel_appointment: "quiero cancelar mi cita",
  search_new_date: "disponibilidad",
  confirm_yes: "si",
  confirm_no: "no",
  date_tomorrow: "cita manana",
  date_this_week: "esta semana",
  date_other: "otra fecha",
  choose_morning: "atienden en la manana",
  choose_afternoon: "en la tarde",
  choose_any_time: "cualquier horario",
  choose_other_day: "otra fecha",
  confirm_to_human: "quiero hablar con una persona",
  medical_emergency: "urgencia medica"
};

const serviceOptionRows = [
  { id: "service_consultation", title: "Consulta", description: "Revision general" },
  { id: "service_promotion", title: "Promocion", description: "Paquete promocional" },
  { id: "service_ultrasound", title: "Ultrasonido", description: "Duda o cita de ultrasonido" },
  { id: "service_papanicolau", title: "Papanicolau", description: "Revision de papanicolaou" },
  { id: "service_colposcopy", title: "Colposcopia", description: "Revision de colposcopia" },
  { id: "service_prenatal", title: "Control prenatal", description: "Embarazo o seguimiento" },
  { id: "service_other", title: "Otro motivo", description: "El consultorio lo revisa" }
];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    setSecurityHeaders(res);

    if (!checkRateLimit(req, url)) {
      res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(303, { Location: "/inbox" }).end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/privacy") {
      handlePrivacyPage(res);
      return;
    }

    if (req.method === "GET" && isWebhookPostPath(url.pathname)) {
      if (!isValidWebhookPath(url.pathname)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
        return;
      }
      handleWebhookVerification(url, res);
      return;
    }

    if (req.method !== "GET" && url.pathname === "/webhook") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("method not allowed");
        return;
      }
    }

    if (req.method === "POST" && isWebhookPostPath(url.pathname)) {
      if (!isValidWebhookPath(url.pathname)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found");
        return;
      }
      if (!isJsonRequest(req)) {
        res.writeHead(415, { "Content-Type": "text/plain; charset=utf-8" }).end("unsupported media type");
        return;
      }
      const rawBody = await readRawBody(req, config.maxRequestBytes);
      recordWebhookReceived();
      if (!isValidWebhookSignature(req, rawBody)) {
        recordWebhookRejection("invalid_or_missing_signature", 403);
        console.warn(`Rejected WhatsApp webhook: invalid/missing signature or expired unsigned mode. mode=${getWebhookSignatureMode()}`);
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
        return;
      }

      let body;
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("invalid json");
        return;
      }
      const validation = validateWhatsAppPayload(body);
      if (!validation.ok) {
        recordWebhookRejection(validation.reason, validation.status ?? 400);
        console.warn(`Rejected WhatsApp webhook payload: ${validation.reason}`);
        res.writeHead(validation.status ?? 400, { "Content-Type": "text/plain; charset=utf-8" }).end(validation.publicMessage ?? "invalid payload");
        return;
      }
      recordWebhookAccepted(body);
      res.writeHead(200).end("ok");
      await handleWhatsAppWebhook(body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      await handleHealth(req, res, { strict: false });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health/live") {
      const status = isShuttingDown ? 503 : 200;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ app: isShuttingDown ? "shutting_down" : "ok", time: new Date().toISOString() }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/health/ready") {
      await handleHealth(req, res, { strict: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/debug/config") {
      await handleDebugConfig(req, url, res);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const filename = url.pathname.slice("/public/".length);
      if (!/^[\w.\-]+$/.test(filename)) { res.writeHead(400).end("Bad request"); return; }
      try {
        const data = await readFile(new URL(`../public/${filename}`, import.meta.url));
        const ext = filename.split(".").pop().toLowerCase();
        const mime = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" }[ext] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=86400" }).end(data);
      } catch { res.writeHead(404).end("Not found"); }
      return;
    }

    if (req.method === "GET" && url.pathname === "/inbox/login") {
      handleInboxLoginPage(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/login") {
      await handleInboxLogin(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/inbox/logout") {
      clearInboxCookie(res);
      res.writeHead(303, { Location: "/inbox/login" }).end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/inbox.js") {
      handleInboxScript(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/inbox") {
      await handleInbox(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/send") {
      await handleInboxSend(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/results-email") {
      await handleInboxResultsEmail(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/takeover") {
      await handleInboxTakeover(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/release") {
      await handleInboxRelease(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/reprompt") {
      await handleInboxReprompt(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/reset-session") {
      await handleInboxResetSession(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/repair-bot") {
      await handleInboxRepairBot(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/quick-check") {
      await handleInboxQuickCheck(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/daily-report") {
      await handleInboxDailyReport(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/resolve-urgent") {
      await handleInboxResolveUrgent(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/resolve-conversation") {
      await handleInboxResolveConversation(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/send-template") {
      await handleInboxSendTemplate(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/tags") {
      await handleInboxTags(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/notes") {
      await handleInboxNote(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/cancel-day") {
      await handleInboxCancelDay(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/knowledge/review") {
      await handleKnowledgeReview(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/knowledge/create") {
      await handleKnowledgeCreate(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/knowledge/update") {
      await handleKnowledgeUpdate(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/knowledge/delete") {
      await handleKnowledgeDelete(req, url, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/oauth/google/callback") {
      handleGoogleOAuthCallback(url, res);
      return;
    }

    res.writeHead(404).end("not found");
  } catch (error) {
    logSafeError("Unhandled server error", error);
    if (!res.headersSent) {
      const status = error.message?.startsWith("Request body too large") ? 413 : 500;
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(status === 413 ? "payload too large" : "server error");
    }
  }
});

server.listen(config.port, () => {
  warnAboutSecurityMode();
  console.log(`WhatsApp calendar bot listening on port ${config.port}`);
  startReminderWorker();
  startDailyReportWorker();
  startColdLeadFollowupWorker();
  startPostAppointmentSurveyWorker();
  startReconciliationWorker();
  void cleanupAppointmentStateOnStartup();
});

process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.once("SIGINT", () => gracefulShutdown("SIGINT"));

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Received ${signal}; closing HTTP server gracefully.`);
  server.close((error) => {
    if (error) {
      logSafeError("Error during graceful shutdown", error);
      process.exitCode = 1;
    }
    process.exit();
  });
  setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 10_000).unref?.();
}

function warnAboutSecurityMode() {
  if (config.webhookPathSecret && config.webhookPathSecret.length < 24) {
    const message = "WEBHOOK_PATH_SECRET should be at least 24 characters.";
    if (config.nodeEnv === "production") console.warn(`WARNING: ${message}`);
  }

  if (config.allowUnsignedWebhooks) {
    const expiry = config.unsignedWebhookExpiresAt ? ` Expires at: ${config.unsignedWebhookExpiresAt}.` : " No expiry configured.";
    console.warn(
      `WARNING: WhatsApp webhook is running in UNSIGNED TEMPORARY MODE.${expiry} Configure WHATSAPP_APP_SECRET and set ALLOW_UNSIGNED_WEBHOOKS=false before production traffic.`
    );
  }

  if (config.nodeEnv === "production" && !config.whatsappAppSecret && !config.allowUnsignedWebhooks) {
    console.warn("WARNING: WHATSAPP_APP_SECRET is missing and unsigned webhooks are disabled. WhatsApp POST webhooks will be rejected.");
  }

  if (!config.cookieSecret || config.cookieSecret.length < 32) {
    console.warn("WARNING: COOKIE_SECRET is missing or shorter than 32 characters. Configure a strong COOKIE_SECRET in production.");
  }

  if (!config.inboxPasswordHash && (!config.inboxPassword || config.inboxPassword.length < 16)) {
    console.warn("WARNING: INBOX_PASSWORD is missing or weak. Use INBOX_PASSWORD_HASH or a strong password in production.");
  }

  if (config.inboxAllowLegacyTokenAccess) {
    console.warn("WARNING: INBOX_ALLOW_LEGACY_TOKEN_ACCESS=true allows URL/Bearer password access. Keep it false in production.");
  }
}

async function cleanupAppointmentStateOnStartup() {
  if (!isDatabaseEnabled()) return;

  try {
    const locks = await cleanupExpiredAppointmentLocks();
    const unlinked = await failUnlinkedConfirmedCitas(
      "Auto-expirada en arranque: cita confirmed sin google_event_id."
    );
    console.log(
      `Appointment startup cleanup complete. expiredLocks=${locks?.ok ? "checked" : locks?.status ?? "unknown"} unlinkedConfirmed=${Array.isArray(unlinked) ? unlinked.length : 0}`
    );
  } catch (error) {
    logSafeError("Could not cleanup stale appointment state on startup", error);
  }

  // Reconcile Supabase confirmed citas against Google Calendar
  try {
    await reconcileConfirmedCitasWithGoogleCalendar();
  } catch (error) {
    console.error("Startup reconciliation failed:", error?.message);
  }
}

function isWebhookPostPath(pathname) {
  return pathname === "/webhook" || pathname.startsWith("/webhook/");
}

function isValidWebhookPath(pathname) {
  if (!config.webhookPathSecret) return pathname === "/webhook";
  return pathname === `/webhook/${encodeURIComponent(config.webhookPathSecret)}` || pathname === `/webhook/${config.webhookPathSecret}`;
}

function isJsonRequest(req) {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().includes("application/json");
}

function handleWebhookVerification(url, res) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === config.whatsappVerifyToken) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(challenge);
    return;
  }

  res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
}

function handleGoogleOAuthCallback(url, res) {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(`Google OAuth error: ${error}`);
    return;
  }

  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Missing Google OAuth code.");
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`
    <main style="font-family: system-ui, sans-serif; max-width: 720px; margin: 48px auto; line-height: 1.5;">
      <h1>Google Calendar autorizado</h1>
      <p>Copia este comando y ejecútalo en la terminal del proyecto:</p>
      <pre style="white-space: pre-wrap; background: #f4f4f4; padding: 16px; border-radius: 8px;">npm run google:token -- ${escapeHtml(code)}</pre>
      <p>Después reinicia el bot.</p>
    </main>
  `);
}

function validateWhatsAppPayload(body) {
  if (body?.object !== "whatsapp_business_account") {
    return { ok: false, reason: "invalid object", status: 400, publicMessage: "invalid payload" };
  }

  if (!Array.isArray(body.entry)) {
    return { ok: false, reason: "entry is not array", status: 400, publicMessage: "invalid payload" };
  }

  let hasProcessableChange = false;
  for (const entry of body.entry) {
    const businessAccountId = String(entry?.id ?? "");
    const businessAccountMismatch = Boolean(
      config.whatsappBusinessAccountId &&
      businessAccountId &&
      businessAccountId !== config.whatsappBusinessAccountId
    );
    if (businessAccountMismatch && !warnedWebhookBusinessAccountIds.has(businessAccountId)) {
      warnedWebhookBusinessAccountIds.add(businessAccountId);
      console.warn(
        `WhatsApp webhook business account id differs from configured value; accepting only if phone_number_id matches. entry_id=${maskIdentifier(businessAccountId)}`
      );
    }

    if (!Array.isArray(entry?.changes)) {
      return { ok: false, reason: "changes is not array", status: 400, publicMessage: "invalid payload" };
    }

    for (const change of entry.changes) {
      if (change?.field !== "messages") continue;
      hasProcessableChange = true;

      const metadata = change.value?.metadata;
      if (metadata?.phone_number_id !== config.whatsappPhoneNumberId) {
        return {
          ok: false,
          reason: `unexpected phone_number_id actual=${maskIdentifier(metadata?.phone_number_id)} expected=${maskIdentifier(config.whatsappPhoneNumberId)}`,
          status: 403,
          publicMessage: "forbidden"
        };
      }

      if (
        config.whatsappDisplayPhoneNumber &&
        normalizePhone(metadata?.display_phone_number) !== normalizePhone(config.whatsappDisplayPhoneNumber)
      ) {
        const displayPhone = String(metadata?.display_phone_number ?? "");
        if (displayPhone && !warnedWebhookDisplayPhones.has(displayPhone)) {
          warnedWebhookDisplayPhones.add(displayPhone);
          console.warn(
            `WhatsApp webhook display_phone_number differs from configured value; accepting because phone_number_id matches. display_phone_number=${maskPhone(displayPhone)}`
          );
        }
      }
    }
  }

  if (!hasProcessableChange) return { ok: true, noMessages: true };
  return { ok: true };
}

function recordWebhookReceived() {
  webhookRuntimeDiagnostics.lastReceivedAt = new Date().toISOString();
}

function recordWebhookRejection(reason, status) {
  webhookRuntimeDiagnostics.lastRejectedAt = new Date().toISOString();
  webhookRuntimeDiagnostics.lastRejectedReason = String(reason ?? "unknown").slice(0, 240);
  webhookRuntimeDiagnostics.lastRejectedStatus = status ?? null;
}

function recordWebhookAccepted(body) {
  const summary = summarizeWhatsAppWebhook(body);
  webhookRuntimeDiagnostics.lastAcceptedAt = new Date().toISOString();
  webhookRuntimeDiagnostics.lastPhoneNumberId = summary.phoneNumberId;
  webhookRuntimeDiagnostics.lastDisplayPhoneNumber = summary.displayPhoneNumber;
  webhookRuntimeDiagnostics.lastMessageCount = summary.messageCount;
  webhookRuntimeDiagnostics.lastStatusCount = summary.statusCount;
  if (summary.messageCount > 0) {
    webhookRuntimeDiagnostics.lastMessageAt = webhookRuntimeDiagnostics.lastAcceptedAt;
  } else if (summary.statusCount > 0) {
    webhookRuntimeDiagnostics.lastStatusOnlyAt = webhookRuntimeDiagnostics.lastAcceptedAt;
  }
}

function summarizeWhatsAppWebhook(body) {
  let messageCount = 0;
  let statusCount = 0;
  let phoneNumberId = "";
  let displayPhoneNumber = "";

  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;
      const value = change.value ?? {};
      if (value.metadata?.phone_number_id) phoneNumberId = maskIdentifier(value.metadata.phone_number_id);
      if (value.metadata?.display_phone_number) displayPhoneNumber = maskPhone(value.metadata.display_phone_number);
      messageCount += Array.isArray(value.messages) ? value.messages.length : 0;
      statusCount += Array.isArray(value.statuses) ? value.statuses.length : 0;
    }
  }

  return { messageCount, statusCount, phoneNumberId, displayPhoneNumber };
}

function getWebhookDiagnostics() {
  return {
    ...webhookRuntimeDiagnostics,
    signatureMode: getWebhookSignatureMode(),
    pathSecretEnabled: Boolean(config.webhookPathSecret),
    unsignedWebhooksAllowed: config.allowUnsignedWebhooks,
    unsignedWebhookExpiresAt: config.unsignedWebhookExpiresAt ?? null,
    unsignedWebhookExpired: isUnsignedWebhookExpired()
  };
}

function getWebhookSignatureMode() {
  if (config.whatsappAppSecret && config.requireWebhookSignature) {
    return config.allowUnsignedWebhooks ? "signed-required-unsigned-flag-present" : "signed-required";
  }
  if (config.allowUnsignedWebhooks) return isUnsignedWebhookExpired() ? "unsigned-expired" : "unsigned-temporary";
  return "blocked-missing-app-secret";
}

async function handleHealth(req, res, options = {}) {
  const db = await checkDatabaseHealth();
  const health = buildOperationalHealth({
    db,
    conversationCount: conversations.size,
    memorySessionCount: sessions.size,
    processedMessageCount: processedMessages.size,
    webhookDiagnostics: getWebhookDiagnostics(),
    whatsappSendDiagnostic: getLastWhatsAppSendDiagnostic()
  });

  res
    .writeHead(options.strict && isOperationallyUnhealthy(health) ? 503 : 200, { "Content-Type": "application/json; charset=utf-8" })
    .end(JSON.stringify(health));
}

async function handleDebugConfig(req, url, res) {
  if (!hasInboxAccess(req, url, res)) {
    return;
  }

  let activeLocks = [];
  try {
    activeLocks = (await loadActiveAppointmentLocks(10)).map((lock) => ({
      id: lock.id,
      slotStart: lock.slotStart,
      slotEnd: lock.slotEnd,
      expiresAt: lock.expiresAt,
      phoneNumber: maskPhone(lock.phoneNumber)
    }));
  } catch (error) {
    logSafeError("Could not load active appointment locks for debug config", error);
  }

  res
    .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
    .end(
      JSON.stringify({
        aiProvider: config.aiProvider,
        calendarLabel: config.googleCalendarLabel,
        calendarId: config.googleCalendarId,
        busyCalendarIds: config.googleBusyCalendarIds,
        calendarIdSource: config.googleCalendarIdConfigured ? "env" : "default-agenda-dra-carranza",
        usingConfiguredCalendar: config.googleCalendarIdConfigured,
        clinicTimezone: config.clinicTimezone,
        appointmentMinutes: config.appointmentMinutes,
        maxOfferedSlots: config.maxOfferedSlots,
        workStart: config.workStart,
        workEnd: config.workEnd,
        whatsappPhoneNumberId: maskIdentifier(config.whatsappPhoneNumberId),
        whatsappBusinessAccountId: maskIdentifier(config.whatsappBusinessAccountId),
        whatsappDisplayPhoneNumber: maskPhone(config.whatsappDisplayPhoneNumber),
        whatsappTokenSource: config.whatsappTokenSource,
        whatsappTokenVarsConfigured: config.whatsappTokenVarsConfigured,
        whatsappTokenConflict: config.whatsappTokenConflict,
        whatsappLastSend: getLastWhatsAppSendDiagnostic(),
        webhookSignatureMode: config.whatsappAppSecret && config.requireWebhookSignature ? "signed" : config.allowUnsignedWebhooks ? "unsigned-temporary" : "blocked",
        webhookPathSecretEnabled: Boolean(config.webhookPathSecret),
        webhookDiagnostics: getWebhookDiagnostics(),
        medicalMessagingPolicyWarnings: buildMedicalPolicyWarnings(config),
        doctorWhatsappNumber: maskPhone(config.doctorWhatsappNumber),
        databaseEnabled: isDatabaseEnabled(),
        email: {
          configured: isEmailEnabled(),
          resendApiKeyConfigured: Boolean(config.resendApiKey),
          resendFromEmailConfigured: Boolean(config.resendFromEmail)
        },
        activeAppointmentLocks: activeLocks
      })
    );
}

async function handleInbox(req, url, res) {
  if (!hasInboxAccess(req, url, res, { redirectToLogin: true })) {
    return;
  }

  const selectedPhone = url.searchParams.get("phone");
  const list = await getInboxConversations();
  const selected = selectedPhone ? conversations.get(selectedPhone) : undefined;
  const knowledgeSuggestions = {
    pending: await loadKnowledgeSuggestions("pending", 12),
    approved: await loadKnowledgeSuggestions("approved", 20)
  };
  const diagnostics = await buildInboxDiagnostics();
  const persistedReports = await loadDailyReports(maxDailyReports);
  const dailyReports = mergeDailyReports(persistedReports, dailyReportsLog);

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderInboxPage(list, selected, req, url, knowledgeSuggestions, diagnostics, dailyReports));
}

async function buildInboxDiagnostics() {
  const db = await checkDatabaseHealth();
  let activeLocks = [];
  try {
    activeLocks = await loadActiveAppointmentLocks(20);
  } catch (error) {
    logSafeError("Could not load active appointment locks for inbox diagnostics", error);
  }

  const items = [
    {
      label: "WhatsApp",
      ok: Boolean(config.whatsappAccessToken && config.whatsappPhoneNumberId && !config.whatsappTokenConflict),
      detail: config.whatsappAccessToken && config.whatsappPhoneNumberId
        ? `Configurado · token: ${config.whatsappTokenSource}${config.whatsappTokenConflict ? " · revisar token viejo" : ""}`
        : "Faltan token o phone number id"
    },
    {
      label: "Firma Meta",
      ok: Boolean(config.whatsappAppSecret && config.requireWebhookSignature && !config.allowUnsignedWebhooks),
      detail: config.whatsappAppSecret && config.requireWebhookSignature && !config.allowUnsignedWebhooks ? "Firmado" : "Revisar App Secret"
    },
    {
      label: "Supabase",
      ok: Boolean(db?.ok),
      detail: db?.status ?? "desconocido"
    },
    {
      label: "Google",
      ok: Boolean(config.googleClientId && config.googleClientSecret && config.googleRefreshToken),
      detail: config.googleClientId && config.googleClientSecret && config.googleRefreshToken ? "OAuth configurado" : "Faltan credenciales"
    },
    {
      label: "Correo",
      ok: isEmailEnabled(),
      detail: isEmailEnabled() ? "Resend configurado" : buildEmailConfigErrorMessage().replace(/^No se pudo enviar el correo: /, "")
    },
    {
      label: "Inbox",
      ok: Boolean((config.inboxPassword || config.inboxPasswordHash) && config.cookieSecret),
      detail: (config.inboxPassword || config.inboxPasswordHash) && config.cookieSecret ? "Protegido" : "Falta auth/cookie"
    },
    {
      label: "Recordatorios",
      ok: !config.enableReminderWorker || Boolean(config.whatsappReminderTemplate24h || config.whatsappReminderTemplate2h),
      detail: config.enableReminderWorker
        ? (config.whatsappReminderTemplate24h && config.whatsappReminderTemplate2h)
          ? `Activos — 24h: ${config.whatsappReminderTemplate24h}, 2h: ${config.whatsappReminderTemplate2h}`
          : config.whatsappReminderTemplate24h
            ? `Solo 24h activo (${config.whatsappReminderTemplate24h}) — falta template 2h`
            : config.whatsappReminderTemplate2h
              ? `Solo 2h activo (${config.whatsappReminderTemplate2h}) — falta template 24h`
              : "Worker activo pero faltan templates WHATSAPP_REMINDER_TEMPLATE_24H / _2H en Render"
        : "Apagados (activar con ENABLE_REMINDER_WORKER=true y templates aprobadas)"
    }
  ];

  return {
    ready: items.every((item) => item.ok),
    items,
    activeLocksCount: activeLocks.length,
    generatedAt: new Date().toISOString()
  };
}

function handleInboxScript(res) {
  res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" }).end(`(() => {
  function scrollMessagesToBottom() {
    const messages = document.querySelector(".messages");
    if (!messages) return;
    messages.scrollTop = messages.scrollHeight;
  }

  function bindQuickReplies() {
    const composer = document.querySelector(".composer textarea[name='message']");
    if (!composer) return;
    document.querySelectorAll("[data-template]").forEach((button) => {
      button.addEventListener("click", () => {
        composer.value = button.dataset.template || "";
        composer.focus();
      });
    });
  }

  function bindCopyButtons() {
    document.querySelectorAll("[data-copy-phone]").forEach((button) => {
      button.addEventListener("click", async () => {
        const phone = button.dataset.copyPhone || "";
        try {
          await navigator.clipboard.writeText(phone);
          const original = button.textContent;
          button.textContent = "Copiado";
          setTimeout(() => { button.textContent = original; }, 1200);
        } catch {
          window.prompt("Copia el telefono:", phone);
        }
      });
    });
  }

  function bindComposerEnhancements() {
    const form = document.querySelector(".composer form");
    const composer = document.querySelector(".composer textarea[name='message']");
    const counter = document.querySelector("[data-message-count]");
    if (composer && counter) {
      const updateCounter = () => {
        counter.textContent = composer.value.length + "/2000";
      };
      composer.addEventListener("input", updateCounter);
      updateCounter();
    }
    if (form) {
      form.addEventListener("submit", () => {
        const button = form.querySelector(".send-button");
        if (!button) return;
        button.disabled = true;
        button.textContent = "Enviando...";
      });
    }
  }

  function bindInboxDynamicActions() {
    bindQuickReplies();
    bindCopyButtons();
    bindComposerEnhancements();
    bindChatScrollButtons();
    bindResultsEmailActions();
    bindDirtyForms();
  }

  function bindChatScrollButtons() {
    document.querySelectorAll("[data-scroll-chat]").forEach((button) => {
      button.addEventListener("click", () => {
        const messages = document.querySelector(".messages");
        if (!messages) return;
        messages.scrollIntoView({ block: "center", behavior: "smooth" });
        scrollMessagesToBottom();
        if (typeof messages.focus === "function") messages.focus({ preventScroll: true });
      });
    });
    document.querySelectorAll("[data-open-template-actions]").forEach((button) => {
      button.addEventListener("click", () => {
        const panel = document.querySelector(".template-actions");
        if (!panel) return;
        panel.open = true;
        panel.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    });
    document.querySelectorAll("[data-open-knowledge-panel]").forEach((button) => {
      button.addEventListener("click", () => {
        const panel = document.querySelector(".knowledge");
        if (!panel) return;
        panel.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    });
  }

  function bindResultsEmailActions() {
    const openPanel = (event) => {
      event.preventDefault();
      const panel = document.getElementById("send-file-email");
      if (!panel) return;
      panel.classList.add("is-open");
      panel.setAttribute("aria-hidden", "false");
      document.body.classList.add("results-email-open");
      window.setTimeout(() => {
        const target = panel.querySelector("input[type='file'], summary, button");
        if (target && typeof target.focus === "function") target.focus();
      }, 180);
    };
    const closePanel = (event) => {
      if (event) event.preventDefault();
      const panel = document.getElementById("send-file-email");
      if (!panel) return;
      panel.classList.remove("is-open");
      panel.setAttribute("aria-hidden", "true");
      document.body.classList.remove("results-email-open");
    };

    document.querySelectorAll("[data-open-results-email]").forEach((button) => {
      button.addEventListener("click", openPanel);
    });
    document.querySelectorAll("a[href='#send-file-email']").forEach((link) => {
      link.addEventListener("click", openPanel);
    });
    document.querySelectorAll("[data-close-results-email]").forEach((button) => {
      button.addEventListener("click", closePanel);
    });
    document.querySelectorAll(".results-email-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", closePanel);
    });
    document.querySelectorAll("form[action='/inbox/results-email']").forEach((form) => {
      form.addEventListener("submit", () => {
        const button = form.querySelector("button[type='submit']");
        if (!button) return;
        button.disabled = true;
        button.textContent = "Enviando al correo...";
      });
    });
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePanel(event);
    });
  }

  function updateRefreshStatus(text) {
    document.querySelectorAll("[data-refresh-status]").forEach((node) => {
      node.textContent = text;
    });
  }

  function userIsTyping() {
    const active = document.activeElement;
    if (!active) return false;
    const tag = active.tagName;
    return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT";
  }

  function bindDirtyForms() {
    document.querySelectorAll("form").forEach((form) => {
      form.addEventListener("input", () => {
        form.dataset.dirty = "true";
      });
      form.addEventListener("change", () => {
        form.dataset.dirty = "true";
      });
      form.addEventListener("submit", () => {
        form.dataset.submitting = "true";
        form.dataset.dirty = "false";
      });
    });
  }

  function hasDirtyForm() {
    return Boolean(document.querySelector("form[data-dirty='true']:not([data-submitting='true'])"));
  }

  function hasOpenWorkPanel() {
    return Boolean(document.querySelector("details[open]:not(.appointment-card):not(.mobile-patient-sheet), .results-email-modal.is-open, .results-email-modal:target"));
  }

  function hasDraft() {
    const composer = document.querySelector(".composer textarea[name='message']");
    const attachment = document.querySelector(".composer input[type='file']");
    const anyFile = Array.from(document.querySelectorAll("input[type='file']")).some((input) => input.files && input.files.length > 0);
    return Boolean((composer && composer.value.trim()) || (attachment && attachment.files && attachment.files.length > 0) || anyFile);
  }

  function userIsReadingOldMessages() {
    const messages = document.querySelector(".messages");
    if (!messages) return false;
    const distanceFromBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight;
    return distanceFromBottom > 180;
  }

  async function refreshInboxContent() {
    const url = new URL(window.location.href);
    url.searchParams.set("refresh", String(Date.now()));

    const currentMessages = document.querySelector(".messages");
    const wasReadingOld = userIsReadingOldMessages();
    const distanceFromBottom = currentMessages
      ? currentMessages.scrollHeight - currentMessages.scrollTop - currentMessages.clientHeight
      : 0;

    const response = await fetch(url.toString(), {
      headers: { "X-Inbox-Refresh": "1" },
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error("refresh failed");

    const nextDocument = new DOMParser().parseFromString(await response.text(), "text/html");
    const nextMain = nextDocument.querySelector("main");
    const currentMain = document.querySelector("main");
    if (nextMain && currentMain) currentMain.replaceWith(nextMain);

    const nextMetricStrip = nextDocument.querySelector(".metric-strip");
    const currentMetricStrip = document.querySelector(".metric-strip");
    if (nextMetricStrip && currentMetricStrip) currentMetricStrip.replaceWith(nextMetricStrip);

    const nextStatus = nextDocument.querySelector("header .status");
    const currentStatus = document.querySelector("header .status");
    if (nextStatus && currentStatus) currentStatus.replaceWith(nextStatus);

    document.body.className = nextDocument.body.className;
    bindInboxDynamicActions();

    const refreshedMessages = document.querySelector(".messages");
    if (refreshedMessages) {
      if (wasReadingOld) {
        refreshedMessages.scrollTop = Math.max(0, refreshedMessages.scrollHeight - refreshedMessages.clientHeight - distanceFromBottom);
      } else {
        refreshedMessages.scrollTop = refreshedMessages.scrollHeight;
      }
    }
  }

  function bindSmartRefresh() {
    const refreshMs = 20000;
    let lastRefresh = Date.now();
    let autoRefreshEnabled = localStorage.getItem("inboxAutoRefresh") !== "off";
    const refreshButtons = document.querySelectorAll("[data-refresh-toggle]");
    const updateToggleLabel = () => {
      refreshButtons.forEach((button) => {
        button.textContent = autoRefreshEnabled ? "Auto refresh activo" : "Auto refresh apagado";
        button.classList.toggle("warn", !autoRefreshEnabled);
      });
    };
    refreshButtons.forEach((button) => {
      button.addEventListener("click", () => {
        autoRefreshEnabled = !autoRefreshEnabled;
        localStorage.setItem("inboxAutoRefresh", autoRefreshEnabled ? "on" : "off");
        updateToggleLabel();
        updateRefreshStatus(autoRefreshEnabled ? "Actualizado ahora" : "Auto refresh apagado");
      });
    });
    updateToggleLabel();
    updateRefreshStatus(autoRefreshEnabled ? "Actualizado ahora" : "Auto refresh apagado");
    window.setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - lastRefresh) / 1000));
      if (!autoRefreshEnabled) {
        updateRefreshStatus("Auto refresh apagado");
        return;
      }
      if (document.hidden) {
        updateRefreshStatus("Pausado");
        return;
      }
      if (userIsTyping() || hasDraft() || hasDirtyForm() || hasOpenWorkPanel()) {
        updateRefreshStatus("Pausado: cambios sin guardar");
        return;
      }
      if (elapsedSeconds < Math.ceil(refreshMs / 1000)) {
        updateRefreshStatus("Actualizado hace " + elapsedSeconds + "s");
        return;
      }
      refreshInboxContent()
        .then(() => {
          lastRefresh = Date.now();
          updateRefreshStatus(userIsReadingOldMessages() ? "Actualizado sin moverte" : "Actualizado ahora");
        })
        .catch(() => {
          const url = new URL(window.location.href);
          url.searchParams.set("refresh", String(Date.now()));
          window.location.replace(url.toString());
        });
    }, 5000);
  }

  function initInbox() {
    bindInboxDynamicActions();
    bindSmartRefresh();
    scrollMessagesToBottom();
  }

  window.addEventListener("DOMContentLoaded", initInbox);
  window.addEventListener("load", scrollMessagesToBottom);
  window.addEventListener("pageshow", scrollMessagesToBottom);
  setTimeout(scrollMessagesToBottom, 80);
})();`);
}

async function handleInboxSend(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-send")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.inboxMediaMaxBytes + config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  const message = String(form.get("message") ?? "").trim();
  const attachment = form.getFile?.("attachment");
  const validAttachment = attachment && attachment.size > 0 ? attachment : undefined;

  if (validAttachment) {
    await redirectInbox(res, phone, INBOX_ATTACHMENT_EMAIL_ONLY_ERROR);
    return;
  }

  if (!isValidWhatsAppPhone(phone) || !message || message.length > 2000) {
    await redirectInbox(res, phone, "Mensaje invalido o telefono invalido.");
    return;
  }

  const conversationForWindow = await loadConversationForInboxSend(phone);
  const windowState = getWhatsAppWindowState(conversationForWindow);
  if (windowState.key === "expired") {
    await redirectInbox(
      res,
      phone,
      "No se puede enviar texto libre: ya pasaron mas de 24 horas desde el ultimo mensaje del paciente. Pidele que escriba de nuevo o usa una plantilla aprobada de Meta."
    );
    return;
  }

  try {
    await sendWhatsAppText(phone, message);
    await recordConversationMessage(phone, "human", message, { source: "inbox" });
    await saveHumanKnowledgeSuggestion(phone, message);
    await markConversationHumanReply(phone);
    console.log(`Inbox human reply sent to ${maskPhone(phone)}`);
    await redirectInbox(res, phone);
  } catch (error) {
    logSafeError(`Could not send inbox reply to ${maskPhone(phone)}`, error);
    await redirectInbox(res, phone, classifyWhatsAppInboxSendError(error));
  }
}

async function handleInboxResultsEmail(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  let form;
  try {
    form = await readForm(req, { maxBytes: config.resultsEmailMaxBytes + config.maxRequestBytes });
  } catch (error) {
    logSafeError("Could not read results email form", error);
    res.writeHead(error.message?.startsWith("Request body too large") ? 413 : 400, { "Content-Type": "text/plain; charset=utf-8" }).end("payload invalid");
    return;
  }

  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  if (!isValidWhatsAppPhone(phone)) {
    await redirectInbox(res, "", "Telefono invalido.");
    return;
  }

  const conversation = await loadConversationForInboxSend(phone);
  const appointment = conversation?.appointment;
  const emailRecipient = resolveResultsEmailRecipient({ appointment, conversation });
  const patientEmail = emailRecipient.email;
  const resultFile = form.getFile?.("resultFile");
  const validFile = resultFile && resultFile.size > 0 ? resultFile : undefined;
  const confirmed = form.get("confirmed") === "yes";
  const validationError = validateResultsEmailRequest({
    patientEmail,
    file: validFile,
    confirmed,
    maxBytes: config.resultsEmailMaxBytes
  });

  if (validationError) {
    await redirectInbox(res, phone, validationError);
    return;
  }

  if (!isEmailEnabled()) {
    await redirectInbox(res, phone, buildEmailConfigErrorMessage());
    return;
  }

  const note = sanitizeResultNote(form.get("note"));
  const emailMasked = maskEmail(patientEmail);
  const auditText = buildResultsEmailAuditText({ email: patientEmail, filename: validFile.filename });

  try {
    await sendMedicalResultEmail({
      to: patientEmail,
      name: appointment?.patientName ?? (conversation ? getConversationDisplayName(conversation) : undefined),
      clinicName: config.clinicName,
      file: validFile,
      note
    });
  } catch (error) {
    logSafeError(`Could not send medical result email to ${emailMasked}`, error);
    await redirectInbox(res, phone, classifyEmailDeliveryError(error));
    return;
  }

  const noteRecord = {
    body: auditText,
    author: "consultorio",
    createdAt: new Date().toISOString()
  };
  const existing = conversations.get(phone) ?? conversation ?? { phoneNumber: phone, messages: [], updatedAt: new Date().toISOString() };
  existing.notes = [noteRecord, ...(existing.notes ?? [])].slice(0, 20);
  conversations.set(phone, existing);

  let auditSaved = true;
  try {
    await saveConversationNote({ phoneNumber: phone, body: auditText, author: "consultorio" });
  } catch (error) {
    auditSaved = false;
    logSafeError(`Could not save results email note for ${maskPhone(phone)}`, error);
  }

  await recordConversationMessage(phone, "admin", auditText, buildResultsEmailMessageMetadata({
    email: patientEmail,
    filename: validFile.filename
  }));

  await maybeSendResultsEmailWhatsAppNotice(phone, conversation ?? existing, emailMasked);
  await redirectInbox(
    res,
    phone,
    auditSaved
      ? "Archivo enviado exitosamente al correo confirmado de la paciente."
      : "Archivo enviado exitosamente al correo confirmado, pero no pude guardar la nota interna. Revisa Supabase.",
    "success"
  );
}

function buildEmailConfigErrorMessage() {
  const missing = [];
  if (!config.resendApiKey) missing.push("RESEND_API_KEY");
  if (!config.resendFromEmail) missing.push("RESEND_FROM_EMAIL");
  return `No se pudo enviar el correo: falta configurar ${missing.join(" y ")} en Render.`;
}

async function maybeSendResultsEmailWhatsAppNotice(phone, conversation, emailMasked) {
  const windowState = getWhatsAppWindowState(conversation);
  if (!["open", "closing"].includes(windowState.key)) return;

  const notice = buildResultSentWhatsAppNotice();
  try {
    await sendWhatsAppText(phone, notice);
    await recordConversationMessage(phone, "human", notice, {
      source: "inbox_results_email_notice",
      emailMasked
    });
    await markConversationHumanReply(phone);
  } catch (error) {
    logSafeError(`Could not send results email WhatsApp notice to ${maskPhone(phone)}`, error);
  }
}

async function loadConversationForInboxSend(phone) {
  const inMemory = conversations.get(phone);
  if (inMemory?.messages?.length) return inMemory;

  try {
    const saved = await loadConversations();
    return saved?.find((conversation) => conversation.phoneNumber === phone) ?? inMemory;
  } catch (error) {
    logSafeError(`Could not load conversation before inbox send to ${maskPhone(phone)}`, error);
    return inMemory;
  }
}

function classifyWhatsAppInboxSendError(error) {
  const message = String(error?.message ?? "");
  if (/131047|24.?hour|24 horas|customer service window|outside.*window/i.test(message)) {
    return "WhatsApp rechazo el mensaje porque la ventana de 24 horas ya cerro. Pidele al paciente que escriba de nuevo o usa una plantilla aprobada de Meta.";
  }
  if (/190|oauth|access token|invalid token|expired token/i.test(message)) {
    return "WhatsApp rechazo el envio por token invalido o vencido. Revisa WHATSAPP_TOKEN/WHATSAPP_ACCESS_TOKEN del numero nuevo en Render.";
  }
  if (/131030|allowed list|lista de autorizados|recipient phone number not in allowed list/i.test(message)) {
    return "WhatsApp rechazo el envio porque el destinatario no esta autorizado para este numero. Si estas usando el entorno de prueba, agrega ese telefono a destinatarios permitidos en Meta. Si ya es el numero real, revisa que Render use el token y Phone Number ID del numero nuevo.";
  }
  if (/phone_number_id|not linked|does not exist|unsupported post request/i.test(message)) {
    return "WhatsApp rechazo el envio por Phone Number ID incorrecto. Revisa WHATSAPP_PHONE_NUMBER_ID del numero nuevo en Render.";
  }
  if (/permission|permissions|131031|10|200/i.test(message)) {
    return "WhatsApp rechazo el envio por permisos de Meta. Revisa que el token tenga permiso de WhatsApp y que el numero nuevo este conectado a la app.";
  }
  if (/131026|recipient|undeliverable|not a valid whatsapp/i.test(message)) {
    return "WhatsApp no pudo entregar al telefono del paciente. Revisa que el numero tenga WhatsApp y este en formato internacional.";
  }
  if (/429|rate limit|too many/i.test(message)) {
    return "WhatsApp limito temporalmente los envios. Espera un momento y prueba de nuevo.";
  }
  return "No se pudo enviar el mensaje por WhatsApp. Revisa logs de Render para ver el error de Meta.";
}

async function handleKnowledgeReview(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const id = form.get("id");
  const status = form.get("status");
  const answer = String(form.get("answer") ?? "").trim();
  const action = form.get("action") === "human_handoff" ? "human_handoff" : "answer";
  const intent = String(form.get("intent") ?? "").trim();
  if (!id || !["approved", "rejected", "ignored"].includes(status)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("invalid review");
    return;
  }
  if (status === "approved" && action === "answer" && answer.length < 4) {
    await redirectInbox(res, form.get("phone") ?? "", "Escribe una respuesta antes de aprobar la FAQ.");
    return;
  }

  await reviewKnowledgeSuggestion(id, status, {
    answer: answer || undefined,
    intent: intent || undefined,
    action,
    active: status === "approved"
  });
  await redirectInbox(res, form.get("phone") ?? "");
}

async function handleKnowledgeCreate(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }
  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  const question = String(form.get("question") ?? "").trim();
  const answer = String(form.get("answer") ?? "").trim();
  const action = form.get("action") === "human_handoff" ? "human_handoff" : "answer";
  const intent = String(form.get("intent") ?? "").trim();
  const variations = parseVariations(form.get("variations"));
  const priority = Number(form.get("priority") ?? 100);
  if (question.length < 4 || (action === "answer" && answer.length < 4) || question.length > 1000 || answer.length > 2000) {
    await redirectInbox(res, phone, "Pregunta o respuesta invalida.");
    return;
  }
  if (isMedicalFaqAutoReplyBlocked({ question, answer, action })) {
    await redirectInbox(res, phone, MEDICAL_FAQ_BLOCK_ERROR);
    return;
  }

  await saveKnowledgeSuggestion({
    question,
    answer,
    sourcePhone: phone || undefined,
    intent: intent || undefined,
    variations,
    priority: Number.isFinite(priority) ? priority : 100,
    action,
    status: "approved"
  });
  await redirectInbox(res, phone);
}

async function handleKnowledgeUpdate(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }
  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const id = form.get("id");
  const phone = normalizePhone(form.get("phone") ?? "");
  const question = String(form.get("question") ?? "").trim();
  const answer = String(form.get("answer") ?? "").trim();
  const action = form.get("action") === "human_handoff" ? "human_handoff" : "answer";
  const intent = String(form.get("intent") ?? "").trim();
  const variations = parseVariations(form.get("variations"));
  const priority = Number(form.get("priority") ?? 100);
  const activeValue = form.get("active");
  const active = activeValue === "true" ? true : activeValue === "false" ? false : undefined;
  if (!id || question.length < 4 || (action === "answer" && answer.length < 4) || question.length > 1000 || answer.length > 2000) {
    await redirectInbox(res, phone, "FAQ invalida.");
    return;
  }
  if (isMedicalFaqAutoReplyBlocked({ question, answer, action })) {
    await redirectInbox(res, phone, MEDICAL_FAQ_BLOCK_ERROR);
    return;
  }

  await updateKnowledgeSuggestion(id, {
    question,
    answer,
    intent: intent || undefined,
    variations,
    priority: Number.isFinite(priority) ? priority : 100,
    action,
    active
  });
  await redirectInbox(res, phone);
}

async function handleKnowledgeDelete(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }
  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const id = form.get("id");
  if (id) await deleteKnowledgeSuggestion(id);
  await redirectInbox(res, form.get("phone") ?? "");
}

async function handleInboxTakeover(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  if (!isValidWhatsAppPhone(phone)) {
    await redirectInbox(res, "", "Telefono invalido.");
    return;
  }

  await setConversationHumanMode(phone, true);
  setMemoryHumanMode(phone, true);
  await redirectInbox(res, phone);
}

async function handleInboxRelease(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  if (!isValidWhatsAppPhone(phone)) {
    await redirectInbox(res, "", "Telefono invalido.");
    return;
  }

  await setConversationHumanMode(phone, false);
  setMemoryHumanMode(phone, false);
  await redirectInbox(res, phone);
}

async function handleInboxReprompt(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  if (!isValidWhatsAppPhone(phone)) {
    await redirectInbox(res, "", "Telefono invalido.");
    return;
  }

  const session = await getPatientSession(phone);
  if (!session) {
    await redirectInbox(res, phone, "No hay un flujo activo para reenviar.");
    return;
  }

  try {
    await continueActiveSession(phone, session);
    await redirectInbox(res, phone);
  } catch (error) {
    logSafeError(`Could not resend active session prompt to ${maskPhone(phone)}`, error);
    await redirectInbox(res, phone, "No se pudo reenviar el paso actual por WhatsApp.");
  }
}

async function handleInboxResetSession(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  if (!isValidWhatsAppPhone(phone)) {
    await redirectInbox(res, "", "Telefono invalido.");
    return;
  }

  await deletePatientSession(phone);
  try {
    await saveConversationNote({
      phoneNumber: phone,
      author: "admin",
      body: "Flujo del bot reiniciado desde el inbox."
    });
  } catch (error) {
    logSafeError("Could not save reset session note", error);
  }
  await redirectInbox(res, phone);
}

async function handleInboxRepairBot(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  if (!isValidWhatsAppPhone(phone)) {
    await redirectInbox(res, "", "Telefono invalido.");
    return;
  }

  const actions = [];
  await deletePatientSession(phone);
  actions.push("flujo reiniciado");

  try {
    await setConversationHumanMode(phone, false);
    setMemoryHumanMode(phone, false);
    actions.push("bot reactivado");
  } catch (error) {
    logSafeError(`Could not release human mode while repairing ${maskPhone(phone)}`, error);
  }

  try {
    await cleanupExpiredAppointmentLocks();
    const releaseResult = await releaseAppointmentLocksForPhone(phone);
    actions.push(releaseResult?.ok ? "apartados temporales liberados" : "apartados temporales revisados");
  } catch (error) {
    logSafeError(`Could not release appointment locks while repairing ${maskPhone(phone)}`, error);
  }

  try {
    const existing = conversations.get(phone);
    const blockedTags = new Set([
      "Bot no entendio",
      "Paciente atorada",
      "Humano requerido",
      "Modo humano",
      "Resultados pendientes"
    ].map((tag) => normalizeText(tag)));
    const cleanedTags = [
      ...new Set([
        ...((existing?.tags ?? []).filter((tag) => !blockedTags.has(normalizeText(tag)))),
        "Bot reparado"
      ])
    ].slice(0, 12);

    if (existing) {
      existing.tags = cleanedTags;
      existing.updatedAt = new Date().toISOString();
      conversations.set(phone, existing);
    }
    await setConversationTags(phone, cleanedTags);
    actions.push("etiquetas de bloqueo limpiadas");
  } catch (error) {
    logSafeError(`Could not clean blocking tags while repairing ${maskPhone(phone)}`, error);
  }

  try {
    await saveConversationNote({
      phoneNumber: phone,
      author: "admin",
      body: `Bot reparado desde inbox: ${actions.join(", ")}. Se envio menu para retomar sin perder la conversacion.`
    });
  } catch (error) {
    logSafeError("Could not save repair note", error);
  }

  try {
    await sendGreetingMenuToPatient(phone);
  } catch (error) {
    logSafeError(`Could not send repair menu to ${maskPhone(phone)}`, error);
    await redirectInbox(res, phone, "Repare el flujo, pero no pude enviar el menu por WhatsApp.");
    return;
  }

  await redirectInbox(res, phone, "Bot reparado: flujo reiniciado, bot activo, etiquetas limpiadas y menu enviado.");
}

async function handleInboxQuickCheck(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  try {
    await cleanupExpiredAppointmentLocks();
  } catch (error) {
    logSafeError("Could not cleanup expired locks during inbox quick check", error);
  }

  const diagnostics = await buildInboxDiagnostics();
  const lines = [
    `Revision rapida — ${new Date().toISOString()}`,
    ...diagnostics.items.map((item) => `${item.ok ? "OK" : "REVISAR"} ${item.label}: ${item.detail}`),
    `Locks activos: ${diagnostics.activeLocksCount}`
  ].join("\n");

  await persistDailyReport({
    date: new Intl.DateTimeFormat("en-CA", { timeZone: config.clinicTimezone }).format(new Date()),
    text: lines,
    body: lines,
    title: "Revision rapida",
    source: "quick_check",
    author: "inbox",
    generatedAt: new Date().toISOString()
  });

  await redirectInbox(
    res,
    "",
    diagnostics.ready
      ? "Revision rapida lista: WhatsApp, Supabase, Google, correo e inbox se ven correctos."
      : "Revision rapida lista: hay puntos por revisar en Diagnostico rapido.",
    diagnostics.ready ? "success" : "error"
  );
}

async function handleInboxDailyReport(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const todayISO = new Intl.DateTimeFormat("en-CA", { timeZone: config.clinicTimezone }).format(new Date());
  const mode = String(form.get("mode") ?? "generate");
  if (mode === "manual") {
    try {
      const entry = buildManualDailyReportEntry({
        dateISO: form.get("date") || todayISO,
        title: form.get("title"),
        body: form.get("body"),
        author: "inbox"
      });
      await persistDailyReport(entry);
      await redirectInbox(res, "", "Reporte escrito guardado.", "success", { tab: "reports" });
    } catch (error) {
      if (error?.message === "daily_report_body_required") {
        await redirectInbox(res, "", "Escribe el reporte antes de guardarlo.", "error", { tab: "reports" });
        return;
      }
      logSafeError("Could not save manual daily report from inbox", error);
      await redirectInbox(res, "", "No se pudo guardar el reporte escrito. Revisa Supabase o intenta de nuevo.", "error", { tab: "reports" });
    }
    return;
  }

  try {
    await sendDailyReport(todayISO);
    await redirectInbox(res, "", "Reporte generado. Si ENABLE_DAILY_REPORT=true tambien se envio al numero admin.", "success", { tab: "reports" });
  } catch (error) {
    logSafeError("Could not generate daily report from inbox", error);
    await redirectInbox(res, "", "No se pudo generar el reporte diario. Revisa logs de Render.", "error", { tab: "reports" });
  }
}

async function handleInboxResolveUrgent(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  if (!isValidWhatsAppPhone(phone)) {
    await redirectInbox(res, "", "Telefono invalido.");
    return;
  }

  const existing = conversations.get(phone) ?? { phoneNumber: phone, messages: [], updatedAt: new Date().toISOString(), tags: [] };
  const nextTags = markUrgentTagsResolved(existing.tags ?? []);
  existing.tags = nextTags;
  conversations.set(phone, existing);

  await setConversationTags(phone, nextTags);
  await recordConversationMessage(phone, "admin", "Urgencia marcada como resuelta desde el inbox.", {
    source: "inbox_resolve_urgent",
    internal: true
  });
  await saveConversationNote({
    phoneNumber: phone,
    author: "admin",
    body: "Urgencia marcada como resuelta desde el inbox. La conversacion baja de prioridad."
  });

  await redirectInbox(res, phone, "Urgencia marcada como resuelta. La conversacion ya no se queda hasta arriba.", "success");
}

async function handleInboxResolveConversation(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  if (!isValidWhatsAppPhone(phone)) {
    await redirectInbox(res, "", "Telefono invalido.");
    return;
  }

  const existing = conversations.get(phone) ?? { phoneNumber: phone, messages: [], updatedAt: new Date().toISOString(), tags: [] };
  const nextTags = markConversationResolved(existing.tags ?? []);
  existing.tags = nextTags;
  existing.botPaused = false;
  existing.assignedTo = undefined;
  existing.updatedAt = new Date().toISOString();
  conversations.set(phone, existing);

  await setConversationHumanMode(phone, false);
  setMemoryHumanMode(phone, false);
  await setConversationTags(phone, nextTags);
  await recordConversationMessage(phone, "admin", "Caso marcado como resuelto desde el inbox.", {
    source: "inbox_resolve_conversation",
    internal: true
  });
  await saveConversationNote({
    phoneNumber: phone,
    author: "admin",
    body: "Caso marcado como resuelto desde el inbox. Si la paciente vuelve a escribir, regresara a pendientes."
  });

  await redirectInbox(res, phone, "Conversacion marcada como resuelta. Si la paciente escribe de nuevo, volvera a pendientes.", "success");
}

async function handleInboxSendTemplate(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  if (!isValidWhatsAppPhone(phone)) {
    await redirectInbox(res, "", "Telefono invalido.");
    return;
  }

  const conversation = (await loadConversationForInboxSend(phone)) ?? conversations.get(phone);
  const template = buildInboxMetaTemplate(form.get("template"), conversation, phone);
  if (!template.ok) {
    await redirectInbox(res, phone, template.error);
    return;
  }

  try {
    await sendWhatsAppTemplate(phone, template.name, config.whatsappTemplateLanguage, template.parameters);
    await markConversationHumanReply(phone);
    await recordConversationMessage(phone, "human", `Plantilla Meta enviada: ${template.label}.`, {
      source: "inbox_template",
      templateType: template.type
    });
    await saveConversationNote({
      phoneNumber: phone,
      author: "admin",
      body: `Plantilla Meta enviada: ${template.label}.`
    });
    await redirectInbox(res, phone, `Plantilla enviada: ${template.label}.`, "success");
  } catch (error) {
    logSafeError(`Could not send Meta template to ${maskPhone(phone)}`, error);
    await redirectInbox(res, phone, classifyWhatsAppInboxSendError(error));
  }
}

async function handleInboxTags(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  const tags = parseTags(form.get("tags"));
  if (!isValidWhatsAppPhone(phone)) {
    await redirectInbox(res, "", "Telefono invalido.");
    return;
  }

  const existing = conversations.get(phone) ?? { phoneNumber: phone, messages: [], updatedAt: new Date().toISOString() };
  existing.tags = tags;
  conversations.set(phone, existing);
  await setConversationTags(phone, tags);
  await redirectInbox(res, phone);
}

async function handleInboxNote(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  const body = String(form.get("note") ?? "").trim();
  if (!isValidWhatsAppPhone(phone)) {
    await redirectInbox(res, "", "Telefono invalido.");
    return;
  }
  if (body.length < 2) {
    await redirectInbox(res, phone, "Escribe una nota interna antes de guardarla.");
    return;
  }

  const note = {
    body: body.slice(0, 2000),
    author: "consultorio",
    createdAt: new Date().toISOString()
  };
  const existing = conversations.get(phone) ?? { phoneNumber: phone, messages: [], updatedAt: new Date().toISOString() };
  existing.notes = [note, ...(existing.notes ?? [])].slice(0, 20);
  conversations.set(phone, existing);

  try {
    await saveConversationNote({ phoneNumber: phone, body: note.body, author: note.author });
  } catch (error) {
    logSafeError("Could not save internal note", error);
    await redirectInbox(res, phone, "No pude guardar la nota interna. Revisa Supabase.");
    return;
  }

  await redirectInbox(res, phone);
}

async function handleInboxCancelDay(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const dateISO = String(form.get("date") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) {
    await redirectInbox(res, "", "Fecha invalida.");
    return;
  }

  let citas;
  try {
    citas = await loadConfirmedCitasByDay(dateISO);
  } catch (error) {
    logSafeError("Could not load citas for cancel-day", error);
    await redirectInbox(res, "", "No se pudo cargar las citas del dia.");
    return;
  }

  const cancelMsg = form.get("message")?.trim() || `Lo sentimos, las citas del ${dateISO} han sido canceladas. Por favor contáctanos para reagendar.`;
  let cancelled = 0;
  let errors = 0;
  let notifiedWhatsApp = 0;
  let notifiedEmail = 0;
  const needManualContact = [];

  for (const cita of citas) {
    try {
      if (cita.googleEventId) await cancelAppointment(cita.googleEventId);
      await cancelCita(cita.id);
      cancelled++;

      // Notify the patient through a Meta-compliant channel only.
      const notified = await notifyPatientOfDayCancellation(cita, cancelMsg, dateISO);
      if (notified === "whatsapp") notifiedWhatsApp++;
      else if (notified === "email") notifiedEmail++;
      else if (notified === "manual" && cita.phoneNumber) needManualContact.push(maskPhone(cita.phoneNumber));
    } catch (error) {
      logSafeError(`Could not cancel cita ${cita.id}`, error);
      errors++;
    }
  }

  let summary = `Canceladas: ${cancelled} de ${citas.length}. Avisadas por WhatsApp: ${notifiedWhatsApp}. Por correo: ${notifiedEmail}.`;
  if (needManualContact.length > 0) {
    summary += ` ⚠️ ${needManualContact.length} requieren llamada (fuera de ventana 24h, sin correo): ${needManualContact.join(", ")}.`;
  }
  if (errors > 0) summary += ` Errores: ${errors}.`;
  await persistDailyReport({
    date: dateISO,
    title: "Cancelacion masiva",
    text: `[Cancelacion masiva] ${summary}`,
    body: `[Cancelacion masiva] ${summary}`,
    source: "bulk_cancel",
    author: "inbox",
    generatedAt: new Date().toISOString()
  });
  await redirectInbox(res, "", summary);
}

// Returns "whatsapp" | "email" | "manual" | "none" depending on which
// Meta-compliant channel was used to notify the patient of a cancellation.
async function notifyPatientOfDayCancellation(cita, cancelMsg, dateISO) {
  if (cita.phoneNumber) {
    const windowState = getWhatsAppWindowState(conversations.get(cita.phoneNumber));

    if (windowState.key === "open" || windowState.key === "closing") {
      await safeSendWhatsAppText(cita.phoneNumber, cancelMsg);
      await recordConversationMessage(cita.phoneNumber, "bot", cancelMsg);
      return "whatsapp";
    }

    if (config.whatsappCancellationTemplate) {
      try {
        await sendWhatsAppTemplate(
          cita.phoneNumber,
          config.whatsappCancellationTemplate,
          config.whatsappTemplateLanguage,
          [cita.patientName ?? "Paciente"]
        );
        await recordConversationMessage(cita.phoneNumber, "bot", `[Plantilla de cancelacion enviada para ${dateISO}]`);
        return "whatsapp";
      } catch (error) {
        logSafeError(`Cancellation template failed for ${maskPhone(cita.phoneNumber)}`, error);
      }
    }
  }

  if (cita.patientEmail && isEmailEnabled()) {
    try {
      await sendCancellationEmail({
        to: cita.patientEmail,
        name: cita.patientName ?? "Paciente",
        slotLabel: formatAppointmentFull(cita.slotStart),
        clinicName: config.clinicName
      });
      return "email";
    } catch (error) {
      logSafeError("Cancellation email failed", error);
    }
  }

  return "manual";
}

function parseTags(value) {
  return String(value ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length >= 2)
    .slice(0, 12);
}

function markUrgentTagsResolved(tags = []) {
  const kept = (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag ?? "").trim())
    .filter((tag) => {
      const normalized = normalizeText(tag);
      return normalized !== "urgente" && normalized !== "urgencia";
    });

  return [...new Set([...kept, "Urgente resuelto"])].slice(0, 12);
}

function markConversationResolved(tags = []) {
  const resolvedBlockers = new Set([
    "urgente",
    "urgencia",
    "bot no entendio",
    "humano requerido",
    "modo humano",
    "resultados",
    "resultados pendientes",
    "reagendar",
    "cancelar",
    "template meta",
    "requiere template meta",
    "paciente atorada"
  ]);
  const kept = (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag ?? "").trim())
    .filter((tag) => {
      const normalized = normalizeText(tag);
      return tag && !resolvedBlockers.has(normalized);
    });

  return [...new Set([...kept, "Resuelto"])].slice(0, 12);
}

function buildInboxMetaTemplate(type, conversation, phone) {
  const normalizedType = normalizeText(type);
  const appointment = conversation?.appointment;
  const fallbackName = firstName(conversation ? getConversationDisplayName(conversation) : formatPhoneForInbox(phone));
  const patientName = appointment?.patientName ?? fallbackName ?? "Paciente";
  const slotLabel = appointment?.slotStart ? formatAppointmentFull(appointment.slotStart) : "";

  if (normalizedType === "reengagement") {
    if (!config.whatsappReengagementTemplate) {
      return { ok: false, error: "Falta configurar WHATSAPP_REENGAGEMENT_TEMPLATE en Render despues de aprobar la plantilla en Meta." };
    }
    return {
      ok: true,
      type: "reengagement",
      label: "Retomar conversacion",
      name: config.whatsappReengagementTemplate,
      parameters: [firstName(patientName) || "Paciente"]
    };
  }

  if (normalizedType === "results_email") {
    const emailRecipient = resolveResultsEmailRecipient({ appointment, conversation });
    if (!isValidPatientEmail(emailRecipient.email)) {
      return { ok: false, error: "Esta paciente no tiene correo confirmado para enviar aviso de resultados." };
    }
    if (!config.whatsappResultsEmailTemplate) {
      return { ok: false, error: "Falta configurar WHATSAPP_RESULTS_EMAIL_TEMPLATE en Render despues de aprobar la plantilla en Meta." };
    }
    return {
      ok: true,
      type: "results_email",
      label: "Aviso de resultados por correo",
      name: config.whatsappResultsEmailTemplate,
      parameters: [firstName(patientName) || "Paciente", maskEmail(emailRecipient.email)]
    };
  }

  if (normalizedType === "appointment_reminder") {
    if (!appointment?.slotStart) {
      return { ok: false, error: "No hay cita registrada para enviar plantilla de recordatorio." };
    }
    if (!config.whatsappReminderTemplate24h) {
      return { ok: false, error: "Falta configurar WHATSAPP_REMINDER_TEMPLATE_24H en Render despues de aprobar la plantilla en Meta." };
    }
    return {
      ok: true,
      type: "appointment_reminder",
      label: "Recordatorio de cita",
      name: config.whatsappReminderTemplate24h,
      parameters: [patientName, slotLabel]
    };
  }

  if (normalizedType === "cancellation") {
    if (!appointment?.slotStart) {
      return { ok: false, error: "No hay cita registrada para enviar plantilla de cancelacion." };
    }
    if (!config.whatsappCancellationTemplate) {
      return { ok: false, error: "Falta configurar WHATSAPP_CANCELLATION_TEMPLATE en Render despues de aprobar la plantilla en Meta." };
    }
    return {
      ok: true,
      type: "cancellation",
      label: "Cancelacion de cita",
      name: config.whatsappCancellationTemplate,
      parameters: [patientName]
    };
  }

  if (normalizedType === "reschedule") {
    if (!config.whatsappRescheduleTemplate) {
      return { ok: false, error: "Falta configurar WHATSAPP_RESCHEDULE_TEMPLATE en Render despues de aprobar la plantilla en Meta." };
    }
    return {
      ok: true,
      type: "reschedule",
      label: "Reagendar cita",
      name: config.whatsappRescheduleTemplate,
      parameters: [firstName(patientName) || "Paciente"]
    };
  }

  return { ok: false, error: "Plantilla no reconocida." };
}

function hasInboxAccess(req, url, res, options = {}) {
  if (!config.inboxPassword && !config.inboxPasswordHash) {
    res
      .writeHead(403, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Configura INBOX_PASSWORD en las variables de entorno para acceder al inbox");
    return false;
  }

  const session = getInboxSession(req);
  if (session) return true;

  if (config.inboxAllowLegacyTokenAccess) {
    const token = url.searchParams.get("token");
    if (token && isValidInboxPassword(token)) {
      setInboxCookie(res);
      url.searchParams.delete("token");
      res.writeHead(303, { Location: `${url.pathname}${url.search || ""}` }).end();
      return false;
    }

    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ") && isValidInboxPassword(auth.slice("Bearer ".length))) {
      return true;
    }
  }

  if (options.redirectToLogin) {
    res.writeHead(303, { Location: "/inbox/login" }).end();
    return false;
  }

    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return false;
}

function handleInboxLoginPage(req, res, error = "") {
  const csrf = createLoginCsrfToken();
  setLoginCsrfCookie(res, csrf);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Entrar al inbox</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #0d2240; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      background:
        linear-gradient(135deg, rgba(13, 61, 114, 0.78), rgba(26, 95, 168, 0.42)),
        url('/public/dra_carranza_banner.png') center center / cover no-repeat fixed;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    main { width: min(430px, 100%); background: rgba(255, 255, 255, 0.96); border: 1px solid #bfd6f0; border-radius: 24px; padding: 30px; box-shadow: 0 24px 64px rgba(13, 61, 114, 0.32); backdrop-filter: blur(8px); }
    .login-photo {
      width: 118px;
      height: 118px;
      margin: 0 auto 18px;
      border-radius: 999px;
      overflow: hidden;
      border: 4px solid #ffffff;
      box-shadow: 0 16px 34px rgba(13, 61, 114, 0.22);
      background: #ddeeff;
    }
    .login-photo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center top;
      display: block;
    }
    .login-copy { text-align: center; }
    h1 { margin: 0 0 8px; font-size: 24px; color: #0d3d72; }
    p { margin: 0 0 22px; color: #4a6a8a; line-height: 1.45; }
    label { display: block; font-weight: 700; font-size: 14px; margin-bottom: 8px; }
    input { width: 100%; border: 1px solid #9fc5ef; border-radius: 14px; padding: 12px; font: inherit; color: #0d2240; }
    input:focus { border-color: #1a5fa8; box-shadow: 0 0 0 4px rgba(26, 95, 168, 0.12); outline: none; }
    button { width: 100%; margin-top: 14px; border: 0; border-radius: 14px; padding: 12px; background: linear-gradient(135deg, #1a5fa8, #60a5fa); color: white; font: inherit; font-weight: 800; cursor: pointer; box-shadow: 0 12px 24px rgba(26, 95, 168, 0.2); }
    .error { margin-bottom: 14px; padding: 10px 12px; border-radius: 10px; color: #991b1b; background: #fee2e2; border: 1px solid #fecaca; }
  </style>
</head>
<body>
  <main>
    <div class="login-photo">
      <img src="${config.inboxDoctorImageUrl ? escapeHtml(config.inboxDoctorImageUrl) : "/public/dra_carranza_banner.png"}" alt="Dra. Carranza">
    </div>
    <div class="login-copy">
      <h1>Inbox del bot</h1>
      <p>Consultorio virtual Dra. Carranza. Entra con la clave privada.</p>
    </div>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/inbox/login">
      <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
      <label for="password">Clave</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
      <button type="submit">Entrar</button>
    </form>
  </main>
</body>
</html>`);
}

function handlePrivacyPage(res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Politica de privacidad</title>
  <style>
    :root { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #0d2240; background: #f5f9ff; }
    body { margin: 0; padding: 32px 18px; }
    main { max-width: 860px; margin: 0 auto; background: #fff; border: 1px solid #bfd6f0; border-radius: 18px; padding: clamp(22px, 5vw, 42px); box-shadow: 0 18px 50px rgba(13, 61, 114, 0.1); }
    h1 { margin-top: 0; color: #0d3d72; }
    h2 { margin-top: 28px; color: #244a73; }
    p, li { line-height: 1.65; }
    ul { padding-left: 22px; }
    .muted { color: #4a6a8a; }
  </style>
</head>
<body>
  <main>
    <h1>Politica de privacidad</h1>
    <p class="muted">Ultima actualizacion: 18 de junio de 2026</p>
    <p>Este canal de WhatsApp se usa para atender solicitudes administrativas del consultorio, como informacion general, ubicacion, costos, disponibilidad, agenda, reagenda y cancelacion de citas.</p>

    <h2>Datos que podemos tratar</h2>
    <ul>
      <li>Nombre, telefono y correo del paciente cuando se comparten por WhatsApp.</li>
      <li>Mensajes necesarios para dar seguimiento a la conversacion.</li>
      <li>Datos administrativos de cita, como fecha, hora, estado de la cita y confirmaciones.</li>
    </ul>

    <h2>Uso de la informacion</h2>
    <p>La informacion se usa para responder mensajes, coordinar citas, guardar historial operativo del inbox y notificar al consultorio cuando una conversacion requiere atencion humana.</p>

    <h2>Servicios involucrados</h2>
    <p>Para operar este canal se pueden usar servicios de Meta/WhatsApp, Google Calendar, Supabase y Render. Estos proveedores procesan datos solo para entregar la funcionalidad tecnica del servicio.</p>

    <h2>Informacion medica sensible</h2>
    <p>Este canal no sustituye una consulta medica y no debe usarse como expediente clinico. El bot no diagnostica, no receta medicamentos y no atiende emergencias. En caso de urgencia, dolor fuerte, sangrado abundante o sintomas graves, se debe acudir a urgencias o contactar directamente al consultorio.</p>
    <p>Por privacidad, los resultados o estudios se entregan unicamente por el correo confirmado de la paciente o de forma presencial. Por WhatsApp solo se registra la solicitud y se pasa a revision humana.</p>

    <h2>Conservacion y seguridad</h2>
    <p>El acceso al inbox esta protegido con autenticacion. Los datos se conservan solo para seguimiento operativo del consultorio y deben manejarse conforme al aviso de privacidad formal del consultorio.</p>

    <h2>Contacto</h2>
    <p>Para solicitar informacion sobre el manejo de datos, contacta directamente al consultorio.</p>
  </main>
</body>
</html>`);
}

async function handleInboxLogin(req, res) {
  if (!config.inboxPassword && !config.inboxPasswordHash) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Configura INBOX_PASSWORD");
    return;
  }

  if (!checkRateLimit(req, new URL("/inbox/login", "http://local"), "inbox-login")) {
    handleInboxLoginPage(req, res, "No se pudo iniciar sesion. Intenta de nuevo mas tarde.");
    return;
  }

  const params = await readForm(req, { maxBytes: config.maxRequestBytes });
  if (!isValidLoginCsrf(req, params.get("csrf"))) {
    handleInboxLoginPage(req, res, "No se pudo iniciar sesion.");
    return;
  }

  const password = params.get("password") ?? "";
  if (!isValidInboxPassword(password)) {
    handleInboxLoginPage(req, res, "No se pudo iniciar sesion.");
    return;
  }

  setInboxCookie(res);
  res.writeHead(303, { Location: "/inbox" }).end();
}

function setInboxCookie(res) {
  const maxAge = Math.max(1, config.inboxSessionHours) * 60 * 60;
  const cookie = [
    `inbox_session=${createInboxSessionToken(maxAge)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`
  ];
  if (config.nodeEnv === "production") cookie.push("Secure");
  res.setHeader("Set-Cookie", cookie.join("; "));
}

function clearInboxCookie(res) {
  res.setHeader("Set-Cookie", "inbox_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function getInboxSession(req) {
  const token = parseCookies(req.headers.cookie ?? "").inbox_session;
  if (!token) return null;

  const [payloadPart, signature] = token.split(".");
  if (!payloadPart || !signature) return null;

  const expected = crypto.createHmac("sha256", getCookieSecret()).update(payloadPart).digest("base64url");
  if (!secureCompare(signature, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function createInboxSessionToken(maxAgeSeconds) {
  const payloadPart = Buffer.from(
    JSON.stringify({
      exp: Date.now() + maxAgeSeconds * 1000,
      nonce: crypto.randomBytes(12).toString("hex")
    })
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", getCookieSecret()).update(payloadPart).digest("base64url");
  return `${payloadPart}.${signature}`;
}

function parseCookies(cookieHeader) {
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const equals = part.indexOf("=");
        if (equals === -1) return [part, ""];
        return [part.slice(0, equals), decodeURIComponent(part.slice(equals + 1))];
      })
  );
}

async function getInboxConversations() {
  if (isDatabaseEnabled()) {
    try {
      const savedConversations = await loadConversations();
      if (savedConversations) {
        conversations.clear();
        for (const conversation of savedConversations) conversations.set(conversation.phoneNumber, conversation);
        return savedConversations;
      }
    } catch (error) {
      logSafeError("Could not load conversations from Supabase; using memory fallback", error);
    }
  }

  return [...conversations.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function renderInboxPage(list, selected, req, url, knowledgeSuggestions = [], diagnostics, dailyReports = dailyReportsLog) {
  const csrf = createSessionCsrfToken(req);
  const q = normalizeText(url.searchParams.get("q") ?? "");
  const filter = url.searchParams.get("filter") ?? "all";
  const sideTab = normalizeInboxTab(url.searchParams.get("tab"));
  const newestPatientFirst = ["all", "pending", "followup"].includes(filter);
  const filteredList = sortInboxConversations(filterInboxConversationList(list, q, filter), Date.now(), { newestPatientFirst });
  if (selected && !filteredList.some((conversation) => conversation.phoneNumber === selected.phoneNumber)) {
    filteredList.unshift(selected);
  }
  const stats = buildInboxMetrics(list);
  const operationalStatus = renderOperationalStatusBadges();
  const selectedStatus = selected ? getInboxConversationStatus(selected) : undefined;
  const selectedName = selected ? getConversationDisplayName(selected) : "";
  const appointmentCard = selected?.appointment ? renderAppointmentCard(selected.appointment) : "";
  const inboxError = url.searchParams.get("error");
  const inboxSuccess = url.searchParams.get("success");
  const selectedPhone = selected?.phoneNumber ?? "";
  const windowState = selected ? getWhatsAppWindowState(selected) : undefined;
  const needsTemplateNotice = windowState?.key === "expired";
  const closingTemplateNotice = windowState?.key === "closing";
  const quickReplies = selected ? renderQuickReplies() : "";
  const rightPanel = renderPatientPanel(selected, { csrf, selectedPhone, selectedStatus, windowState, knowledgeSuggestions });
  const filterOptions = renderInboxQuickFilters(filter, url.searchParams.get("q") ?? "");
  const diagnosticsCard = renderInboxDiagnostics(diagnostics, csrf);
  const sidebarTabs = renderInboxTabs(sideTab, { phone: selectedPhone, q: url.searchParams.get("q"), filter });
  const doctorImageSrc = config.inboxDoctorImageUrl || "/public/dra_carranza_banner.png";
  const crmDashboard = renderCrmDashboard(list);
  const receptionDesk = renderReceptionDesk(list, { currentFilter: filter, query: url.searchParams.get("q") ?? "" });
  const crmPipeline = renderCrmPipeline(list, { currentFilter: filter, query: url.searchParams.get("q") ?? "" });
  const conversationLinks =
    filteredList.length === 0
      ? `<div class="empty-state">Todavia no hay conversaciones.</div>`
      : filteredList
          .map((conversation) => {
            const last = conversation.messages.at(-1);
            const active = selected?.phoneNumber === conversation.phoneNumber ? " active" : "";
            const status = getInboxConversationStatus(conversation);
            const conversationWindow = getWhatsAppWindowState(conversation);
            const title = getConversationDisplayName(conversation);
            const activityAt = getConversationActivityISO(conversation) ?? conversation.updatedAt;
            return `<a class="thread${active}" href="/inbox?${buildInboxQuery({ phone: conversation.phoneNumber, q: url.searchParams.get("q"), filter })}">
              <div class="avatar">${escapeHtml(conversation.phoneNumber.slice(-2))}</div>
              <div class="thread-copy">
                <div class="thread-top">
                  <strong>${escapeHtml(title)}</strong>
                  <span>${formatInboxDate(activityAt)}</span>
                </div>
                <div class="thread-sub">${escapeHtml(formatPhoneForInbox(conversation.phoneNumber))}</div>
                <p>${escapeHtml(last?.body ?? "")}</p>
                <div class="thread-tags">
                  <span class="tag ${status.className}">${status.label}</span>
                  ${conversationWindow.key === "closing" ? `<span class="tag closing">24h por cerrar</span>` : ""}
                  ${conversationWindow.key === "expired" ? `<span class="tag expired">Fuera de 24h</span>` : ""}
                  ${conversation.botPaused ? `<span class="tag human">Modo humano</span>` : ""}
                  ${uniqueInboxTagLabels(conversation.tags ?? []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
                  ${conversation.appointment?.slotStart ? `<span class="tag">${formatAppointmentShort(conversation.appointment.slotStart)}</span>` : ""}
                </div>
              </div>
            </a>`;
          })
          .join("");
  const patientsSidebar = `${renderInboxDiagnosticsCompact(diagnostics)}
      ${crmDashboard}
      ${receptionDesk}
      ${crmPipeline}
      ${renderTodayMetrics(list)}
      ${renderConversionMetrics(list)}
      <form class="tools" method="get" action="/inbox">
        <input name="tab" type="hidden" value="patients">
        <input name="q" value="${escapeHtml(url.searchParams.get("q") ?? "")}" placeholder="Buscar nombre, telefono, etiqueta o estado">
        <div class="tool-row">
          <select name="filter">
            ${renderFilterOption("all", "Todas", filter)}
            ${renderFilterOption("priority", "Prioridad", filter)}
            ${renderFilterOption("urgent", "Urgente", filter)}
            ${renderFilterOption("misunderstood", "Bot no entendio", filter)}
            ${renderFilterOption("awaiting_confirmation", "Esperando confirmacion", filter)}
            ${renderFilterOption("reschedule", "Reagendar", filter)}
            ${renderFilterOption("cancel", "Cancelar", filter)}
            ${renderFilterOption("closing_window", "Ventana 24h", filter)}
            ${renderFilterOption("pending", "Pendientes", filter)}
            ${renderFilterOption("stuck", "Atoradas", filter)}
            ${renderFilterOption("waiting", "Esperando datos", filter)}
            ${renderFilterOption("confirmed", "Cita agendada", filter)}
            ${renderFilterOption("no_appointment", "Sin cita", filter)}
            ${renderFilterOption("new_patient", "Primera vez", filter)}
            ${renderFilterOption("returning_patient", "Recurrentes", filter)}
            ${renderFilterOption("human", "Modo humano", filter)}
            ${renderFilterOption("resolved", "Resueltas", filter)}
          </select>
          <button type="submit">Filtrar</button>
        </div>
      </form>
      ${filterOptions}
      <div class="contacts-table-head"><span>Paciente</span><span>Estado</span></div>
      ${conversationLinks}`;
  const sidebarContent =
    sideTab === "diagnostics"
      ? `${diagnosticsCard}${renderConversionMetrics(list)}`
      : sideTab === "reports"
        ? `${renderReceptionReport(list)}${renderDailyReportsSection(dailyReports, csrf)}`
        : sideTab === "tools"
          ? `${renderTodayMetrics(list)}${renderCancelDaySection(csrf)}`
          : patientsSidebar;

  const messages = selected
    ? selected.messages
        .map((message) => {
          const side = message.sender === "bot" ? "bot" : message.sender === "human" || message.sender === "admin" ? "human" : "patient";
          const label = message.sender === "bot" ? "Bot" : message.sender === "human" || message.sender === "admin" ? "Humano" : "Paciente";
          const media = renderInboxMessageMedia(message.metadata?.media);
          return `<div class="message ${side}">
            <div class="bubble">
              <div class="meta">${label} · ${formatInboxDate(message.timestamp)}</div>
              <div class="body">${escapeHtml(message.body).replaceAll("\n", "<br>")}</div>
              ${media}
            </div>
          </div>`;
        })
        .join("")
    : `<div class="empty-chat">
        <div class="empty-card">
          <div class="empty-icon">💬</div>
          <h2>Selecciona una conversacion</h2>
          <p>Cuando llegue un mensaje, aqui veras la platica completa entre el paciente y el bot.</p>
        </div>
      </div>`;

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>Inbox del bot</title>
  <script src="/inbox.js" defer></script>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f8fb;
      color: #0d2240;
      --line: #d9e4f2;
      --muted: #4a6a8a;
      --brand: #1a5fa8;
      --brand-dark: #0d3d72;
      --brand-soft: #ddeeff;
      --brand-pale: #f0f7ff;
      --surface: #ffffff;
      --soft: #f7faff;
      --shadow: rgba(15, 23, 42, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      overflow-x: hidden;
      background:
        radial-gradient(circle at 12% 0%, rgba(96, 165, 250, 0.18), transparent 28rem),
        radial-gradient(circle at 92% 12%, rgba(14, 165, 233, 0.1), transparent 24rem),
        linear-gradient(180deg, #ffffff 0%, #f6f8fb 42%, #edf4fb 100%);
    }
    .crm-rail {
      position: fixed;
      inset: 0 auto 0 0;
      z-index: 20;
      width: 84px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 14px 10px;
      border-right: 1px solid #d9e4f2;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 10px 0 34px rgba(15, 23, 42, 0.05);
    }
    .rail-logo {
      display: grid;
      place-items: center;
      width: 46px;
      height: 46px;
      border-radius: 16px;
      background: linear-gradient(135deg, #1a5fa8, #60a5fa);
      color: #ffffff;
      font-weight: 900;
      letter-spacing: -0.02em;
      box-shadow: 0 12px 24px rgba(26, 95, 168, 0.2);
      margin-bottom: 8px;
    }
    .rail-item {
      display: grid;
      place-items: center;
      gap: 5px;
      width: 64px;
      min-height: 62px;
      padding: 7px 4px;
      border-radius: 16px;
      color: #54708c;
      text-decoration: none;
      font-size: 10px;
      font-weight: 850;
      text-align: center;
      transition: background .15s ease, color .15s ease, transform .15s ease;
    }
    .rail-item span {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 10px;
      background: #eef4fb;
      color: #0d3d72;
      font-size: 13px;
      font-weight: 900;
    }
    .rail-item:hover {
      background: #f0f7ff;
      color: #0d3d72;
      transform: translateY(-1px);
    }
    .rail-item.active {
      background: #e8f1ff;
      color: #0d3d72;
      box-shadow: inset 0 0 0 1px #cfe1f7;
    }
    .rail-item.active span {
      background: #1a5fa8;
      color: #ffffff;
    }
    header {
      height: 66px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-left: 84px;
      padding: 0 24px;
      border-bottom: 1px solid rgba(217, 228, 242, 0.95);
      background: rgba(255, 255, 255, 0.88);
      backdrop-filter: blur(14px);
      position: sticky;
      top: 0;
      z-index: 3;
      box-shadow: 0 10px 30px rgba(15, 23, 42, 0.04);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-mark {
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: linear-gradient(135deg, #1a5fa8, #60a5fa);
      color: #ffffff;
      font-weight: 800;
      font-size: 13px;
      box-shadow: 0 6px 18px rgba(26, 95, 168, 0.28);
      overflow: hidden;
    }
    .brand-mark img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: center top;
      border-radius: 50%;
    }
    .inbox-banner {
      width: auto;
      height: 92px;
      max-height: 92px;
      margin-left: 84px;
      overflow: hidden;
      display: block;
      line-height: 0;
    }
    .inbox-banner img {
      width: 100%;
      height: 92px;
      object-fit: cover;
      object-position: center top;
      display: block;
    }
    h1 {
      font-size: 18px;
      margin: 0;
      line-height: 1.1;
    }
    .subtitle {
      color: var(--muted);
      font-size: 12px;
      margin-top: 4px;
    }
    .status {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 12px;
      font-weight: 650;
    }
    .status a { color: var(--brand-dark); }
    .health-pill {
      border-radius: 999px;
      padding: 7px 10px;
      border: 1px solid #bfd6f0;
      background: #ffffff;
      color: #0d3d72;
      box-shadow: 0 6px 14px rgba(13, 61, 114, 0.06);
      font: inherit;
      text-decoration: none;
    }
    button.health-pill { cursor: pointer; }
    .health-pill.ok { color: #166534; background: #dcfce7; border-color: #bbf7d0; }
    .health-pill.warn { color: #92400e; background: #fef3c7; border-color: #fde68a; }
    .health-pill.err { color: #991b1b; background: #fee2e2; border-color: #fecaca; }
    .metric-strip {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      margin-left: 84px;
      padding: 10px 18px 0;
    }
    .metric-pill {
      flex: 0 0 auto;
      min-width: 102px;
      padding: 10px 12px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.9);
      border: 1px solid rgba(159, 197, 239, 0.86);
      box-shadow: 0 12px 26px rgba(13, 61, 114, 0.08);
    }
    .metric-pill strong { display: block; font-size: 20px; line-height: 1; letter-spacing: -0.03em; }
    .metric-pill span { color: var(--muted); display: block; font-size: 11px; margin-top: 6px; font-weight: 800; }
    .crm-top-banner {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(240px, .85fr) auto;
      align-items: center;
      gap: 16px;
      min-height: 76px;
      margin: 12px 18px 0 102px;
      padding: 14px 16px;
      border-radius: 22px;
      background:
        radial-gradient(circle at 86% 40%, rgba(56, 189, 248, 0.18), transparent 11rem),
        linear-gradient(135deg, #0f172a 0%, #12365f 48%, #0b5ea8 100%);
      color: #ffffff;
      box-shadow: 0 22px 46px rgba(15, 23, 42, 0.18);
      overflow: hidden;
    }
    .crm-top-banner > div { min-width: 0; }
    .crm-top-banner strong {
      display: block;
      font-size: 17px;
      line-height: 1.2;
      letter-spacing: -0.02em;
    }
    .crm-top-banner span {
      display: block;
      margin-top: 3px;
      color: rgba(255, 255, 255, 0.74);
      font-size: 12px;
    }
    .command-kicker {
      display: inline-flex;
      width: fit-content;
      margin: 0 0 6px;
      padding: 5px 9px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.13);
      color: rgba(255, 255, 255, 0.86);
      font-size: 10px;
      font-weight: 950;
      letter-spacing: .1em;
      text-transform: uppercase;
    }
    .crm-top-banner .banner-pill {
      flex: 0 0 auto;
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 999px;
      padding: 8px 12px;
      background: #22c55e;
      color: #052e16;
      font-size: 12px;
      font-weight: 900;
      white-space: nowrap;
    }
    .command-health-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .command-health-grid div {
      min-width: 0;
      padding: 9px 10px;
      border-radius: 15px;
      border: 1px solid rgba(255, 255, 255, 0.17);
      background: rgba(255, 255, 255, 0.11);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }
    .command-health-grid b {
      display: block;
      color: #ffffff;
      font-size: 13px;
      line-height: 1;
    }
    .command-health-grid small {
      display: block;
      margin-top: 5px;
      color: rgba(255, 255, 255, 0.68);
      font-size: 10px;
      font-weight: 800;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .command-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .command-actions a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 34px;
      padding: 8px 11px;
      border-radius: 999px;
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.2);
      background: rgba(255, 255, 255, 0.12);
      text-decoration: none;
      font-size: 11px;
      font-weight: 900;
      white-space: nowrap;
    }
    .command-actions a.primary {
      background: #ffffff;
      color: #0d3d72;
      border-color: transparent;
    }
    main {
      display: grid;
      grid-template-columns: minmax(330px, 400px) minmax(0, 1.22fr) minmax(310px, 370px);
      height: calc(100vh - 268px);
      min-height: 548px;
      margin-left: 84px;
      padding: 14px 18px 18px;
      gap: 14px;
    }
    aside {
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.96);
      overflow: auto;
      border-radius: 20px;
      box-shadow: 0 16px 36px rgba(15, 23, 42, 0.08);
    }
    .sidebar-head {
      padding: 18px 18px 12px;
      border-bottom: 1px solid #bfd6f0;
    }
    .sidebar-head strong {
      display: block;
      font-size: 14px;
    }
    .sidebar-head span {
      color: var(--muted);
      display: block;
      font-size: 12px;
      margin-top: 4px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      padding: 14px;
      border-bottom: 1px solid #dbeafe;
    }
    .stat {
      min-width: 0;
      padding: 10px;
      border-radius: 12px;
      background: var(--soft);
      border: 1px solid #cfe1f7;
    }
    .stat strong { display: block; font-size: 18px; line-height: 1; }
    .stat span { display: block; color: var(--muted); font-size: 11px; margin-top: 5px; }
    .inbox-tabs {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid #dbeafe;
      background: rgba(255, 255, 255, 0.74);
      position: sticky;
      top: 0;
      z-index: 2;
    }
    .inbox-tabs a {
      display: grid;
      place-items: center;
      min-height: 34px;
      padding: 7px 8px;
      border-radius: 999px;
      border: 1px solid #cfe1f7;
      background: #ffffff;
      color: #0d3d72;
      text-decoration: none;
      font-size: 12px;
      font-weight: 800;
      box-shadow: 0 6px 14px rgba(13, 61, 114, 0.06);
    }
    .inbox-tabs a.active {
      background: linear-gradient(135deg, #1a5fa8, #60a5fa);
      border-color: #1a5fa8;
      color: #ffffff;
    }
    .metrics-card {
      margin: 0 14px 14px;
      padding: 12px;
      border: 1px solid #cfe1f7;
      border-radius: 14px;
      background: #eef6ff;
    }
    .metrics-head { margin-bottom: 8px; }
    .metrics-head strong { font-size: 13px; }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 6px;
    }
    .metric-cell {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }
    .metric-cell strong { font-size: 17px; color: #0d3d72; }
    .metric-cell span { font-size: 10px; color: #4a6a8a; text-align: center; }
    .crm-dashboard {
      margin: 12px 14px 14px;
      padding: 12px;
      border: 1px solid #cfe1f7;
      border-radius: 16px;
      background:
        radial-gradient(circle at top right, rgba(96, 165, 250, 0.18), transparent 9rem),
        #ffffff;
      box-shadow: 0 10px 24px rgba(13, 61, 114, 0.07);
    }
    .crm-dashboard-head,
    .pipeline-head {
      display: flex;
      justify-content: space-between;
      align-items: start;
      gap: 10px;
      margin-bottom: 10px;
    }
    .crm-dashboard-head span,
    .pipeline-head span {
      display: block;
      color: #64748b;
      font-size: 10px;
      font-weight: 950;
      letter-spacing: .08em;
      text-transform: uppercase;
      margin-bottom: 3px;
    }
    .crm-dashboard-head strong,
    .pipeline-head strong {
      display: block;
      color: #0d2240;
      font-size: 14px;
      line-height: 1.25;
    }
    .crm-dashboard-head a,
    .pipeline-head a {
      flex: 0 0 auto;
      color: #0d3d72;
      background: #eef6ff;
      border: 1px solid #cfe1f7;
      border-radius: 999px;
      padding: 6px 9px;
      text-decoration: none;
      font-size: 11px;
      font-weight: 900;
    }
    .crm-dashboard-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 7px;
      margin-bottom: 10px;
    }
    .crm-dashboard-grid div {
      padding: 9px 8px;
      border: 1px solid #e5edf7;
      border-radius: 13px;
      background: #f8fbff;
      text-align: center;
    }
    .crm-dashboard-grid strong {
      display: block;
      color: #0d3d72;
      font-size: 17px;
      line-height: 1;
    }
    .crm-dashboard-grid span {
      display: block;
      color: #64748b;
      font-size: 10px;
      font-weight: 800;
      margin-top: 4px;
    }
    .crm-dashboard-next {
      display: grid;
      gap: 6px;
    }
    .crm-dashboard-next > span {
      color: #64748b;
      font-size: 10px;
      font-weight: 950;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .crm-dashboard-next a {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 8px 9px;
      border-radius: 12px;
      border: 1px solid #e5edf7;
      background: #ffffff;
      color: inherit;
      text-decoration: none;
    }
    .crm-dashboard-next strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    .crm-dashboard-next em {
      color: #0d3d72;
      background: #eef6ff;
      border-radius: 999px;
      padding: 4px 7px;
      font-size: 10px;
      font-style: normal;
      font-weight: 900;
      white-space: nowrap;
    }
    .crm-dashboard-next p {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
    }
    .reception-card {
      margin: 0 14px 14px;
      padding: 12px;
      border: 1px solid #bfdbfe;
      border-radius: 16px;
      background:
        linear-gradient(135deg, rgba(239, 246, 255, 0.96), rgba(255, 255, 255, 0.98));
      box-shadow: 0 10px 22px rgba(13, 61, 114, 0.07);
    }
    .reception-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: start;
      margin-bottom: 10px;
    }
    .reception-head span {
      display: block;
      color: #64748b;
      font-size: 10px;
      font-weight: 950;
      letter-spacing: .08em;
      text-transform: uppercase;
      margin-bottom: 3px;
    }
    .reception-head strong {
      color: #0d2240;
      font-size: 14px;
      line-height: 1.25;
    }
    .reception-head a {
      flex: 0 0 auto;
      color: #0d3d72;
      background: #ffffff;
      border: 1px solid #cfe1f7;
      border-radius: 999px;
      padding: 6px 9px;
      text-decoration: none;
      font-size: 11px;
      font-weight: 900;
    }
    .reception-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 7px;
      margin-bottom: 10px;
    }
    .reception-metric {
      display: grid;
      gap: 4px;
      padding: 9px 8px;
      border: 1px solid #dbeafe;
      border-radius: 13px;
      background: #ffffff;
      color: inherit;
      text-align: center;
      text-decoration: none;
    }
    .reception-metric.active {
      border-color: #1a5fa8;
      background: #e0f2fe;
      box-shadow: 0 8px 18px rgba(26, 95, 168, 0.1);
    }
    .reception-metric strong {
      display: block;
      color: #0d3d72;
      font-size: 17px;
      line-height: 1;
    }
    .reception-metric span {
      color: #64748b;
      font-size: 10px;
      font-weight: 850;
    }
    .reception-next {
      display: grid;
      gap: 6px;
    }
    .reception-next > span {
      color: #64748b;
      font-size: 10px;
      font-weight: 950;
      letter-spacing: .06em;
      text-transform: uppercase;
    }
    .reception-next a {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px 8px;
      padding: 8px 9px;
      border: 1px solid #e5edf7;
      border-radius: 12px;
      background: #ffffff;
      color: inherit;
      text-decoration: none;
    }
    .reception-next strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    .reception-next em {
      color: #0d3d72;
      background: #eef6ff;
      border-radius: 999px;
      padding: 4px 7px;
      font-size: 10px;
      font-style: normal;
      font-weight: 900;
      white-space: nowrap;
    }
    .reception-next small {
      grid-column: 1 / -1;
      color: #64748b;
      font-size: 10px;
    }
    .reception-next p {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
    }
    .reception-report textarea {
      width: 100%;
      border: 1px solid #bfd6f0;
      border-radius: 12px;
      padding: 10px 11px;
      color: #0d2240;
      background: #ffffff;
      font: inherit;
      font-size: 12px;
      line-height: 1.5;
      resize: vertical;
    }
    .checklist-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    .checklist-head h2 {
      margin: 0;
    }
    .checklist-head span {
      display: block;
      color: #64748b;
      font-size: 11px;
      margin-top: 3px;
    }
    .checklist-head strong {
      color: #0d3d72;
      background: #eef6ff;
      border: 1px solid #cfe1f7;
      border-radius: 999px;
      padding: 5px 8px;
      font-size: 12px;
    }
    .checklist-progress {
      height: 7px;
      border-radius: 999px;
      background: #e5edf7;
      overflow: hidden;
      margin-bottom: 9px;
    }
    .checklist-progress span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #1a5fa8, #60a5fa);
    }
    .next-missing {
      margin-bottom: 9px;
      padding: 8px 9px;
      border: 1px solid #fde68a;
      border-radius: 12px;
      background: #fef3c7;
      color: #78350f;
      font-size: 12px;
      line-height: 1.35;
    }
    .next-missing.done {
      color: #166534;
      background: #dcfce7;
      border-color: #bbf7d0;
    }
    .checklist-list {
      display: grid;
      gap: 7px;
    }
    .checklist-row {
      display: grid;
      grid-template-columns: 54px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      padding: 8px;
      border: 1px solid #e5edf7;
      border-radius: 12px;
      background: #ffffff;
    }
    .checklist-row > span {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 24px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 950;
    }
    .checklist-row.done > span {
      color: #166534;
      background: #dcfce7;
    }
    .checklist-row.pending > span {
      color: #92400e;
      background: #fef3c7;
    }
    .checklist-row strong {
      display: block;
      color: #0d2240;
      font-size: 12px;
      line-height: 1.2;
    }
    .checklist-row small {
      display: block;
      color: #64748b;
      font-size: 11px;
      line-height: 1.35;
      margin-top: 2px;
    }
    .pipeline-card {
      margin: 0 14px 14px;
      padding: 12px;
      border: 1px solid #cfe1f7;
      border-radius: 16px;
      background: #ffffff;
      box-shadow: 0 10px 22px rgba(13, 61, 114, 0.06);
    }
    .pipeline-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .pipeline-stage {
      display: grid;
      gap: 5px;
      min-height: 92px;
      padding: 10px;
      color: inherit;
      text-decoration: none;
      border: 1px solid #e5edf7;
      border-radius: 14px;
      background: #f8fbff;
      transition: transform .15s ease, border-color .15s ease, box-shadow .15s ease;
    }
    .pipeline-stage:hover,
    .pipeline-stage.active {
      transform: translateY(-1px);
      border-color: #9fc5ef;
      box-shadow: 0 10px 20px rgba(26, 95, 168, 0.1);
      background: #edf6ff;
    }
    .pipeline-stage-top {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    .pipeline-stage-top strong {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    .pipeline-stage-top span {
      display: grid;
      place-items: center;
      min-width: 26px;
      height: 24px;
      border-radius: 999px;
      color: #ffffff;
      background: #1a5fa8;
      font-size: 12px;
      font-weight: 950;
    }
    .pipeline-stage em {
      color: #64748b;
      font-size: 10px;
      font-style: normal;
      font-weight: 800;
      line-height: 1.25;
    }
    .pipeline-sample {
      display: grid;
      gap: 3px;
      margin-top: 2px;
    }
    .pipeline-sample small {
      color: #475569;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 10px;
    }
    .report-entry summary {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      padding: 6px 0;
      font-size: 12px;
      list-style: none;
    }
    .report-entry summary::-webkit-details-marker { display: none; }
    .report-body {
      font-size: 12px;
      line-height: 1.6;
      padding: 6px 0 4px;
      color: #244a73;
      border-top: 1px solid #dbeafe;
      margin-top: 4px;
    }
    .report-compose {
      margin: 10px 0;
      border: 1px solid #cfe1f7;
      border-radius: 14px;
      background: #ffffff;
      overflow: hidden;
    }
    .report-compose summary {
      cursor: pointer;
      padding: 10px 12px;
      font-size: 13px;
      font-weight: 800;
      color: #0d3d72;
      list-style: none;
      background: #eef6ff;
    }
    .report-compose summary::-webkit-details-marker { display: none; }
    .report-form {
      display: grid;
      gap: 9px;
      padding: 12px;
    }
    .report-form label {
      display: grid;
      gap: 5px;
      font-size: 11px;
      font-weight: 800;
      color: #244a73;
      text-transform: uppercase;
      letter-spacing: .03em;
    }
    .report-form input,
    .report-form textarea {
      width: 100%;
      border: 1px solid #bfd6f0;
      border-radius: 12px;
      padding: 10px 11px;
      color: #0d2240;
      background: #ffffff;
      font: inherit;
      font-size: 13px;
      text-transform: none;
      letter-spacing: 0;
      resize: vertical;
    }
    .report-form button {
      min-height: 40px;
      border-radius: 12px;
    }
    .diagnostics-card {
      margin: 0 14px 14px;
      padding: 12px;
      border: 1px solid #cfe1f7;
      border-radius: 14px;
      background: #f8fbff;
    }
    .diagnostics-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    .diagnostics-head strong { font-size: 13px; }
    .diagnostics-compact summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      cursor: pointer;
      list-style: none;
    }
    .diagnostics-compact summary::-webkit-details-marker { display: none; }
    .diagnostics-compact .diagnostics-grid {
      margin-top: 10px;
    }
    .diagnostics-grid {
      display: grid;
      gap: 7px;
    }
    .quick-check-form {
      display: grid;
      margin-top: 10px;
    }
    .quick-check-form button {
      width: 100%;
      min-height: 38px;
      padding: 9px 10px;
      font-size: 12px;
    }
    .diagnostic-row {
      display: grid;
      grid-template-columns: 10px minmax(0, 82px) minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      font-size: 12px;
      color: #244a73;
    }
    .contacts-table-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      padding: 10px 16px;
      border-bottom: 1px solid #e5edf7;
      background: #f8fbff;
      color: #64748b;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #16a34a;
    }
    .dot.warn { background: #f59e0b; }
    .dot.err { background: #dc2626; }
    .thread {
      display: flex;
      gap: 12px;
      align-items: center;
      margin: 0 10px 8px;
      padding: 12px;
      color: inherit;
      text-decoration: none;
      border: 1px solid #e5edf7;
      border-radius: 17px;
      background: #ffffff;
      transition: background 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease;
    }
    .thread:hover {
      background: #f8fbff;
      border-color: #cfe1f7;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
    }
    .thread.active {
      background:
        linear-gradient(90deg, rgba(26, 95, 168, 0.08), rgba(255, 255, 255, 0.96));
      border-color: #8dbcec;
      box-shadow: 0 14px 30px rgba(26, 95, 168, 0.16);
    }
    .avatar {
      flex: 0 0 auto;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #ffffff;
      background: linear-gradient(135deg, #1a5fa8, #60a5fa);
      font-weight: 800;
      font-size: 13px;
    }
    .thread-copy {
      min-width: 0;
      flex: 1;
    }
    .thread-top {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
    }
    .thread strong {
      display: block;
      font-size: 14px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .thread span {
      color: var(--muted);
      flex: 0 0 auto;
      font-size: 11px;
    }
    .thread p {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.35;
      margin: 5px 0 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .thread-sub {
      color: var(--muted);
      font-size: 12px;
      margin-top: 2px;
    }
    .thread-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      color: #475569;
      background: #f0f6ff;
      border: 1px solid #cfe1f7;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 750;
    }
    .tag.confirmed { color: #166534; background: #dcfce7; border-color: #bbf7d0; }
    .tag.followup { color: #854d0e; background: #fef3c7; border-color: #fde68a; }
    .tag.open { color: #075985; background: #e0f2fe; border-color: #bae6fd; }
    .tag.human { color: #6d28d9; background: #ede9fe; border-color: #ddd6fe; }
    .tag.urgent { color: #991b1b; background: #fee2e2; border-color: #fecaca; }
    .tag.misunderstood { color: #7c2d12; background: #ffedd5; border-color: #fed7aa; }
    .tag.confirming { color: #1d4ed8; background: #dbeafe; border-color: #bfdbfe; }
    .tag.reschedule { color: #6d28d9; background: #ede9fe; border-color: #ddd6fe; }
    .tag.cancel { color: #9f1239; background: #ffe4e6; border-color: #fecdd3; }
    .tag.closing { color: #92400e; background: #fef3c7; border-color: #fde68a; }
    .tag.expired { color: #991b1b; background: #fee2e2; border-color: #fecaca; }
    .tag.waiting { color: #075985; background: #e0f2fe; border-color: #bae6fd; }
    .tag.resolved { color: #166534; background: #ecfdf5; border-color: #bbf7d0; }
    .tools {
      display: grid;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid #dbeafe;
    }
    .quick-filters {
      display: flex;
      gap: 7px;
      overflow-x: auto;
      padding: 0 14px 12px;
      border-bottom: 1px solid #dbeafe;
    }
    .filter-chip {
      flex: 0 0 auto;
      color: #0d3d72;
      background: #f5f9ff;
      border: 1px solid #cfe1f7;
      border-radius: 999px;
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 800;
      text-decoration: none;
    }
    .filter-chip.active {
      color: #ffffff;
      background: linear-gradient(135deg, #1a5fa8, #60a5fa);
      border-color: transparent;
    }
    .tools input, .tools select, textarea {
      width: 100%;
      border: 1px solid #9fc5ef;
      border-radius: 12px;
      padding: 10px 11px;
      font: inherit;
      background: #ffffff;
    }
    .tools input:focus, .tools select:focus, textarea:focus {
      border-color: var(--brand);
      box-shadow: 0 0 0 4px rgba(26, 95, 168, 0.12);
      outline: none;
    }
    .tool-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    button, .button-link {
      border: 0;
      border-radius: 12px;
      padding: 10px 12px;
      background: linear-gradient(135deg, var(--brand), #60a5fa);
      color: #ffffff;
      font: inherit;
      font-weight: 800;
      text-decoration: none;
      cursor: pointer;
      box-shadow: 0 10px 18px rgba(26, 95, 168, 0.16);
      transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
    }
    button:hover, .button-link:hover {
      transform: translateY(-1px);
      box-shadow: 0 14px 24px rgba(26, 95, 168, 0.2);
    }
    button:disabled {
      cursor: wait;
      opacity: 0.72;
      transform: none;
    }
    .button-secondary { background: #436b93; }
    .button-danger { background: linear-gradient(135deg, #be123c, #f43f5e); }
    .mobile-back { display: none; }
    .mobile-patient-sheet { display: none; }
    .chat {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--line);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 251, 255, 0.98));
      border-radius: 22px;
      box-shadow: 0 18px 40px rgba(15, 23, 42, 0.1);
    }
    .patient-panel {
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.96);
      overflow: auto;
      border-radius: 22px;
      box-shadow: 0 18px 38px rgba(15, 23, 42, 0.08);
    }
    .panel-section {
      padding: 16px;
      border-bottom: 1px solid #dbeafe;
      background: linear-gradient(180deg, rgba(255,255,255,.92), rgba(248,251,255,.72));
    }
    .panel-section h2 {
      margin: 0 0 10px;
      font-size: 14px;
    }
    .info-grid {
      display: grid;
      gap: 9px;
      font-size: 13px;
    }
    .crm-kpis {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 10px;
    }
    .crm-kpis div {
      padding: 10px;
      border-radius: 12px;
      background: #eef6ff;
      border: 1px solid #cfe1f7;
      text-align: center;
    }
    .crm-kpis strong {
      display: block;
      color: #0d3d72;
      font-size: 20px;
      line-height: 1;
    }
    .crm-kpis span {
      display: block;
      margin-top: 5px;
      color: #4a6a8a;
      font-size: 11px;
      font-weight: 800;
    }
    .crm-flags {
      margin-top: 10px;
    }
    .crm-hero {
      position: relative;
      display: grid;
      gap: 12px;
      padding: 14px;
      margin: -2px 0 12px;
      border: 1px solid #9fc5ef;
      border-radius: 18px;
      background:
        radial-gradient(circle at top right, rgba(96, 165, 250, 0.34), transparent 9rem),
        linear-gradient(135deg, #ffffff, #eef6ff);
      box-shadow: 0 16px 34px rgba(13, 61, 114, 0.1);
      overflow: hidden;
    }
    .crm-hero-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .crm-eyebrow {
      display: block;
      color: #4a6a8a;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 5px;
    }
    .crm-name {
      display: block;
      color: #0d2240;
      font-size: 18px;
      line-height: 1.15;
      overflow-wrap: anywhere;
    }
    .crm-subtitle {
      color: #4a6a8a;
      margin-top: 5px;
      font-size: 12px;
      line-height: 1.35;
    }
    .crm-stage {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 7px 10px;
      border: 1px solid #cfe1f7;
      background: #ffffff;
      color: #0d3d72;
      font-size: 11px;
      font-weight: 900;
      white-space: nowrap;
    }
    .crm-stage.active { color: #166534; background: #dcfce7; border-color: #86efac; }
    .crm-stage.returning { color: #1d4ed8; background: #dbeafe; border-color: #bfdbfe; }
    .crm-stage.attention { color: #92400e; background: #fef3c7; border-color: #fde68a; }
    .crm-stage.lead { color: #6d28d9; background: #ede9fe; border-color: #ddd6fe; }
    .crm-next-card {
      display: grid;
      gap: 4px;
      padding: 11px 12px;
      border-radius: 14px;
      border: 1px solid rgba(159, 197, 239, 0.9);
      background: rgba(255, 255, 255, 0.74);
    }
    .crm-next-card span {
      color: #4a6a8a;
      font-size: 10px;
      font-weight: 900;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .crm-next-card strong {
      color: #0d3d72;
      font-size: 13px;
      line-height: 1.3;
    }
    .crm-mini-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    .crm-mini {
      display: grid;
      gap: 4px;
      padding: 9px 10px;
      border-radius: 13px;
      border: 1px solid #cfe1f7;
      background: #f8fbff;
      min-width: 0;
    }
    .crm-mini span {
      color: #4a6a8a;
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .crm-mini strong {
      color: #0d2240;
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .crm-timeline {
      position: relative;
      display: grid;
      gap: 10px;
      margin-top: 12px;
      padding-left: 14px;
    }
    .crm-timeline::before {
      content: "";
      position: absolute;
      left: 4px;
      top: 8px;
      bottom: 8px;
      width: 2px;
      border-radius: 999px;
      background: #cfe1f7;
    }
    .crm-step {
      position: relative;
      display: grid;
      gap: 2px;
      padding: 9px 10px;
      border-radius: 12px;
      background: #ffffff;
      border: 1px solid #dbeafe;
      box-shadow: 0 8px 18px rgba(13, 61, 114, 0.05);
    }
    .crm-step::before {
      content: "";
      position: absolute;
      left: -14px;
      top: 14px;
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: #1a5fa8;
      box-shadow: 0 0 0 3px #eef6ff;
    }
    .crm-step span {
      color: #4a6a8a;
      font-size: 10px;
      font-weight: 900;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .crm-step strong {
      color: #0d2240;
      font-size: 12px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .info-row {
      display: grid;
      gap: 3px;
      padding: 9px 10px;
      border: 1px solid #cfe1f7;
      border-radius: 12px;
      background: #f5f9ff;
      overflow-wrap: anywhere;
    }
    .info-row span {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .summary-list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 13px;
    }
    .summary-list li {
      padding: 9px 10px;
      border-radius: 12px;
      background: #f5f9ff;
      border: 1px solid #cfe1f7;
    }
    .notes-list {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .note-card {
      padding: 10px;
      border-radius: 12px;
      background: #f5f9ff;
      border: 1px solid #cfe1f7;
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .note-card small {
      color: var(--muted);
      display: block;
      margin-bottom: 5px;
      font-size: 11px;
    }
    .results-email-card {
      display: grid;
      gap: 10px;
      padding: 12px;
      border-radius: 14px;
      background: #eef6ff;
      border: 1px solid #9fc5ef;
      font-size: 13px;
    }
    .results-email-card p { margin: 0; overflow-wrap: anywhere; }
    .results-email-card summary {
      cursor: pointer;
      color: #0d3d72;
      font-weight: 900;
      padding: 8px 0;
    }
    .results-email-card small {
      color: var(--muted);
      line-height: 1.4;
    }
    .results-email-primary {
      display: flex;
      justify-content: center;
      text-align: center;
    }
    .compact-notice {
      margin: 0;
      padding: 10px 11px;
      font-size: 12px;
    }
    .template-actions {
      margin: 0;
      border: 1px solid #cfe1f7;
      border-radius: 16px;
      background: #ffffff;
      box-shadow: 0 10px 24px rgba(13, 61, 114, 0.08);
      overflow: hidden;
    }
    .template-actions summary {
      cursor: pointer;
      list-style: none;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 12px;
    }
    .template-actions summary::-webkit-details-marker { display: none; }
    .template-actions summary::after {
      content: "Abrir";
      color: var(--brand-dark);
      background: #f0f6ff;
      border: 1px solid #9fc5ef;
      padding: 5px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 900;
    }
    .template-actions[open] summary::after {
      content: "Cerrar";
    }
    .template-actions[open] summary {
      border-bottom: 1px solid #dbeafe;
    }
    .template-body {
      padding: 12px;
    }
    .template-actions h2 {
      margin: 0 0 4px;
      font-size: 14px;
      color: #0d3d72;
    }
    .template-actions p {
      margin: 0 0 10px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .template-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .template-grid form { display: flex; min-width: 0; }
    .template-grid button { width: 100%; }
    .template-missing {
      display: flex;
      align-items: center;
      min-height: 40px;
      border: 1px dashed #cfe1f7;
      border-radius: 12px;
      padding: 8px 10px;
      color: #4a6a8a;
      font-size: 12px;
      font-weight: 700;
      background: #f5f9ff;
    }
    .conversation-panels {
      flex: 0 0 auto;
      margin: 10px 24px 0;
      border: 1px solid #cfe1f7;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.96);
      box-shadow: 0 10px 24px rgba(13, 61, 114, 0.08);
      overflow: hidden;
    }
    .conversation-panels summary {
      cursor: pointer;
      list-style: none;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      color: #0d3d72;
      font-weight: 900;
    }
    .conversation-panels summary::-webkit-details-marker { display: none; }
    .conversation-panels summary::after {
      content: "Abrir";
      color: var(--brand-dark);
      background: #f0f6ff;
      border: 1px solid #9fc5ef;
      padding: 5px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 900;
    }
    .conversation-panels[open] summary::after { content: "Cerrar"; }
    .conversation-panels[open] summary { border-bottom: 1px solid #dbeafe; }
    .conversation-panels-body {
      display: grid;
      gap: 10px;
      padding: 12px;
      max-height: 34dvh;
      overflow: auto;
    }
    .conversation-panels .notice,
    .conversation-panels .error-banner,
    .conversation-panels .success-banner,
    .conversation-panels .appointment-card {
      margin: 0;
    }
    body.results-email-open { overflow: hidden; }
    .results-email-modal {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 80;
      padding: 18px;
    }
    .results-email-modal.is-open {
      display: grid;
      place-items: center;
    }
    .results-email-modal:target {
      display: grid;
      place-items: center;
    }
    .results-email-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(15, 23, 42, 0.42);
      backdrop-filter: blur(3px);
    }
    .results-email-dialog {
      position: relative;
      z-index: 1;
      width: min(560px, 100%);
      max-height: min(86dvh, 720px);
      overflow: auto;
      border-radius: 22px;
      border: 1px solid #9fc5ef;
      background: #ffffff;
      box-shadow: 0 24px 70px rgba(15, 23, 42, 0.26);
      padding: 18px;
      display: grid;
      gap: 12px;
    }
    .results-email-header {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 12px;
      color: #0d3d72;
    }
    .results-email-header strong {
      font-size: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .results-email-header span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      overflow-wrap: anywhere;
      margin-top: 4px;
    }
    .results-email-close {
      border: 0;
      border-radius: 999px;
      background: #eaf3ff;
      color: #0d3d72;
      box-shadow: none;
      padding: 8px 11px;
      min-width: auto;
    }
    .results-email-dialog form {
      display: grid;
      gap: 10px;
    }
    .results-email-dialog button[type='submit'] {
      min-height: 48px;
      font-size: 14px;
    }
    .results-email-dialog small {
      color: var(--muted);
      line-height: 1.4;
    }
    .checkbox-row {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      font-size: 12px;
      color: #334155;
      line-height: 1.4;
    }
    .checkbox-row input { margin-top: 2px; }
    .chat-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 22px;
      background: linear-gradient(180deg, #ffffff, #f8fbff);
      border-bottom: 1px solid var(--line);
    }
    .chat-title strong { display: block; font-size: 16px; }
    .chat-title span { color: var(--muted); font-size: 13px; }
    .chip {
      flex: 0 0 auto;
      color: var(--brand-dark);
      background: #ddeeff;
      border: 1px solid #9fc5ef;
      padding: 7px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
    }
    .chat-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .crm-command {
      flex: 0 0 auto;
      margin: 12px 20px 0;
      padding: 13px 14px;
      border-radius: 18px;
      border: 1px solid #9fc5ef;
      background:
        radial-gradient(circle at top right, rgba(96, 165, 250, 0.22), transparent 10rem),
        linear-gradient(135deg, #ffffff, #eef6ff);
      box-shadow: 0 14px 34px rgba(13, 61, 114, 0.1);
    }
    .crm-command.danger {
      border-color: #fecaca;
      background:
        radial-gradient(circle at top right, rgba(248, 113, 113, 0.18), transparent 10rem),
        linear-gradient(135deg, #ffffff, #fff1f2);
    }
    .crm-command.warning {
      border-color: #fde68a;
      background:
        radial-gradient(circle at top right, rgba(251, 191, 36, 0.2), transparent 10rem),
        linear-gradient(135deg, #ffffff, #fffbeb);
    }
    .crm-command.success {
      border-color: #bbf7d0;
      background:
        radial-gradient(circle at top right, rgba(74, 222, 128, 0.18), transparent 10rem),
        linear-gradient(135deg, #ffffff, #f0fdf4);
    }
    .crm-command-top {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
    }
    .crm-command-eyebrow {
      display: block;
      color: #4a6a8a;
      font-size: 10px;
      font-weight: 950;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .crm-command strong {
      display: block;
      color: #0d2240;
      font-size: 15px;
      line-height: 1.2;
    }
    .crm-command p {
      margin: 5px 0 0;
      color: #4a6a8a;
      font-size: 12px;
      line-height: 1.45;
    }
    .temperature-pill {
      border-radius: 999px;
      padding: 7px 10px;
      border: 1px solid #cfe1f7;
      background: #ffffff;
      color: #0d3d72;
      font-size: 11px;
      font-weight: 950;
      white-space: nowrap;
    }
    .temperature-pill.hot { color: #991b1b; background: #fee2e2; border-color: #fecaca; }
    .temperature-pill.warm { color: #92400e; background: #fef3c7; border-color: #fde68a; }
    .temperature-pill.cold { color: #075985; background: #e0f2fe; border-color: #bae6fd; }
    .crm-command-footer {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 12px;
    }
    .crm-command-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }
    .crm-command-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }
    .crm-command-actions form {
      display: inline-flex;
      margin: 0;
    }
    .crm-command-actions button,
    .crm-command-actions .button-link {
      padding: 8px 11px;
      font-size: 12px;
    }
    .crm-smart-actions {
      display: grid;
      gap: 8px;
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid rgba(159, 197, 239, 0.62);
    }
    .crm-smart-actions > span {
      color: #64748b;
      font-size: 10px;
      font-weight: 950;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .crm-smart-actions > div {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    .crm-smart-actions button {
      border: 1px solid #cfe1f7;
      box-shadow: none;
      color: #0d3d72;
      background: rgba(255, 255, 255, 0.82);
      padding: 7px 10px;
      font-size: 11px;
      border-radius: 999px;
    }
    .crm-smart-actions button:hover {
      background: #ffffff;
      box-shadow: 0 8px 18px rgba(13, 61, 114, 0.1);
    }
    .patient-signal-strip {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 8px;
      margin: 10px 20px 0;
    }
    .patient-signal {
      min-width: 0;
      padding: 9px 10px;
      border-radius: 14px;
      border: 1px solid #dbeafe;
      background: #ffffff;
      box-shadow: 0 8px 18px rgba(13, 61, 114, 0.05);
    }
    .patient-signal span {
      display: block;
      color: #64748b;
      font-size: 9px;
      font-weight: 950;
      letter-spacing: .08em;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .patient-signal strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #0d2240;
      font-size: 11px;
      line-height: 1.2;
    }
    .patient-signal.success { background: #f0fdf4; border-color: #bbf7d0; }
    .patient-signal.warning,
    .patient-signal.closing { background: #fffbeb; border-color: #fde68a; }
    .patient-signal.danger,
    .patient-signal.expired { background: #fff1f2; border-color: #fecaca; }
    .patient-signal.open,
    .patient-signal.info,
    .patient-signal.stage { background: #f8fbff; border-color: #cfe1f7; }
    .appointment-card {
      margin: 18px 24px 0;
      border-radius: 14px;
      background: #f0f6ff;
      border: 1px solid #9fc5ef;
      color: #0d3d72;
      overflow: hidden;
    }
    .appointment-card summary {
      cursor: pointer;
      list-style: none;
      padding: 12px 14px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      font-size: 13px;
      font-weight: 900;
    }
    .appointment-card summary::-webkit-details-marker { display: none; }
    .appointment-card summary strong {
      display: block;
      font-size: 14px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .appointment-card summary span {
      display: block;
      margin-top: 2px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 750;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .appointment-card summary::after {
      content: "Ver";
      color: var(--brand-dark);
      background: #fff;
      border: 1px solid #9fc5ef;
      padding: 5px 9px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 900;
    }
    .appointment-card[open] summary::after {
      content: "Ocultar";
    }
    .appointment-card[open] summary {
      border-bottom: 1px solid #cfe1f7;
    }
    .appointment-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 14px;
      padding: 12px 14px 14px;
      font-size: 13px;
    }
    .appointment-grid span {
      color: var(--brand-dark);
      display: block;
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .messages {
      padding: 26px 28px;
      overflow: auto;
      background:
        linear-gradient(rgba(248, 251, 255, 0.94), rgba(248, 251, 255, 0.94)),
        radial-gradient(circle, rgba(26, 95, 168, 0.065) 1px, transparent 1px);
      background-size: auto, 20px 20px;
      flex: 1;
      min-height: 0;
      scroll-behavior: smooth;
    }
    .message {
      display: flex;
      margin-bottom: 16px;
    }
    .message.bot { justify-content: flex-end; }
    .bubble {
      max-width: min(760px, 84%);
      padding: 12px 14px 11px;
      border-radius: 18px 18px 18px 6px;
      background: var(--surface);
      border: 1px solid rgba(207, 225, 247, 0.72);
      box-shadow: 0 10px 26px rgba(13, 61, 114, 0.08);
      line-height: 1.5;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .bot .bubble {
      color: #0d3d72;
      background: linear-gradient(135deg, #e8f3ff, #dcecff);
      border-color: #c6ddf8;
      border-radius: 18px 18px 6px 18px;
    }
    .human { justify-content: flex-end; }
    .human .bubble {
      color: #ffffff;
      background: linear-gradient(135deg, #1a5fa8, #2563eb);
      border-color: rgba(255, 255, 255, 0.16);
      border-radius: 18px 18px 6px 18px;
    }
    .human .meta { color: rgba(255, 255, 255, 0.78); }
    .meta {
      color: var(--muted);
      font-size: 11px;
      font-weight: 850;
      letter-spacing: .02em;
      margin-bottom: 6px;
    }
    .body { font-size: 14.5px; }
    .attachment-card {
      display: grid;
      gap: 2px;
      margin-top: 10px;
      padding: 10px 11px;
      border: 1px solid rgba(26, 95, 168, 0.18);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.72);
      font-size: 13px;
    }
    .attachment-card span {
      color: #334155;
      overflow-wrap: anywhere;
    }
    .attachment-card small { color: var(--muted); }
    .notice {
      margin: 14px 24px 0;
      padding: 12px 14px;
      border-radius: 12px;
      color: #854d0e;
      background: #fef3c7;
      border: 1px solid #fde68a;
      font-size: 13px;
      line-height: 1.45;
    }
    .composer {
      border-top: 1px solid var(--line);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.96), rgba(240,247,255,0.98));
      padding: 14px 16px 16px;
      flex: 0 0 auto;
      box-shadow: 0 -12px 28px rgba(13, 61, 114, 0.08);
    }
    .composer form { display: grid; gap: 10px; }
    .composer-email-action {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid #9fc5ef;
      border-radius: 16px;
      background: #eef6ff;
    }
    .composer-email-action span {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      line-height: 1.35;
    }
    .composer-email-action .button-link,
    .composer-email-action button {
      flex: 0 0 auto;
      padding: 9px 12px;
      font-size: 12px;
    }
    .message-input-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: stretch;
    }
    .message-input-row textarea {
      min-height: 64px;
      max-height: 150px;
      resize: vertical;
      border-radius: 18px;
      background: #ffffff;
      font-size: 14px;
    }
    .send-button {
      min-width: 126px;
      border-radius: 18px;
      font-size: 15px;
      letter-spacing: .01em;
    }
    .quick-replies {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: thin;
    }
    .quick-reply {
      flex: 0 0 auto;
      background: #ffffff;
      color: #0d3d72;
      border: 1px solid #c3daf4;
      padding: 8px 11px;
      font-size: 12px;
      box-shadow: none;
    }
    .file-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 6px;
      color: #4a6a8a;
      font-size: 13px;
      font-weight: 700;
    }
    .file-row input {
      border: 1px dashed #9fc5ef;
      border-radius: 10px;
      padding: 10px;
      background: #f8fbff;
      font: inherit;
    }
    .composer-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
    }
    .composer-hint {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      color: var(--muted);
      font-size: 12px;
    }
    .composer-count {
      color: var(--brand-dark);
      font-weight: 800;
    }
    .knowledge {
      margin-top: 12px;
      padding: 12px 14px;
      border-top: 1px solid #edf1f6;
    }
    .knowledge h2 {
      font-size: 13px;
      margin: 0 0 8px;
    }
    .knowledge-card {
      padding: 10px;
      border-radius: 12px;
      border: 1px solid #e2e8f0;
      background: #ffffff;
      margin-bottom: 8px;
    }
    .knowledge-card p {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.35;
      margin: 0 0 6px;
      overflow-wrap: anywhere;
    }
    .knowledge-card strong {
      display: block;
      font-size: 12px;
      line-height: 1.35;
      margin-bottom: 8px;
      overflow-wrap: anywhere;
    }
    .knowledge-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .knowledge-actions button {
      padding: 7px 9px;
      font-size: 12px;
    }
    .knowledge-form {
      display: grid;
      gap: 8px;
    }
    .knowledge-form textarea {
      min-height: 64px;
      font-size: 13px;
      resize: vertical;
    }
    .knowledge-form button { font-size: 12px; }
    .conversation-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .conversation-tools form { display: inline-flex; }
    .error-banner {
      margin: 14px 24px 0;
      padding: 12px 14px;
      border-radius: 12px;
      color: #991b1b;
      background: #fee2e2;
      border: 1px solid #fecaca;
      font-size: 13px;
    }
    .success-banner {
      margin: 14px 24px 0;
      padding: 12px 14px;
      border-radius: 12px;
      color: #166534;
      background: #dcfce7;
      border: 1px solid #86efac;
      font-size: 13px;
    }
    .mobile-toast {
      display: none;
    }
    .empty-state {
      color: var(--muted);
      margin: 18px;
      padding: 18px;
      border-radius: 14px;
      background: var(--soft);
      font-size: 14px;
    }
    .empty-chat {
      display: grid;
      place-items: center;
      flex: 1;
      padding: 24px;
    }
    .empty-card {
      max-width: 360px;
      text-align: center;
      padding: 28px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.76);
      border: 1px solid var(--line);
    }
    .empty-icon { font-size: 38px; margin-bottom: 8px; }
    .empty-card h2 { font-size: 18px; margin: 0 0 8px; }
    .empty-card p {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.5;
      margin: 0;
    }
    .mobile-info-grid {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .mobile-info-row {
      padding: 9px 10px;
      border: 1px solid #cfe1f7;
      border-radius: 12px;
      background: #f8fbff;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .mobile-info-row > span {
      display: block;
      color: var(--muted);
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      margin-bottom: 3px;
    }
    .mobile-crm-strip {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
    }
    .mobile-crm-strip div {
      border: 1px solid #cfe1f7;
      border-radius: 12px;
      background: #ffffff;
      padding: 8px 6px;
      text-align: center;
    }
    .mobile-crm-strip strong {
      display: block;
      color: #0d3d72;
      font-size: 16px;
      line-height: 1;
    }
    .mobile-crm-strip span {
      display: block;
      color: #4a6a8a;
      font-size: 10px;
      font-weight: 800;
      margin-top: 4px;
    }
    @media (max-width: 1180px) {
      .crm-top-banner {
        grid-template-columns: minmax(0, 1fr);
        align-items: stretch;
      }
      .command-actions {
        justify-content: flex-start;
      }
      main {
        grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
      }
      .patient-panel {
        display: none;
      }
    }
    @media (max-width: 780px) {
      body { min-height: 100dvh; overflow: hidden; }
      .crm-rail { display: none; }
      .inbox-banner { display: none; }
      header { margin-left: 0; padding: 0 14px; height: 58px; min-height: 58px; gap: 12px; }
      .brand-mark { width: 34px; height: 34px; border-radius: 10px; }
      h1 { font-size: 16px; }
      .status { display: none; }
      .metric-strip {
        display: flex;
        margin-left: 0;
        position: sticky;
        top: 58px;
        z-index: 3;
        gap: 7px;
        padding: 7px 10px 8px;
        border-bottom: 1px solid var(--line);
        background: rgba(245, 249, 255, 0.98);
        scrollbar-width: none;
      }
      .metric-strip::-webkit-scrollbar { display: none; }
      .metric-pill {
        min-width: 86px;
        padding: 7px 9px;
        border-radius: 13px;
        background: #ffffff;
        box-shadow: 0 6px 14px rgba(13, 61, 114, 0.08);
      }
      .metric-pill strong { font-size: 17px; }
      .metric-pill span { font-size: 10px; margin-top: 4px; }
      .crm-top-banner { display: none; }
      main { display: block; height: calc(100dvh - 111px); min-height: 0; margin-left: 0; padding: 0; }
      body.has-selection aside { display: none; }
      body.no-selection .chat { display: none; }
      .patient-panel { display: none; }
      aside {
        height: calc(100dvh - 111px);
        max-height: none;
        border: 0;
        border-radius: 0;
        box-shadow: none;
      }
      .sidebar-head {
        position: sticky;
        top: 0;
        z-index: 2;
        background: rgba(255, 255, 255, 0.96);
      }
      .stats,
      .metrics-card {
        display: none;
      }
      .diagnostics-card {
        display: block;
        margin: 8px 14px 10px;
        padding: 10px;
        border-radius: 14px;
        background: #ffffff;
      }
      .diagnostics-head {
        margin-bottom: 8px;
      }
      .diagnostics-grid {
        max-height: 122px;
        overflow: auto;
        padding-right: 2px;
      }
      .diagnostic-row {
        grid-template-columns: 10px minmax(0, 86px) minmax(0, 1fr);
        font-size: 11px;
      }
      .tools {
        position: sticky;
        top: 58px;
        z-index: 2;
        background: rgba(255, 255, 255, 0.96);
      }
      .thread { padding: 13px 14px; }
      .thread.active { padding-left: 10px; }
      .chat {
        height: calc(100dvh - 111px);
        min-height: 0;
        border: 0;
        border-radius: 0;
        box-shadow: none;
      }
      .chat-title {
        padding: 12px 14px;
        display: block;
        align-items: flex-start;
        gap: 10px;
      }
      .chat-title > div:first-child { min-width: 0; }
      .chat-title span { display: block; margin-top: 3px; }
      .chat-actions { justify-content: flex-start; margin-top: 8px; }
      .mobile-back { display: inline-flex; }
      .conversation-tools {
        display: flex;
        flex-wrap: nowrap;
        gap: 8px;
        overflow-x: auto;
        padding: 2px 0 4px;
        scrollbar-width: thin;
      }
      .conversation-tools .button-link,
      .conversation-tools button {
        width: auto;
        min-width: max-content;
        text-align: center;
        font-size: 12px;
        padding: 9px 8px;
      }
      .conversation-tools form { display: flex; flex: 0 0 auto; min-width: 0; }
      .conversation-tools .tag-form { display: none; }
      .results-email-modal {
        padding: 10px;
        align-items: end;
      }
      .results-email-dialog {
        width: 100%;
        max-height: 84dvh;
        border-radius: 20px 20px 0 0;
        padding: 16px;
      }
      .mobile-patient-sheet {
        display: block;
        padding: 7px 10px;
        border-bottom: 1px solid var(--line);
        background: #f8fbff;
      }
      .mobile-patient-sheet summary {
        cursor: pointer;
        color: #0d3d72;
        font-size: 13px;
        font-weight: 850;
      }
      .mobile-patient-sheet[open] .mobile-info-grid {
        max-height: 160px;
        overflow: auto;
        padding-right: 2px;
      }
      .chat-title { order: 0; flex: 0 0 auto; }
      .crm-command {
        order: 1;
        margin: 8px 10px 0;
        padding: 10px;
        border-radius: 16px;
      }
      .crm-command-top {
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
      }
      .crm-command strong { font-size: 14px; }
      .crm-command p { display: none; }
      .temperature-pill {
        width: fit-content;
        padding: 5px 8px;
      }
      .crm-command-footer {
        margin-top: 8px;
        display: grid;
        gap: 8px;
      }
      .crm-command-tags {
        overflow-x: auto;
        flex-wrap: nowrap;
        padding-bottom: 2px;
        scrollbar-width: none;
      }
      .crm-command-tags::-webkit-scrollbar { display: none; }
      .crm-command-actions {
        overflow-x: auto;
        flex-wrap: nowrap;
        justify-content: flex-start;
        scrollbar-width: none;
      }
      .crm-command-actions::-webkit-scrollbar { display: none; }
      .crm-command-actions button,
      .crm-command-actions .button-link {
        white-space: nowrap;
      }
      .patient-signal-strip {
        order: 2;
        display: flex;
        overflow-x: auto;
        gap: 7px;
        margin: 8px 10px 0;
        padding-bottom: 2px;
        scrollbar-width: none;
      }
      .patient-signal-strip::-webkit-scrollbar { display: none; }
      .patient-signal {
        flex: 0 0 132px;
        padding: 8px 9px;
      }
      .messages {
        order: 3;
        padding: 10px;
        flex: 1 1 58dvh;
        min-height: min(430px, 58dvh);
        scroll-margin-top: 150px;
      }
      .mobile-patient-sheet,
      .conversation-panels {
        order: 4;
        flex: 0 0 auto;
      }
      .appointment-card { margin: 6px 10px 0; }
      .appointment-card[open] .appointment-grid {
        max-height: 150px;
        overflow: auto;
      }
      .notice, .error-banner, .success-banner { margin: 10px 12px 0; }
      .mobile-toast {
        display: block;
        position: fixed;
        left: 10px;
        right: 10px;
        top: 66px;
        z-index: 75;
        padding: 12px 14px;
        border-radius: 16px;
        box-shadow: 0 16px 34px rgba(15, 23, 42, 0.22);
        font-size: 13px;
        font-weight: 850;
        line-height: 1.35;
      }
      .mobile-toast.success {
        color: #166534;
        background: #dcfce7;
        border: 1px solid #86efac;
      }
      .mobile-toast.error {
        color: #991b1b;
        background: #fee2e2;
        border: 1px solid #fecaca;
      }
      .appointment-grid { grid-template-columns: 1fr; }
      .bubble { max-width: 92%; }
      .composer {
        order: 5;
        padding: 10px;
        padding-bottom: max(10px, env(safe-area-inset-bottom));
      }
      .composer form { gap: 8px; }
      .composer-email-action {
        align-items: stretch;
        display: grid;
        gap: 6px;
      }
      .composer-email-action span { font-size: 11px; }
      .composer-email-action .button-link,
      .composer-email-action button {
        justify-content: center;
        width: 100%;
      }
      .message-input-row {
        grid-template-columns: minmax(0, 1fr) 96px;
      }
      .send-button {
        width: 100%;
        min-height: 48px;
      }
      .quick-replies { margin: 0 -2px; padding: 0 2px 4px; }
      .quick-reply { font-size: 12px; padding: 7px 9px; }
      .template-actions { margin: 8px 10px 0; }
      .template-actions summary { padding: 10px; }
      .template-body { padding: 10px; max-height: 130px; overflow: auto; }
      .template-actions h2 { margin-bottom: 2px; }
      .template-actions p { display: none; }
      .template-grid { grid-template-columns: 1fr; }
      .conversation-panels {
        margin: 8px 10px 0;
      }
      .conversation-panels summary {
        padding: 10px;
        font-size: 13px;
      }
      .conversation-panels-body {
        max-height: 132px;
        padding: 10px;
      }
      .file-row span { display: none; }
      .composer-actions {
        display: grid;
        grid-template-columns: 1fr;
      }
      .composer-actions .subtitle { font-size: 11px; }
      .composer-actions button { width: 100%; }
      .knowledge { display: none; }
    }
  </style>
</head>
<body class="${selected ? "has-selection" : "no-selection"} crm-pro">
  <nav class="crm-rail" aria-label="Navegacion CRM">
    <div class="rail-logo">DC</div>
    <a class="rail-item ${sideTab === "patients" ? "active" : ""}" href="/inbox?${buildInboxQuery({ tab: "patients", phone: selectedPhone, q: url.searchParams.get("q"), filter })}">
      <span>C</span>
      Contactos
    </a>
    <a class="rail-item ${sideTab === "diagnostics" ? "active" : ""}" href="/inbox?${buildInboxQuery({ tab: "diagnostics", phone: selectedPhone, q: url.searchParams.get("q"), filter })}">
      <span>E</span>
      Estado
    </a>
    <a class="rail-item ${sideTab === "reports" ? "active" : ""}" href="/inbox?${buildInboxQuery({ tab: "reports", phone: selectedPhone, q: url.searchParams.get("q"), filter })}">
      <span>R</span>
      Reportes
    </a>
    <a class="rail-item ${sideTab === "tools" ? "active" : ""}" href="/inbox?${buildInboxQuery({ tab: "tools", phone: selectedPhone, q: url.searchParams.get("q"), filter })}">
      <span>H</span>
      Herram.
    </a>
    <a class="rail-item" href="/privacy">
      <span>P</span>
      Privacidad
    </a>
  </nav>
  <div class="inbox-banner">
    <img src="/public/dra_carranza_banner.png" alt="Dra. Carranza - Bienvenida a su consultorio virtual">
  </div>
  <header>
    <div class="brand">
      <div class="brand-mark"><img src="${escapeHtml(doctorImageSrc)}" alt="Dra. Carranza"></div>
      <div>
        <h1>Dra. Carranza — Consultorio Virtual</h1>
        <div class="subtitle">Conversaciones del consultorio</div>
      </div>
    </div>
    <div class="status">
      <span class="health-pill ok">${list.length} conversaciones</span>
      <span class="health-pill ok">${stats.confirmed} citas</span>
      <span class="health-pill ${stats.followup > 0 ? "warn" : "ok"}">${stats.followup} seguimiento</span>
      <span class="health-pill" data-refresh-status>Actualizado ahora</span>
      <button class="health-pill refresh-toggle" type="button" data-refresh-toggle>Auto refresh activo</button>
      ${operationalStatus}
      <a class="health-pill" href="/inbox/logout">salir</a>
    </div>
  </header>
  <div class="metric-strip">
    <div class="metric-pill"><strong>${stats.total}</strong><span>Total</span></div>
    <div class="metric-pill"><strong>${stats.followup}</strong><span>Pendientes</span></div>
    <div class="metric-pill"><strong>${stats.confirmed}</strong><span>Agendadas</span></div>
    <div class="metric-pill"><strong>${stats.human}</strong><span>Humano</span></div>
    <div class="metric-pill"><strong>${stats.urgent}</strong><span>Urgentes</span></div>
    <div class="metric-pill"><strong>${stats.noReply}</strong><span>Sin responder</span></div>
  </div>
  <div class="crm-top-banner premium-command-bar" aria-label="Panel de mando del consultorio">
    <div>
      <span class="command-kicker">Recepcion en vivo</span>
      <strong>Consultorio virtual activo</strong>
      <span>Contactos, agenda, resultados por correo y modo humano en un solo panel.</span>
    </div>
    <div class="command-health-grid" aria-label="Indicadores rapidos">
      <div><b>${stats.followup}</b><small>Pendientes</small></div>
      <div><b>${stats.confirmed}</b><small>Citas agendadas</small></div>
      <div><b>${stats.noReply}</b><small>Sin responder</small></div>
    </div>
    <div class="command-actions">
      <span class="banner-pill">CRM operativo</span>
      <a class="primary" href="/inbox?filter=priority">Prioridad</a>
      <a href="/inbox?tab=reports">Reportes</a>
      <a href="/inbox?tab=diagnostics">Estado</a>
    </div>
  </div>
  <main>
    <aside>
      <div class="sidebar-head">
        <strong>Pacientes</strong>
        <span>Ultimos mensajes recibidos · <span data-refresh-status>Actualizado ahora</span></span>
      </div>
      <div class="stats">
        <div class="stat"><strong>${stats.total}</strong><span>Total</span></div>
        <div class="stat"><strong>${stats.confirmed}</strong><span>Agendadas</span></div>
        <div class="stat"><strong>${stats.followup}</strong><span>Seguimiento</span></div>
        <div class="stat"><strong>${stats.human}</strong><span>Humano</span></div>
        <div class="stat"><strong>${stats.urgent}</strong><span>Urgentes</span></div>
        <div class="stat"><strong>${stats.noReply}</strong><span>No respondio</span></div>
        <div class="stat"><strong>${stats.resolved}</strong><span>Resueltas</span></div>
      </div>
      ${sidebarTabs}
      ${sidebarContent}
    </aside>
    <section class="chat">
      <div class="chat-title">
        <div>
          <strong>${selected ? escapeHtml(selectedName) : "Sin conversacion seleccionada"}</strong>
          <span>${selected ? `${formatPhoneForInbox(selected.phoneNumber)} · Ultima actividad: ${formatInboxDate(getConversationActivityISO(selected) ?? selected.updatedAt)}` : "Cuando llegue un mensaje aparecera aqui."}</span>
          ${
            selected
              ? `<div class="conversation-tools">
                  <a class="mobile-back button-link button-secondary" href="/inbox?${buildInboxQuery({ q: url.searchParams.get("q"), filter })}">← Pacientes</a>
                  <button type="button" class="button-secondary" data-scroll-chat>Leer chat</button>
                  <a class="button-link" href="#send-file-email" data-open-results-email>📤 Archivo al correo</a>
                  <a class="button-link button-secondary" href="/inbox?${buildInboxQuery({ q: url.searchParams.get("q"), filter })}">Cerrar conversacion</a>
                  <a class="button-link button-secondary" href="https://wa.me/${encodeURIComponent(selectedPhone)}" target="_blank" rel="noreferrer">Abrir WhatsApp</a>
                  <button type="button" class="button-secondary" data-copy-phone="${escapeHtml(selectedPhone)}">Copiar telefono</button>
                  <form method="post" action="/inbox/resolve-conversation">
                    <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                    <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                    <button type="submit" onclick="return confirm('¿Marcar esta conversacion como resuelta? Si la paciente escribe de nuevo, volvera a pendientes.')">Marcar resuelto</button>
                  </form>
                  ${
                    selected.botPaused
                      ? `<form method="post" action="/inbox/release"><input name="csrf" type="hidden" value="${escapeHtml(csrf)}"><input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}"><button type="submit">Devolver al bot</button></form>`
                      : `<form method="post" action="/inbox/takeover"><input name="csrf" type="hidden" value="${escapeHtml(csrf)}"><input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}"><button class="button-danger" type="submit">Tomar conversacion</button></form>`
                  }
                  <form method="post" action="/inbox/reprompt">
                    <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                    <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                    <button type="submit">Reenviar paso actual</button>
                  </form>
                  <form method="post" action="/inbox/reset-session">
                    <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                    <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                    <button class="button-danger" type="submit" onclick="return confirm('¿Reiniciar el flujo del bot para este paciente?')">Reiniciar flujo</button>
                  </form>
                  <form method="post" action="/inbox/repair-bot">
                    <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                    <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                    <button class="button-danger" type="submit" onclick="return confirm('¿Arreglar el bot para esta conversacion? Esto reinicia el flujo, libera apartados temporales y manda el menu inicial.')">Arreglar bot</button>
                  </form>
                  ${
                    selectedStatus.key === "urgent"
                      ? `<form method="post" action="/inbox/resolve-urgent">
                          <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                          <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                          <button type="submit">Marcar urgente resuelto</button>
                        </form>`
                      : ""
                  }
                  <form class="tag-form" method="post" action="/inbox/tags">
                    <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                    <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                    <input name="tags" maxlength="300" value="${escapeHtml((selected.tags ?? []).join(", "))}" placeholder="Etiquetas">
                    <button type="submit">Guardar etiquetas</button>
                  </form>
                </div>`
              : ""
          }
        </div>
        ${
          selected
            ? `<div class="chat-actions"><div class="chip">${selected.messages.length} mensajes</div><div class="tag ${selectedStatus.className}">${selectedStatus.label}</div></div>`
            : ""
        }
      </div>
      ${renderCrmCommandCenter(selected, { csrf, selectedPhone, selectedStatus, windowState })}
      ${renderPatientSignalStrip(selected)}
      ${renderMobilePatientSheet(selected, { selectedStatus, windowState })}
      ${inboxError ? `<div class="mobile-toast error" role="alert">${escapeHtml(inboxError)}</div>` : ""}
      ${inboxSuccess ? `<div class="mobile-toast success" role="status">${escapeHtml(inboxSuccess)}</div>` : ""}
      <div id="chat-messages" class="messages" tabindex="-1">${messages}</div>
      ${selected ? renderInlineResultsEmailAction(selected, selectedPhone, csrf) : ""}
      ${
        selected
          ? `<details class="conversation-panels">
              <summary>Herramientas y avisos</summary>
              <div class="conversation-panels-body">
                ${inboxError ? `<div class="error-banner">${escapeHtml(inboxError)}</div>` : ""}
                ${inboxSuccess ? `<div class="success-banner">${escapeHtml(inboxSuccess)}</div>` : ""}
                ${selected?.botPaused ? `<div class="notice">Modo humano activo: el bot guarda mensajes entrantes, pero no responde automaticamente a este paciente.</div>` : ""}
                ${needsTemplateNotice ? `<div class="notice">La ultima interaccion del paciente fue hace mas de 24 horas. Puede requerir plantilla aprobada de WhatsApp para responder fuera de la ventana de atencion.</div>` : ""}
                ${selected ? renderInboxMetaTemplateActions(selected, selectedPhone, csrf) : ""}
                ${appointmentCard}
              </div>
            </details>`
          : ""
      }
      ${
        selected
          ? `<div class="composer">
              <form method="post" action="/inbox/send">
                <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                ${quickReplies}
                <div class="message-input-row">
                  <textarea name="message" rows="3" maxlength="2000" placeholder="Escribe una respuesta como humano..."></textarea>
                  <button class="send-button" type="submit">Enviar</button>
                </div>
                <div class="composer-actions">
                  <span class="subtitle">Solo texto por WhatsApp. Para fotos, PDF o archivos usa "Enviar archivo por correo confirmado" en la ficha de la paciente.</span>
                  <span class="composer-count" data-message-count>0/2000</span>
                </div>
              </form>
            </div>`
          : ""
      }
    </section>
    ${rightPanel}
  </main>
</body>
</html>`;
}

function renderOperationalStatusBadges() {
  const badges = [
    { label: `DB ${isDatabaseEnabled() ? "ok" : "off"}`, className: isDatabaseEnabled() ? "ok" : "warn" },
    { label: `Google ${config.googleClientId && config.googleClientSecret && config.googleRefreshToken ? "ok" : "cfg"}`, className: config.googleClientId && config.googleClientSecret && config.googleRefreshToken ? "ok" : "warn" },
    { label: `Meta ${config.whatsappAppSecret && config.requireWebhookSignature && !config.allowUnsignedWebhooks ? "firmado" : "revisar"}`, className: config.whatsappAppSecret && config.requireWebhookSignature && !config.allowUnsignedWebhooks ? "ok" : "err" }
  ];

  return badges.map((badge) => `<span class="health-pill ${badge.className}">${escapeHtml(badge.label)}</span>`).join("");
}

function renderCrmDashboard(list) {
  const stats = buildInboxMetrics(list);
  const total = Math.max(1, stats.total);
  const scheduledPct = Math.round((stats.confirmed / total) * 100);
  const attentionCount = stats.urgent + stats.misunderstood + stats.stuck + stats.windowRisk;
  const revenue = estimateInboxRevenue(list);
  const next = buildDashboardPriorityList(list);

  return `<section class="crm-dashboard" aria-label="Resumen premium del CRM">
    <div class="crm-dashboard-head">
      <div>
        <span>Panel operativo</span>
        <strong>${stats.followup} pacientes por atender · ${stats.resolved} resueltas</strong>
      </div>
      <a href="/inbox?filter=priority">Ver prioridad</a>
    </div>
    <div class="crm-dashboard-grid">
      <div><strong>${scheduledPct}%</strong><span>Conversion a cita</span></div>
      <div><strong>${attentionCount}</strong><span>Alertas reales</span></div>
      <div><strong>${stats.noReply}</strong><span>Sin responder</span></div>
      <div><strong>${formatMoney(revenue.estimatedRevenue)}</strong><span>Venta estimada</span></div>
      <div><strong>${revenue.promoCount}</strong><span>Promos $${escapeHtml(config.promotionPrice)}</span></div>
      <div><strong>${stats.resolved}</strong><span>Casos cerrados</span></div>
    </div>
    <div class="crm-dashboard-next">
      <span>Atender primero</span>
      ${next.length
        ? next.map((item) => `<a href="/inbox?${buildInboxQuery({ phone: item.phoneNumber, filter: "priority" })}"><strong>${escapeHtml(item.name)}</strong><em>${escapeHtml(item.status)}</em></a>`).join("")
        : `<p>Sin pendientes criticos ahora.</p>`
      }
    </div>
  </section>`;
}

function renderReceptionDesk(list, { currentFilter = "all", query = "" } = {}) {
  const queue = buildReceptionQueueSummary(list);
  const cards = [
    ["needsReply", "Por contestar", "followup"],
    ["missingEmail", "Falta correo", "waiting"],
    ["readyToConfirm", "Por confirmar", "awaiting_confirmation"],
    ["resultsPending", "Resultados", "results"],
    ["stuck", "Atoradas", "stuck"],
    ["resolved", "Resueltas", "resolved"]
  ];

  return `<section class="reception-card" aria-label="Mesa de recepcion">
    <div class="reception-head">
      <div>
        <span>Recepcion</span>
        <strong>Cola diaria de trabajo</strong>
      </div>
      <a href="/inbox?${buildInboxQuery({ q: query, filter: "followup" })}">Sin responder</a>
    </div>
    <div class="reception-grid">
      ${cards
        .map(([key, label, targetFilter]) => `<a class="reception-metric${currentFilter === targetFilter ? " active" : ""}" href="/inbox?${buildInboxQuery({ q: query, filter: targetFilter })}">
          <strong>${escapeHtml(queue[key] ?? 0)}</strong>
          <span>${escapeHtml(label)}</span>
        </a>`)
        .join("")}
    </div>
    <div class="reception-next">
      <span>Siguiente tarea</span>
      ${
        queue.nextTasks.length
          ? queue.nextTasks.map((task) => `<a href="/inbox?${buildInboxQuery({ phone: task.phoneNumber, q: query, filter: currentFilter })}">
              <strong>${escapeHtml(task.name)}</strong>
              <em>${escapeHtml(task.nextLabel)}</em>
              <small>${escapeHtml(task.status)} · ${escapeHtml(formatPhoneForInbox(task.phoneNumber))}</small>
            </a>`).join("")
          : `<p>Sin tareas abiertas de recepcion.</p>`
      }
    </div>
  </section>`;
}

function renderReceptionReport(list) {
  const queue = buildReceptionQueueSummary(list);
  const lines = [
    "Reporte de recepcion",
    `Por contestar: ${queue.needsReply}`,
    `Falta correo: ${queue.missingEmail}`,
    `Por confirmar: ${queue.readyToConfirm}`,
    `Resultados pendientes: ${queue.resultsPending}`,
    `Pacientes atoradas: ${queue.stuck}`,
    `Resueltas: ${queue.resolved}`,
    "",
    "Siguientes tareas:",
    ...(queue.nextTasks.length
      ? queue.nextTasks.map((task, index) => `${index + 1}. ${task.name} (${formatPhoneForInbox(task.phoneNumber)}): ${task.nextLabel} - ${task.status}`)
      : ["Sin tareas abiertas."])
  ].join("\n");

  return `<div class="diagnostics-card reception-report" style="margin-top:0">
    <div class="diagnostics-head"><strong>Reporte de recepcion</strong><span class="tag confirmed">${queue.total} pacientes</span></div>
    <p style="font-size:12px;color:var(--muted);margin:0 0 8px">Resumen rapido para copiar al cierre de turno.</p>
    <textarea readonly rows="9">${escapeHtml(lines)}</textarea>
  </div>`;
}

function renderReceptionChecklist(checklist) {
  if (!checklist) return "";
  const percent = checklist.total > 0 ? Math.round((checklist.completeCount / checklist.total) * 100) : 0;
  return `<div class="panel-section reception-checklist-panel">
    <div class="checklist-head">
      <div>
        <h2>Checklist recepcion</h2>
        <span>${checklist.completeCount}/${checklist.total} completo</span>
      </div>
      <strong>${percent}%</strong>
    </div>
    <div class="checklist-progress"><span style="width:${percent}%"></span></div>
    ${
      checklist.nextMissing
        ? `<div class="next-missing"><strong>Siguiente:</strong> ${escapeHtml(checklist.nextMissing.label)} · ${escapeHtml(checklist.nextMissing.detail)}</div>`
        : `<div class="next-missing done"><strong>Todo listo:</strong> esta conversacion no tiene pendientes operativos claros.</div>`
    }
    <div class="checklist-list">
      ${checklist.items.map((item) => `<div class="checklist-row ${item.done ? "done" : "pending"}">
        <span>${item.done ? "OK" : "Falta"}</span>
        <div>
          <strong>${escapeHtml(item.label)}</strong>
          <small>${escapeHtml(item.detail)}</small>
        </div>
      </div>`).join("")}
    </div>
  </div>`;
}

function buildDashboardPriorityList(list) {
  return sortInboxConversations(list, Date.now())
    .filter((conversation) => getInboxConversationStatus(conversation).priority <= 5 || conversation.messages?.at(-1)?.sender === "patient")
    .slice(0, 3)
    .map((conversation) => ({
      phoneNumber: conversation.phoneNumber,
      name: getConversationDisplayName(conversation),
      status: getInboxConversationStatus(conversation).label
    }));
}

function estimateInboxRevenue(list) {
  const consultation = Number(String(config.consultationPrice ?? "1000").replace(/[^\d.]/g, "")) || 1000;
  const promotion = Number(String(config.promotionPrice ?? "1200").replace(/[^\d.]/g, "")) || 1200;
  let estimatedRevenue = 0;
  let promoCount = 0;
  let confirmedCount = 0;

  for (const conversation of list) {
    if (conversation?.appointment?.status !== "confirmed") continue;
    confirmedCount += 1;
    const text = normalizeText([
      conversation.appointment?.reason,
      conversation.appointment?.paymentType,
      ...(conversation.tags ?? [])
    ].filter(Boolean).join(" "));
    const isPromo = /promo|promocion|paquete|1200|chequeo/.test(text);
    if (isPromo) promoCount += 1;
    estimatedRevenue += isPromo ? promotion : consultation;
  }

  return { estimatedRevenue, promoCount, confirmedCount };
}

function renderCrmPipeline(list, { currentFilter = "all", query = "" } = {}) {
  const stages = [
    { key: "followup", label: "Nuevo", filter: "followup", hint: "Mensaje entrante" },
    { key: "waiting", label: "Esperando datos", filter: "waiting", hint: "Nombre, correo, fecha" },
    { key: "awaiting_confirmation", label: "Por confirmar", filter: "awaiting_confirmation", hint: "Falta SI/NO" },
    { key: "results", label: "Resultados", filter: "results", hint: "Correo confirmado" },
    { key: "human", label: "Humano", filter: "human", hint: "Bot pausado" },
    { key: "confirmed", label: "Agendada", filter: "confirmed", hint: "Cita lista" }
  ];

  return `<section class="pipeline-card" aria-label="Pipeline del consultorio">
    <div class="pipeline-head">
      <div>
        <span>Pipeline CRM</span>
        <strong>Flujo de pacientes</strong>
      </div>
      <a href="/inbox?${buildInboxQuery({ q: query, filter: "all" })}">Todos</a>
    </div>
    <div class="pipeline-grid">
      ${stages.map((stage) => renderPipelineStage(stage, list, { currentFilter, query })).join("")}
    </div>
  </section>`;
}

function renderPipelineStage(stage, list, { currentFilter, query }) {
  const matching = filterInboxConversationList(list, query, stage.filter);
  const sample = sortInboxConversations(matching, Date.now(), { newestPatientFirst: stage.filter === "followup" }).slice(0, 2);
  const active = currentFilter === stage.filter ? " active" : "";

  return `<a class="pipeline-stage${active}" href="/inbox?${buildInboxQuery({ q: query, filter: stage.filter })}">
    <div class="pipeline-stage-top">
      <strong>${escapeHtml(stage.label)}</strong>
      <span>${matching.length}</span>
    </div>
    <em>${escapeHtml(stage.hint)}</em>
    <div class="pipeline-sample">
      ${sample.length
        ? sample.map((conversation) => `<small>${escapeHtml(getConversationDisplayName(conversation))}</small>`).join("")
        : `<small>Sin pacientes</small>`
      }
    </div>
  </a>`;
}

function renderTodayMetrics(list) {
  const tz = config.clinicTimezone;
  const todayISO = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

  let total = 0;
  let promoLeads = 0;
  let scheduled = 0;
  let human = 0;

  for (const conv of list) {
    const convDate = conv.updatedAt ? new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(conv.updatedAt)) : "";
    if (convDate !== todayISO) continue;
    total++;
    const tags = conv.tags ?? [];
    if (tags.some((t) => t.includes("Promo") || t.includes("promo"))) promoLeads++;
    if (conv.appointment?.slotStart) scheduled++;
    if (conv.botPaused) human++;
  }

  const pct = total > 0 ? Math.round((scheduled / total) * 100) : 0;

  return `<div class="metrics-card">
    <div class="metrics-head"><strong>Hoy</strong></div>
    <div class="metrics-grid">
      <div class="metric-cell"><strong>${total}</strong><span>Convs</span></div>
      <div class="metric-cell"><strong>${promoLeads}</strong><span>Promo</span></div>
      <div class="metric-cell"><strong>${scheduled}</strong><span>Agendadas</span></div>
      <div class="metric-cell"><strong>${pct}%</strong><span>Conversion</span></div>
      <div class="metric-cell"><strong>${human}</strong><span>Humano</span></div>
    </div>
  </div>`;
}

function renderConversionMetrics(list) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const computePeriod = (days) => {
    const cutoff = now - days * dayMs;
    let total = 0;
    let scheduled = 0;
    for (const conv of list) {
      const ts = conv.updatedAt ? new Date(conv.updatedAt).getTime() : 0;
      if (!ts || ts < cutoff) continue;
      total++;
      if (conv.appointment?.slotStart) scheduled++;
    }
    return { total, scheduled, pct: total > 0 ? Math.round((scheduled / total) * 100) : 0 };
  };

  const week = computePeriod(7);
  const month = computePeriod(30);

  const cutoff30 = now - 30 * dayMs;
  const tagCounts = new Map();
  for (const conv of list) {
    const ts = conv.updatedAt ? new Date(conv.updatedAt).getTime() : 0;
    if (!ts || ts < cutoff30) continue;
    for (const tag of conv.tags ?? []) {
      const clean = String(tag).trim();
      if (clean) tagCounts.set(clean, (tagCounts.get(clean) ?? 0) + 1);
    }
  }
  const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topTagsHtml = topTags.length > 0
    ? topTags.map(([tag, count]) => `<li style="display:flex;justify-content:space-between;padding:2px 0"><span>${escapeHtml(tag)}</span><strong>${count}</strong></li>`).join("")
    : `<li style="color:var(--muted)">Aun sin datos suficientes</li>`;

  return `<div class="metrics-card">
    <div class="metrics-head"><strong>Conversion</strong></div>
    <div style="display:flex;gap:8px;margin-bottom:8px">
      ${renderConvPeriodCell("7 dias", week)}
      ${renderConvPeriodCell("30 dias", month)}
    </div>
    <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Temas mas preguntados (30d)</div>
    <ul style="list-style:none;margin:0;padding:0;font-size:12px">${topTagsHtml}</ul>
  </div>`;
}

function renderConvPeriodCell(label, data) {
  return `<div style="flex:1;background:#f4f4f6;border-radius:6px;padding:8px;text-align:center">
    <div style="font-size:11px;color:var(--muted)">${escapeHtml(label)}</div>
    <div style="font-size:18px;font-weight:700">${data.pct}%</div>
    <div style="font-size:11px;color:var(--muted)">${data.scheduled}/${data.total} agendadas</div>
  </div>`;
}

function renderInboxDiagnostics(diagnostics, csrf) {
  if (!diagnostics) return "";
  const rows = diagnostics.items
    .map((item) => {
      const dotClass = item.ok ? "ok" : "err";
      return `<div class="diagnostic-row">
        <span class="dot ${dotClass}"></span>
        <strong>${escapeHtml(item.label)}</strong>
        <span>${escapeHtml(item.detail)}</span>
      </div>`;
    })
    .join("");

  return `<div class="diagnostics-card">
    <div class="diagnostics-head">
      <strong>Diagnostico rapido</strong>
      <span class="tag ${diagnostics.ready ? "confirmed" : "urgent"}">${diagnostics.ready ? "Listo" : "Revisar"}</span>
    </div>
    <div class="diagnostics-grid">
      ${rows}
      <div class="diagnostic-row">
        <span class="dot ${diagnostics.activeLocksCount > 0 ? "warn" : "ok"}"></span>
        <strong>Locks</strong>
        <span>${diagnostics.activeLocksCount} horarios apartados temporalmente</span>
      </div>
    </div>
    <form class="quick-check-form" method="post" action="/inbox/quick-check">
      <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
      <button type="submit">Revisar robot ahora</button>
    </form>
  </div>`;
}

function renderInboxDiagnosticsCompact(diagnostics) {
  if (!diagnostics) return "";
  const rows = diagnostics.items
    .slice(0, 5)
    .map((item) => {
      const dotClass = item.ok ? "ok" : "err";
      return `<div class="diagnostic-row">
        <span class="dot ${dotClass}"></span>
        <strong>${escapeHtml(item.label)}</strong>
        <span>${escapeHtml(item.detail)}</span>
      </div>`;
    })
    .join("");

  return `<details class="diagnostics-card diagnostics-compact">
    <summary>
      <strong>Diagnostico rapido</strong>
      <span class="tag ${diagnostics.ready ? "confirmed" : "urgent"}">${diagnostics.ready ? "Listo" : "Revisar"}</span>
    </summary>
    <div class="diagnostics-grid">
      ${rows}
      <div class="diagnostic-row">
        <span class="dot ${diagnostics.activeLocksCount > 0 ? "warn" : "ok"}"></span>
        <strong>Locks</strong>
        <span>${diagnostics.activeLocksCount} horarios apartados temporalmente</span>
      </div>
    </div>
  </details>`;
}

function renderDailyReportsSection(log, csrf) {
  const todayISO = new Intl.DateTimeFormat("en-CA", { timeZone: config.clinicTimezone }).format(new Date());
  const generateForm = `<form class="quick-check-form" method="post" action="/inbox/daily-report">
    <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
    <input name="mode" type="hidden" value="generate">
    <button type="submit">Generar reporte ahora</button>
  </form>`;
  const writeForm = `<details class="report-compose" open>
    <summary>Escribir reporte manual</summary>
    <form class="report-form" method="post" action="/inbox/daily-report">
      <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
      <input name="mode" type="hidden" value="manual">
      <label>Fecha
        <input name="date" type="date" value="${escapeHtml(todayISO)}" required>
      </label>
      <label>Titulo opcional
        <input name="title" maxlength="120" placeholder="Ej. Pendientes de hoy, llamadas, incidencias">
      </label>
      <label>Reporte
        <textarea name="body" rows="6" maxlength="4000" placeholder="Escribe aqui lo que paso hoy: pacientes pendientes, pagos, llamadas, cosas por revisar..." required></textarea>
      </label>
      <button type="submit">Guardar reporte escrito</button>
    </form>
  </details>`;
  if (!log || log.length === 0) {
    return `<div class="diagnostics-card" style="margin-top:0">
      <div class="diagnostics-head"><strong>Reportes diarios</strong></div>
      <p style="font-size:12px;color:var(--muted);padding:6px 0">${
        config.enableDailyReport
          ? `El primer reporte se genera a las ${config.dailyReportHour}:00 h.`
          : "El reporte automatico esta apagado; puedes generarlo manualmente aqui."
      }</p>
      ${writeForm}
      ${generateForm}
    </div>`;
  }
  const items = log.map((entry) => {
    const timeLabel = entry.generatedAt
      ? new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: config.clinicTimezone }).format(new Date(entry.generatedAt))
      : "";
    const lines = escapeHtml(String(entry.text ?? "")).replace(/\n/g, "<br>");
    const sourceLabel = entry.source === "manual" ? "Escrito" : entry.source === "quick_check" ? "Revision" : "Automatico";
    return `<details class="report-entry">
      <summary><strong>${escapeHtml(entry.date)}</strong><span class="tag">${escapeHtml(sourceLabel)}</span>${timeLabel ? ` <span style="color:var(--muted);font-size:11px">${timeLabel}</span>` : ""}</summary>
      <div class="report-body">${lines}</div>
    </details>`;
  }).join("");
  return `<div class="diagnostics-card" style="margin-top:0">
    <div class="diagnostics-head"><strong>Reportes diarios</strong><span class="tag confirmed">${log.length}</span></div>
    ${writeForm}
    ${generateForm}
    ${items}
  </div>`;
}

function renderCancelDaySection(csrf) {
  if (!isDatabaseEnabled()) return "";
  return `<div class="diagnostics-card" style="margin-top:0">
    <details>
      <summary style="cursor:pointer;font-weight:600;font-size:13px;">🗓️ Cancelar citas de un dia</summary>
      <form method="post" action="/inbox/cancel-day" style="margin-top:8px" onsubmit="return confirm('¿Cancelar TODAS las citas del dia seleccionado y notificar a los pacientes?')">
        <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Fecha a cancelar</label>
        <input name="date" type="date" required style="width:100%;margin-bottom:8px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px">
        <label style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px">Mensaje para pacientes (opcional)</label>
        <textarea name="message" rows="3" placeholder="Lo sentimos, las citas del dia han sido canceladas..." style="width:100%;margin-bottom:8px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px;resize:vertical"></textarea>
        <p style="font-size:11px;color:var(--muted);margin:0 0 8px">Por reglas de Meta, a quien escribio hace +24h se le avisa por WhatsApp solo si hay plantilla aprobada; si no, por correo o se lista para llamada.</p>
        <button class="button-danger" type="submit" style="width:100%">Cancelar y notificar pacientes</button>
      </form>
    </details>
  </div>`;
}

function normalizeInboxTab(value) {
  return ["patients", "diagnostics", "reports", "tools"].includes(value) ? value : "patients";
}

function renderInboxTabs(active, { phone, q, filter } = {}) {
  const tabs = [
    ["patients", "Pacientes"],
    ["diagnostics", "Estado"],
    ["reports", "Reportes"],
    ["tools", "Herramientas"]
  ];
  return `<nav class="inbox-tabs" aria-label="Secciones del inbox">
    ${tabs
      .map(([key, label]) => {
        const href = `/inbox?${buildInboxQuery({ phone, q, filter, tab: key })}`;
        return `<a class="${active === key ? "active" : ""}" href="${href}">${escapeHtml(label)}</a>`;
      })
      .join("")}
  </nav>`;
}

function renderInboxQuickFilters(current, query = "") {
  const filters = [
    ["all", "Todas"],
    ["priority", "Prioridad"],
    ["urgent", "Urgentes"],
    ["results", "Resultados"],
    ["misunderstood", "Bot no entendio"],
    ["awaiting_confirmation", "Por confirmar"],
    ["reschedule", "Reagendar"],
    ["cancel", "Cancelar"],
    ["closing_window", "24h"],
    ["followup", "Sin responder"],
    ["stuck", "Atoradas"],
    ["waiting", "Esperando datos"],
    ["confirmed", "Agendadas"],
    ["human", "Humano"],
    ["resolved", "Resueltas"]
  ];

  return `<div class="quick-filters">
    ${filters
      .map(([value, label]) => `<a class="filter-chip${value === current ? " active" : ""}" href="/inbox?${buildInboxQuery({ q: query, filter: value })}">${escapeHtml(label)}</a>`)
      .join("")}
  </div>`;
}

function renderCrmCommandCenter(selected, { csrf, selectedPhone, selectedStatus, windowState }) {
  if (!selected) return "";
  const action = buildCrmNextAction(selected);
  const temperature = getPatientTemperature(selected);
  const profile = buildPatientCrmProfile(selected);
  const stageClass = getCrmStageClass(profile);

  return `<section class="crm-command ${escapeHtml(action.level)}" aria-label="Siguiente accion del CRM">
    <div class="crm-command-top">
      <div>
        <span class="crm-command-eyebrow">Siguiente accion</span>
        <strong>${escapeHtml(action.title)}</strong>
        <p>${escapeHtml(action.detail)}</p>
      </div>
      <span class="temperature-pill ${escapeHtml(temperature.className)}">${escapeHtml(temperature.label)}</span>
    </div>
    <div class="crm-command-footer">
      <div class="crm-command-tags">
        <span class="tag ${selectedStatus.className}">${escapeHtml(selectedStatus.label)}</span>
        <span class="tag ${windowState.className}">${escapeHtml(windowState.label)}</span>
        <span class="crm-stage ${stageClass}">${escapeHtml(profile.patientStage ?? "Lead")}</span>
      </div>
      <div class="crm-command-actions">
        ${renderCrmPrimaryAction(action, selected, selectedPhone, csrf)}
        <button type="button" class="button-secondary" data-scroll-chat>Leer chat</button>
      </div>
    </div>
    ${renderCrmSmartShortcuts(selected, action)}
  </section>`;
}

function renderCrmSmartShortcuts(selected, action) {
  const status = getInboxConversationStatus(selected);
  const shortcuts = [];

  if (action.key === "results_email" || status.key === "results") {
    shortcuts.push({
      label: "Aviso resultados",
      text: "Por privacidad, los resultados o estudios se entregan unicamente por el correo confirmado de la paciente o de forma presencial. Por WhatsApp solo podemos registrar tu solicitud y pasarla a revision humana."
    });
  }

  if (status.className === "waiting") {
    const step = status.shortLabel ?? "dato";
    shortcuts.push({
      label: `Pedir ${step}`,
      text: `Claro 😊 Para continuar, ¿me compartes tu ${step}?`
    });
  }

  if (status.key === "awaiting_confirmation") {
    shortcuts.push({
      label: "Confirmar datos",
      text: "Antes de agendar, revisa que los datos esten correctos. Si todo esta bien responde SI, si quieres cambiar algo dime el dato correcto."
    });
  }

  if (selected?.appointment?.slotStart) {
    shortcuts.push({
      label: "Cita registrada",
      text: `Tu cita esta registrada para ${formatAppointmentFull(selected.appointment.slotStart)}. Si necesitas cambiarla, puedo ayudarte a reagendar.`
    });
  }

  shortcuts.push(
    {
      label: "Promo $1200",
      text: "La promocion del chequeo ginecologico completo es de $1,200 MXN. Si gustas, puedo ayudarte a revisar horarios disponibles para agendar."
    },
    {
      label: "Ubicacion",
      text: buildLocationMessage(config.clinicAddress)
    }
  );

  const unique = [];
  const seen = new Set();
  for (const item of shortcuts) {
    const key = normalizeText(item.label);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return `<div class="crm-smart-actions" aria-label="Respuestas inteligentes">
    <span>Respuestas sugeridas</span>
    <div>
      ${unique.slice(0, 5).map((item) => `<button type="button" data-template="${escapeHtml(item.text)}">${escapeHtml(item.label)}</button>`).join("")}
    </div>
  </div>`;
}

function renderPatientSignalStrip(selected) {
  if (!selected) return "";

  const profile = buildPatientCrmProfile(selected);
  const status = getInboxConversationStatus(selected);
  const windowState = getWhatsAppWindowState(selected);
  const action = buildCrmNextAction(selected);
  const emailState = profile.email ? `Correo ${maskEmail(profile.email)}` : "Sin correo confirmado";
  const appointmentState = profile.nextAppointment?.slotStart
    ? `Proxima cita ${formatAppointmentShort(profile.nextAppointment.slotStart)}`
    : selected.appointment?.slotStart
      ? `Cita ${formatAppointmentShort(selected.appointment.slotStart)}`
      : "Sin cita activa";
  const riskFlags = profile.riskFlags?.length ? profile.riskFlags.slice(0, 2).join(", ") : "Sin alertas criticas";
  const signals = [
    { label: "Etapa", value: profile.patientStage ?? "Lead", className: "stage" },
    { label: "Accion", value: action.cta ?? action.title, className: action.level },
    { label: "Cita", value: appointmentState, className: selected.appointment?.status === "confirmed" ? "success" : "info" },
    { label: "Correo", value: emailState, className: profile.email ? "success" : "warning" },
    { label: "Ventana", value: windowState.label, className: windowState.className },
    { label: "Riesgo", value: riskFlags, className: status.priority <= 3 ? "danger" : "info" }
  ];

  return `<section class="patient-signal-strip" aria-label="Senales rapidas del paciente">
    ${signals.map((signal) => `<div class="patient-signal ${escapeHtml(signal.className)}">
      <span>${escapeHtml(signal.label)}</span>
      <strong>${escapeHtml(signal.value)}</strong>
    </div>`).join("")}
  </section>`;
}

function renderCrmPrimaryAction(action, selected, selectedPhone, csrf) {
  if (action.key === "results_email") {
    return `<a class="button-link" href="#send-file-email" data-open-results-email>📤 Archivo al correo</a>`;
  }

  if (action.key === "template") {
    return `<button type="button" data-open-template-actions>Abrir plantillas</button>`;
  }

  if (action.key === "urgent") {
    return `<form method="post" action="/inbox/resolve-urgent">
      <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
      <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
      <button type="submit">Marcar urgente resuelto</button>
    </form>`;
  }

  if (action.key === "waiting" || action.key === "reschedule") {
    return `<form method="post" action="/inbox/reprompt">
      <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
      <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
      <button type="submit">Reenviar paso</button>
    </form>`;
  }

  if (action.key === "human" && selected?.botPaused) {
    return `<form method="post" action="/inbox/release">
      <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
      <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
      <button type="submit">Devolver al bot</button>
    </form>`;
  }

  if (action.key === "resolved") {
    return `<button type="button" data-scroll-chat>${escapeHtml(action.cta ?? "Ver chat")}</button>`;
  }

  if (action.key === "misunderstood") {
    return `<button type="button" data-open-knowledge-panel>Revisar FAQ</button>`;
  }

  return `<button type="button" data-scroll-chat>${escapeHtml(action.cta ?? "Leer chat")}</button>`;
}

function renderLeadOriginSection(conv) {
  if (!conv) return "";
  const tags = conv.tags ?? [];
  const isPromo = tags.some((t) => /promo|1200|paquete|chequeo/i.test(t));
  const isMetaAds = tags.some((t) => /facebook|instagram|meta ads|anuncio/i.test(t));
  const temp = tags.find((t) => /lead frio|lead tibio|lead caliente/i.test(t));
  const origin = isMetaAds ? "Meta Ads" : isPromo ? "Promo $1,200" : "Organico / directo";
  const interestTags = tags.filter((t) => /promo|1200|paquete|chequeo|ultrasonido|papanicolao|colposco/i.test(t));

  return `<div class="panel-section">
    <h2>Origen del lead</h2>
    <div class="info-grid">
      <div class="info-row"><span>Canal</span>${escapeHtml(origin)}</div>
      ${temp ? `<div class="info-row"><span>Temperatura</span>${escapeHtml(temp)}</div>` : ""}
      ${interestTags.length ? `<div class="info-row"><span>Interes</span>${escapeHtml(interestTags.join(", "))}</div>` : ""}
    </div>
  </div>`;
}

function renderPatientCrmProfile(profile) {
  if (!profile) return "";
  const nextAppointment = profile.nextAppointment?.slotStart ? formatAppointmentFull(profile.nextAppointment.slotStart) : "Sin proxima cita";
  const lastAppointment = profile.lastAppointment?.slotStart ? formatAppointmentFull(profile.lastAppointment.slotStart) : "Sin cita previa";
  const firstTouch = profile.firstTouch ? formatInboxDate(profile.firstTouch) : "Sin dato";
  const flags = profile.riskFlags ?? [];
  const stageClass = getCrmStageClass(profile);
  const displayName = profile.name ?? "Paciente sin nombre";
  const contactLine = [profile.phoneNumber ? formatPhoneForInbox(profile.phoneNumber) : "", profile.email ? maskEmail(profile.email) : ""]
    .filter(Boolean)
    .join(" · ");

  return `<div class="panel-section crm-profile">
    <div class="crm-hero">
      <div class="crm-hero-top">
        <div>
          <span class="crm-eyebrow">CRM del paciente</span>
          <strong class="crm-name">${escapeHtml(displayName)}</strong>
          <div class="crm-subtitle">${escapeHtml(contactLine || "Sin contacto completo")}</div>
        </div>
        <span class="crm-stage ${stageClass}">${escapeHtml(profile.patientStage ?? "Lead")}</span>
      </div>
      <div class="crm-next-card">
        <span>Proxima accion</span>
        <strong>${escapeHtml(profile.nextAppointment?.slotStart ? `Cita: ${nextAppointment}` : flags.length ? `Revisar: ${flags[0]}` : "Dar seguimiento cuando vuelva a escribir")}</strong>
      </div>
    </div>
    <div class="crm-kpis">
      <div><strong>${escapeHtml(profile.appointmentCount ?? 0)}</strong><span>Citas</span></div>
      <div><strong>${escapeHtml(profile.cancelledCount ?? 0)}</strong><span>Canceladas</span></div>
      <div><strong>${escapeHtml(profile.notesCount ?? 0)}</strong><span>Notas</span></div>
    </div>
    <div class="crm-mini-grid">
      <div class="crm-mini"><span>Servicio</span><strong>${escapeHtml(profile.latestReason ?? "Sin servicio")}</strong></div>
      <div class="crm-mini"><span>Tipo</span><strong>${escapeHtml(profile.latestPaymentType ?? "Sin dato")}</strong></div>
      <div class="crm-mini"><span>Primera vez</span><strong>${escapeHtml(profile.firstVisit ?? "Sin dato")}</strong></div>
      <div class="crm-mini"><span>No asistio</span><strong>${escapeHtml(profile.noShowCount ?? 0)}</strong></div>
    </div>
    <div class="crm-timeline">
      <div class="crm-step"><span>Primera actividad</span><strong>${escapeHtml(firstTouch)}</strong></div>
      <div class="crm-step"><span>Ultima cita</span><strong>${escapeHtml(lastAppointment)}</strong></div>
      <div class="crm-step"><span>Proxima cita</span><strong>${escapeHtml(nextAppointment)}</strong></div>
    </div>
    ${
      flags.length
        ? `<div class="thread-tags crm-flags">${flags.map((flag) => `<span class="tag">${escapeHtml(flag)}</span>`).join("")}</div>`
        : `<div class="empty-state">Sin alertas operativas.</div>`
    }
  </div>`;
}

function getCrmStageClass(profile) {
  const stage = normalizeText(profile?.patientStage ?? "");
  if (stage.includes("proxima")) return "active";
  if (stage.includes("recurrente") || stage.includes("1 cita")) return "returning";
  if (stage.includes("sin cita")) return "attention";
  return "lead";
}

function renderPatientPanel(selected, { csrf, selectedPhone, selectedStatus, windowState, knowledgeSuggestions }) {
  if (!selected) {
    return `<aside class="patient-panel">
      <div class="panel-section">
        <h2>Ficha del paciente</h2>
        <div class="empty-state">Selecciona una conversacion para ver resumen, cita, notas internas y FAQs.</div>
      </div>
      ${renderKnowledgePanel(knowledgeSuggestions, csrf, "")}
    </aside>`;
  }

  const summary = buildLocalConversationSummary(selected);
  const crmProfile = buildPatientCrmProfile(selected);
  const receptionChecklist = buildReceptionChecklist(selected);
  const offeredSlots = getOfferedSlots(selected);
  const appointment = selected.appointment;
  const notes = selected.notes ?? [];
  const tagsText = (selected.tags ?? []).join(", ");

  return `<aside class="patient-panel">
    <div class="panel-section">
      <h2>Prioridad</h2>
      <div class="thread-tags">
        <span class="tag ${selectedStatus.className}">${escapeHtml(selectedStatus.label)}</span>
        <span class="tag ${windowState.className}">${escapeHtml(windowState.label)}</span>
        ${selected.botPaused ? `<span class="tag human">Modo humano</span>` : ""}
      </div>
    </div>

    <div class="panel-section">
      <h2>Resumen local</h2>
      <ul class="summary-list">
        <li><strong>Intencion:</strong> ${escapeHtml(summary.intent)}</li>
        <li><strong>Fecha mencionada:</strong> ${escapeHtml(summary.dateMention)}</li>
        <li><strong>Ultimo mensaje:</strong> ${escapeHtml(summary.lastPatientMessage)}</li>
        <li><strong>Requiere humano:</strong> ${summary.requiresHuman ? "Si" : "No"}</li>
      </ul>
    </div>

    <div class="panel-section">
      <h2>Paciente</h2>
      <div class="info-grid">
        <div class="info-row"><span>Nombre</span>${escapeHtml(summary.name)}</div>
        <div class="info-row"><span>Telefono</span>${escapeHtml(formatPhoneForInbox(selected.phoneNumber))}</div>
        <div class="info-row"><span>Ultima actividad</span>${escapeHtml(formatInboxDate(selected.updatedAt))}</div>
        <div class="info-row"><span>Flujo actual</span>${escapeHtml(formatSessionStep(selected.session?.step))}</div>
      </div>
    </div>

    ${renderPatientCrmProfile(crmProfile)}

    ${renderReceptionChecklist(receptionChecklist)}

    ${renderLeadOriginSection(selected)}

    <div class="panel-section">
      <h2>Cita actual</h2>
      ${
        appointment
          ? `<div class="info-grid">
              <div class="info-row"><span>Estado</span>${escapeHtml(appointment.status ?? "confirmed")}</div>
              <div class="info-row"><span>Fecha</span>${escapeHtml(formatAppointmentFull(appointment.slotStart))}</div>
              <div class="info-row"><span>Google Event ID</span>${escapeHtml(appointment.googleEventId ?? "No capturado")}</div>
              <a class="button-link" href="https://calendar.google.com/calendar/u/0/r" target="_blank" rel="noreferrer">Verificar en Calendar</a>
            </div>`
          : `<div class="empty-state">Sin cita confirmada registrada.</div>`
      }
    </div>

    ${renderResultsEmailSection(selected, selectedPhone, csrf)}

    ${(() => {
      const leadTags = (selected.tags ?? []);
      const isMetaAds = leadTags.some(t => /meta ads|facebook|instagram/i.test(t));
      const leadTemp = leadTags.find(t => /^lead (frio|tibio|caliente)$/i.test(t));
      const hasPromo = leadTags.some(t => /promo \$?1200/i.test(t));
      return (isMetaAds || hasPromo) ? `
<div class="panel-section">
  <h2>Lead Info</h2>
  <div class="info-grid">
    ${isMetaAds ? `<div class="info-row"><span>Origen</span>📱 Meta Ads</div>` : ""}
    ${hasPromo ? `<div class="info-row"><span>Interes</span>🎯 Chequeo completo $1,200</div>` : ""}
    ${leadTemp ? `<div class="info-row"><span>Temperatura</span>${escapeHtml(leadTemp)}</div>` : ""}
  </div>
</div>` : "";
    })()}

    <div class="panel-section">
      <h2>Horarios ofrecidos</h2>
      ${
        offeredSlots.length
          ? `<div class="info-grid">${offeredSlots
              .map((slot, index) => `<div class="info-row"><span>Opcion ${index + 1}</span>${escapeHtml(slot.label ?? slot.start ?? "Horario")}</div>`)
              .join("")}</div>`
          : `<div class="empty-state">No hay horarios ofrecidos activos.</div>`
      }
    </div>

    <div class="panel-section">
      <h2>Etiquetas</h2>
      <form class="knowledge-form" method="post" action="/inbox/tags">
        <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
        <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
        <textarea name="tags" rows="2" maxlength="300" placeholder="Urgente, Reagendar, Primera vez">${escapeHtml(tagsText)}</textarea>
        <button type="submit">Guardar etiquetas</button>
      </form>
    </div>

    <div class="panel-section">
      <h2>Notas internas</h2>
      <form class="knowledge-form" method="post" action="/inbox/notes">
        <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
        <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
        <textarea name="note" rows="3" maxlength="2000" placeholder="Nota privada. No se envia al paciente."></textarea>
        <button type="submit">Guardar nota interna</button>
      </form>
      <div class="notes-list">
        ${
          notes.length
            ? notes.map((note) => `<div class="note-card"><small>${escapeHtml(note.author ?? "consultorio")} · ${escapeHtml(formatInboxDate(note.createdAt))}</small>${escapeHtml(note.body)}</div>`).join("")
            : `<div class="empty-state">Aun no hay notas internas.</div>`
        }
      </div>
    </div>

    ${renderKnowledgePanel(knowledgeSuggestions, csrf, selectedPhone)}
	  </aside>`;
}

function renderInboxMetaTemplateActions(conversation, selectedPhone, csrf) {
  if (!conversation) return "";
  const appointment = conversation.appointment;
  const emailRecipient = resolveResultsEmailRecipient({ appointment, conversation });
  const hasEmail = isValidPatientEmail(emailRecipient.email);
  const actions = [
    {
      type: "reengagement",
      label: "Retomar chat",
      configured: Boolean(config.whatsappReengagementTemplate),
      missing: "Falta WHATSAPP_REENGAGEMENT_TEMPLATE"
    },
    {
      type: "results_email",
      label: "Aviso resultados por correo",
      configured: Boolean(config.whatsappResultsEmailTemplate),
      visible: hasEmail,
      missing: "Falta WHATSAPP_RESULTS_EMAIL_TEMPLATE"
    },
    {
      type: "appointment_reminder",
      label: "Recordatorio cita",
      configured: Boolean(config.whatsappReminderTemplate24h),
      visible: Boolean(appointment?.slotStart),
      missing: "Falta WHATSAPP_REMINDER_TEMPLATE_24H"
    },
    {
      type: "cancellation",
      label: "Cancelacion cita",
      configured: Boolean(config.whatsappCancellationTemplate),
      visible: Boolean(appointment?.slotStart),
      missing: "Falta WHATSAPP_CANCELLATION_TEMPLATE"
    },
    {
      type: "reschedule",
      label: "Reagendar cita",
      configured: Boolean(config.whatsappRescheduleTemplate),
      missing: "Falta WHATSAPP_RESCHEDULE_TEMPLATE"
    }
  ].filter((action) => action.visible !== false);

  if (!actions.length) return "";

  return `<details id="template-actions" class="template-actions">
    <summary>
      <div>
        <h2>Plantillas Meta</h2>
        <p>Usalas para responder fuera de la ventana de 24h. Solo funcionan si Meta ya aprobo la plantilla y el nombre esta configurado en Render.</p>
      </div>
    </summary>
    <div class="template-body">
      <div class="template-grid">
        ${actions.map((action) => renderInboxMetaTemplateButton(action, selectedPhone, csrf)).join("")}
      </div>
    </div>
  </details>`;
}

function renderInboxMetaTemplateButton(action, selectedPhone, csrf) {
  if (!action.configured) {
    return `<div class="template-missing">${escapeHtml(action.label)}: ${escapeHtml(action.missing)}</div>`;
  }
  return `<form method="post" action="/inbox/send-template">
    <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
    <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
    <input name="template" type="hidden" value="${escapeHtml(action.type)}">
    <button type="submit">${escapeHtml(action.label)}</button>
  </form>`;
}

function renderResultsEmailSection(conversation, selectedPhone, csrf) {
  const appointment = conversation?.appointment;
  const emailRecipient = resolveResultsEmailRecipient({ appointment, conversation });
  const patientEmail = emailRecipient.email;
  const hasEmail = Boolean(patientEmail);
  const emailIsValid = isValidPatientEmail(patientEmail);
  const emailSourceLabel =
    emailRecipient.source === "appointment"
      ? "Correo de cita registrada"
      : emailRecipient.source === "conversation"
        ? "Correo detectado en la conversacion"
        : "Sin correo confirmado";
  const emailMasked = emailIsValid ? maskEmail(patientEmail) : hasEmail ? "correo no valido" : "sin correo confirmado";
  const emailConfigWarning = !isEmailEnabled()
    ? `<div class="notice compact-notice">Falta configurar RESEND_API_KEY / RESEND_FROM_EMAIL o verificar el dominio en Resend antes de enviar correos reales.</div>`
    : "";

  return `<div class="panel-section results-email-section">
    <h2>Enviar archivo al correo</h2>
    <div class="results-email-card">
      <p><strong>Correo confirmado de paciente:</strong><br>${escapeHtml(emailMasked)}</p>
      <small>${escapeHtml(emailSourceLabel)}${emailRecipient.source === "conversation" ? ". Confirma con la paciente antes de enviar." : ""}</small>
      ${emailConfigWarning}
      ${
        !hasEmail
          ? `<div class="empty-state">Esta paciente todavia no tiene correo confirmado. Pidele su correo y confirmalo antes de enviar archivos.</div>`
          : !emailIsValid
            ? `<div class="empty-state">El correo guardado no parece valido. Corrigelo antes de enviar archivos.</div>`
            : `<a class="button-link results-email-primary" href="#send-file-email" data-open-results-email>📤 Abrir envio seguro por correo</a>
              <small>El archivo se envia solo al correo confirmado. No se manda por WhatsApp y no se guarda en Supabase.</small>`
      }
    </div>
  </div>`;
}

function renderInlineResultsEmailAction(conversation, selectedPhone, csrf) {
  const appointment = conversation?.appointment;
  const emailRecipient = resolveResultsEmailRecipient({ appointment, conversation });
  const patientEmail = emailRecipient.email;
  const hasEmail = Boolean(patientEmail);
  const emailIsValid = isValidPatientEmail(patientEmail);
  const emailMasked = emailIsValid ? maskEmail(patientEmail) : hasEmail ? "correo no valido" : "sin correo confirmado";
  const emailSourceLabel = emailRecipient.source === "appointment" ? "correo de cita" : "correo detectado";

  if (!hasEmail || !emailIsValid) {
    const message = !hasEmail
      ? "Primero pide y confirma el correo de la paciente para poder mandar archivos desde aqui."
      : "El correo guardado no parece valido. Corrigelo antes de enviar archivos.";
    return `<div id="send-file-email" class="results-email-modal" aria-hidden="true">
      <div class="results-email-backdrop" data-close-results-email></div>
      <div class="results-email-dialog">
        <div class="results-email-header">
          <div>
            <strong>📤 Enviar archivo al correo de la paciente</strong>
            <span>${escapeHtml(message)}</span>
          </div>
          <button class="results-email-close" type="button" data-close-results-email aria-label="Cerrar">×</button>
        </div>
        <div class="empty-state">No puedo enviar el archivo hasta tener un correo valido confirmado.</div>
      </div>
    </div>`;
  }

  return `<div id="send-file-email" class="results-email-modal" aria-hidden="true">
    <div class="results-email-backdrop" data-close-results-email></div>
    <div class="results-email-dialog" role="dialog" aria-modal="true" aria-label="Enviar archivo al correo de la paciente">
      <div class="results-email-header">
        <div>
          <strong>📤 Enviar archivo al correo de la paciente</strong>
          <span>${escapeHtml(emailSourceLabel)}: ${escapeHtml(emailMasked)} · PDF, JPG, PNG o WEBP</span>
        </div>
        <button class="results-email-close" type="button" data-close-results-email aria-label="Cerrar">×</button>
      </div>
      <form class="knowledge-form" method="post" action="/inbox/results-email" enctype="multipart/form-data">
        <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
        <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
        <label class="file-row">
          <span>Archivo para enviar al correo confirmado</span>
          <input name="resultFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp" required>
        </label>
        <textarea name="note" rows="3" maxlength="600" placeholder="Nota corta para la paciente (opcional). No diagnosticar ni indicar tratamiento."></textarea>
        <label class="checkbox-row">
          <input name="confirmed" value="yes" type="checkbox" required>
          <span>Confirmo que este archivo corresponde a esta paciente y que el correo fue confirmado.</span>
        </label>
        <button type="submit">Enviar archivo al correo de la paciente</button>
        <small>Al tocar enviar, veras un mensaje de exito o error en el inbox. El archivo NO se manda por WhatsApp.</small>
      </form>
    </div>
  </div>`;
}

function renderMobilePatientSheet(selected, { selectedStatus, windowState }) {
  if (!selected) return "";

  const summary = buildLocalConversationSummary(selected);
  const crmProfile = buildPatientCrmProfile(selected);
  const offeredSlots = getOfferedSlots(selected);
  const appointment = selected.appointment;
  const slotLabels = offeredSlots
    .slice(0, 3)
    .map((slot, index) => `${index + 1}. ${slot.label ?? slot.start ?? "Horario"}`);
  const extraSlots = offeredSlots.length > 3 ? ` +${offeredSlots.length - 3} mas` : "";

  return `<details class="mobile-patient-sheet">
    <summary>Ficha del paciente</summary>
    <div class="mobile-info-grid">
      <div class="mobile-info-row">
        <span>Prioridad</span>
        <div class="thread-tags">
          <span class="tag ${selectedStatus.className}">${escapeHtml(selectedStatus.label)}</span>
          <span class="tag ${windowState.className}">${escapeHtml(windowState.label)}</span>
          ${selected.botPaused ? `<span class="tag human">Modo humano</span>` : ""}
        </div>
      </div>
      <div class="mobile-info-row"><span>Nombre</span>${escapeHtml(summary.name)}</div>
      <div class="mobile-info-row"><span>Telefono</span>${escapeHtml(formatPhoneForInbox(selected.phoneNumber))}</div>
      <div class="mobile-info-row">
        <span>CRM</span>
        <strong>${escapeHtml(crmProfile.patientStage)}</strong>
        <div class="mobile-crm-strip">
          <div><strong>${escapeHtml(crmProfile.appointmentCount)}</strong><span>Citas</span></div>
          <div><strong>${escapeHtml(crmProfile.cancelledCount)}</strong><span>Canceladas</span></div>
          <div><strong>${escapeHtml(crmProfile.notesCount)}</strong><span>Notas</span></div>
        </div>
      </div>
      <div class="mobile-info-row"><span>Flujo</span>${escapeHtml(formatSessionStep(selected.session?.step))}</div>
      <div class="mobile-info-row"><span>Cita</span>${appointment?.slotStart ? escapeHtml(formatAppointmentFull(appointment.slotStart)) : "Sin cita confirmada"}</div>
      <div class="mobile-info-row"><span>Horarios ofrecidos</span>${slotLabels.length ? escapeHtml(`${slotLabels.join(" · ")}${extraSlots}`) : "Sin horarios activos"}</div>
    </div>
  </details>`;
}

function formatSessionStep(step) {
  const labels = {
    collecting: "Recolectando datos",
    collectingEmail: "Esperando correo",
    collectingFirstVisit: "Esperando primera vez",
    collectingService: "Esperando servicio",
    collectingPaymentType: "Esperando tipo de consulta",
    collectingDateOnly: "Esperando fecha",
    choosingSlot: "Esperando horario",
    choosingAvailabilitySlot: "Mostrando disponibilidad",
    confirmingAppointment: "Esperando confirmacion",
    confirmingCancellation: "Confirmando cancelacion",
    confirmingReschedule: "Confirmando reagenda",
    waitlistOffer: "Ofreciendo lista de espera"
  };
  return labels[step] ?? "Sin flujo activo";
}

function renderKnowledgePanel(suggestions, csrf, selectedPhone) {
  const pending = Array.isArray(suggestions) ? suggestions : suggestions.pending ?? [];
  const approved = Array.isArray(suggestions) ? [] : suggestions.approved ?? [];
  const createForm = `<div class="knowledge-card">
    <strong>Agregar respuesta frecuente</strong>
    <form class="knowledge-form" method="post" action="/inbox/knowledge/create">
      <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
      <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
      <input name="intent" maxlength="120" placeholder="Intent: costo_consulta">
      <textarea name="question" rows="2" maxlength="1000" placeholder="Pregunta futura: ej. ¿Atienden sabados?"></textarea>
      <textarea name="variations" rows="2" maxlength="1000" placeholder="Variaciones, una por linea"></textarea>
      <textarea name="answer" rows="3" maxlength="2000" placeholder="Respuesta del bot para esa pregunta"></textarea>
      <input name="priority" type="number" min="1" max="999" value="100" placeholder="Prioridad">
      <select name="action">
        <option value="answer">Responder automaticamente</option>
        <option value="human_handoff">Pasar siempre a humano</option>
      </select>
      <button type="submit">Guardar FAQ</button>
    </form>
  </div>`;
  const pendingCards =
    pending.length === 0
      ? `<div class="empty-state">Sin preguntas no reconocidas pendientes.</div>`
      : pending
          .map(
            (suggestion) => `<div class="knowledge-card">
              <small>${escapeHtml(formatInboxDate(suggestion.createdAt))} · ${escapeHtml(suggestion.category ?? "desconocido")} · ${escapeHtml(formatPhoneForInbox(suggestion.sourcePhone ?? suggestion.conversationPhone ?? ""))}</small>
              <p>${escapeHtml(suggestion.question ?? "Pregunta no capturada")}</p>
              <form class="knowledge-form" method="post" action="/inbox/knowledge/review">
                <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                <input name="id" type="hidden" value="${escapeHtml(suggestion.id)}">
                <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                <textarea name="answer" rows="3" maxlength="2000" placeholder="Escribe la respuesta aprobada">${escapeHtml(suggestion.answer ?? "")}</textarea>
                <input name="intent" maxlength="120" value="${escapeHtml(suggestion.intent ?? "")}" placeholder="Intent">
                <select name="action">
                  <option value="answer"${suggestion.action !== "human_handoff" ? " selected" : ""}>Responder automaticamente</option>
                  <option value="human_handoff"${suggestion.action === "human_handoff" ? " selected" : ""}>Pasar siempre a humano</option>
                </select>
                <div class="knowledge-actions">
                  <button name="status" value="approved" type="submit">Aprobar FAQ</button>
                  <button class="button-secondary" name="status" value="ignored" type="submit">Ignorar</button>
                </div>
              </form>
            </div>`
          )
          .join("");
  const approvedCards =
    approved.length === 0
      ? `<div class="empty-state">Aun no hay FAQs aprobadas.</div>`
      : approved
          .map(
            (suggestion) => `<div class="knowledge-card">
              <small>${suggestion.active === false ? "Inactiva" : "Activa"} · ${escapeHtml(suggestion.category ?? "faq")} · ${escapeHtml(suggestion.action === "human_handoff" ? "Pasa a humano" : "Auto-respuesta")}</small>
              <form class="knowledge-form" method="post" action="/inbox/knowledge/update">
                <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                <input name="id" type="hidden" value="${escapeHtml(suggestion.id)}">
                <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                <textarea name="question" rows="2" maxlength="1000">${escapeHtml(suggestion.question ?? "")}</textarea>
                <textarea name="variations" rows="2" maxlength="1000">${escapeHtml((suggestion.variations ?? []).join("\n"))}</textarea>
                <textarea name="answer" rows="3" maxlength="2000">${escapeHtml(suggestion.answer ?? "")}</textarea>
                <input name="intent" maxlength="120" value="${escapeHtml(suggestion.intent ?? "")}" placeholder="Intent">
                <input name="priority" type="number" min="1" max="999" value="${escapeHtml(suggestion.priority ?? 100)}">
                <select name="action">
                  <option value="answer"${suggestion.action !== "human_handoff" ? " selected" : ""}>Responder automaticamente</option>
                  <option value="human_handoff"${suggestion.action === "human_handoff" ? " selected" : ""}>Pasar siempre a humano</option>
                </select>
                <div class="knowledge-actions">
                  <button type="submit">Guardar cambios</button>
                  <button class="button-secondary" name="active" value="${suggestion.active === false ? "true" : "false"}" type="submit">${suggestion.active === false ? "Activar" : "Desactivar"}</button>
                </div>
              </form>
              <div class="knowledge-actions">
                <form method="post" action="/inbox/knowledge/delete">
                  <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                  <input name="id" type="hidden" value="${escapeHtml(suggestion.id)}">
                  <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                  <button class="button-danger" type="submit">Borrar FAQ</button>
                </form>
              </div>
            </div>`
          )
          .join("");

  return `<div class="knowledge">
    <h2>Preguntas no reconocidas</h2>
    ${pendingCards}
    <h2>FAQs aprobadas</h2>
    ${approvedCards}
    <h2>Nueva FAQ manual</h2>
    ${createForm}
  </div>`;
}

function renderQuickReplies() {
  const replies = [
    ["Menu", "Hola 😊 Soy el asistente virtual del consultorio.\n\nPuedo ayudarte con:\n1. Agendar cita\n2. Ver horarios disponibles\n3. Ubicacion\n4. Costos y promocion\n5. Formas de pago\n6. Servicios\n7. Hablar con una persona\n\n¿Que necesitas?"],
    ["Info promo $1200", "Claro 😊 La promocion es el chequeo ginecologico completo por $1,200.\n\nIncluye:\n✅ Consulta ginecologica\n✅ Papanicolaou\n✅ Ultrasonido pelvico\n✅ Ultrasonido endovaginal\n✅ Revision de mamas\n✅ Apoyo para deteccion oportuna de cancer cervico uterino\n✅ Apoyo para deteccion oportuna de cancer ovarico\n\nEstamos en Plaza de la Paz #20, consultorio 14, segundo piso.\n\n¿Quieres agendar?"],
    ["Que incluye", "El chequeo ginecologico completo de $1,200 incluye: consulta ginecologica, Papanicolaou, ultrasonido pelvico, ultrasonido endovaginal, revision de mamas y apoyo para deteccion oportuna de cancer cervico uterino y ovarico.\n\nTodo con la Dra. Blanca Carranza 😊"],
    ["Preparacion", getIntentResponse("appointment_preparation")],
    ["Duracion", "La cita dura aproximadamente 40 minutos 😊"],
    ["Solo tardes", "Por el momento atendemos de lunes a viernes por la tarde, de 4:40 p.m. a 8:00 p.m."],
    ["No sabados", "Por el momento no atendemos sabados ni domingos. Te puedo ayudar a revisar horarios de lunes a viernes 😊"],
    ["Agendar promo", "Perfecto 😊 Te ayudo a agendar el chequeo ginecologico completo de $1,200. ¿Me puedes decir tu nombre completo?"],
    ["Pedir datos", "Para ayudarte a agendar, ¿me compartes por favor?\n\n1. Nombre completo\n2. Correo confirmado\n3. Si es primera vez con nosotros\n4. Si vienes particular o por red medica"],
    ["Pedir correo", "¿Me compartes tu correo electronico confirmado? Lo usamos para confirmaciones y, si aplica, para enviar archivos de forma segura."],
    ["Archivo por correo", "Claro 😊 Para proteger tu privacidad, los archivos se envian al correo confirmado de la paciente, no por WhatsApp.\n\n¿Me confirmas tu correo electronico?"],
    ["No WhatsApp archivo", "Por privacidad, no enviamos resultados, estudios ni archivos medicos por WhatsApp. Podemos registrarlo y enviarlo al correo confirmado o revisarlo presencialmente."],
    ["Ubicacion", getIntentResponse("location")],
    ["Costo", getIntentResponse("cost")],
    ["Pedir nombre", "Perfecto 😊 ¿A nombre de quien agendamos la cita?"],
    ["Pedir fecha", "Claro 😊 ¿Que dia te gustaria? Puedes decirme hoy, manana, viernes o una fecha especifica."],
    ["Formas de pago", getIntentResponse("payment_methods")],
    ["Requisitos", getIntentResponse("appointment_requirements")],
    ["Relaciones antes del Pap", "Gracias por avisar 😊\n\nPara el Papanicolaou se recomienda evitar relaciones sexuales, duchas vaginales, ovulos, cremas o medicamentos vaginales durante las 48 horas previas.\n\nLo mejor es que confirme el consultorio si conviene realizarlo o reagendar."],
    ["Reagendar", "Claro 😊 Te ayudo a reagendar. ¿Que dia te gustaria para el nuevo horario?"],
    ["Cancelar", "Para cancelar tu cita, ¿puedes confirmarme que deseas cancelarla definitivamente?"],
    ["Confirmar cita", "Gracias 😊 Tu cita queda confirmada. Si necesitas cambiarla o cancelar, avisanos por este medio."],
    ["Pasar a humano", "Claro 😊 Una persona del consultorio revisara tu mensaje y te apoyara por aqui."],
    ["No diagnostico", MEDICAL_CHAT_SAFE_TEXT],
    ["Urgencia medica", "Por seguridad, si presentas dolor intenso, sangrado abundante, fiebre, desmayo o una emergencia, acude a urgencias o busca atencion medica inmediata.\n\nTambien puedo dejar tu mensaje para que una persona del consultorio lo revise."]
  ];

  return `<div class="quick-replies" aria-label="Respuestas rapidas">
    ${replies
      .map(([label, text]) => `<button class="quick-reply" type="button" data-template="${escapeHtml(text)}">${escapeHtml(label)}</button>`)
      .join("")}
  </div>`;
}

async function saveHumanKnowledgeSuggestion(phoneNumber, answer) {
  const conversation = conversations.get(phoneNumber);
  const lastPatientQuestion = conversation?.messages
    ? [...conversation.messages].reverse().find((message) => message.sender === "patient")?.body
    : undefined;
  if (!lastPatientQuestion || answer.length < 8) return;

  await saveKnowledgeSuggestion({
    question: lastPatientQuestion.slice(0, 1000),
    answer: answer.slice(0, 2000),
    sourcePhone: phoneNumber
  });
}

function renderFilterOption(value, label, current) {
  return `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function buildInboxQuery(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

function getConversationDisplayName(conversation) {
  return conversation.appointment?.patientName || extractNameFromMessages(conversation.messages) || formatPhoneForInbox(conversation.phoneNumber);
}

function extractNameFromMessages(messages) {
  const appointmentNotice = [...messages]
    .reverse()
    .find((message) => message.sender === "bot" && message.body.includes("Nueva cita por WhatsApp:"));
  const fromNotice = appointmentNotice?.body.match(/Paciente:\s*([^\n]+)/i)?.[1]?.trim();
  if (fromNotice) return fromNotice;

  const thanks = [...messages]
    .reverse()
    .find((message) => message.sender === "bot" && message.body.match(/Gracias,\s*([^.\n]+)/i));
  return thanks?.body.match(/Gracias,\s*([^.\n]+)/i)?.[1]?.trim();
}

function renderAppointmentCard(appointment) {
  const patientName = appointment.patientName ?? "Sin nombre";
  const dateLabel = formatAppointmentFull(appointment.slotStart);
  const summary = `${patientName} · ${dateLabel}`;
  return `<details class="appointment-card">
    <summary>
      <div>
        <strong>✅ Cita registrada</strong>
        <span>${escapeHtml(summary)}</span>
      </div>
    </summary>
    <div class="appointment-grid">
      <div><span>Paciente</span>${escapeHtml(patientName)}</div>
      <div><span>Fecha</span>${escapeHtml(dateLabel)}</div>
      <div><span>Correo</span>${escapeHtml(appointment.patientEmail ?? "No capturado")}</div>
      <div><span>Tipo</span>${escapeHtml(appointment.paymentType ?? "No capturado")}</div>
      <div><span>Primera vez</span>${escapeHtml(appointment.firstVisit ?? "No capturado")}</div>
      <div><span>Estado</span>${escapeHtml(appointment.status ?? "confirmed")}</div>
    </div>
  </details>`;
}

function renderInboxMessageMedia(media) {
  if (!media) return "";
  const label = media.type === "image" ? "Imagen" : media.type === "video" ? "Video" : "Archivo";
  const icon = media.type === "image" ? "🖼️" : media.type === "video" ? "🎥" : "📎";
  const detail = [media.contentType, media.size ? formatFileSize(media.size) : undefined].filter(Boolean).join(" · ");
  return `<div class="attachment-card">
    <strong>${icon} ${escapeHtml(label)}</strong>
    <span>${escapeHtml(media.filename ?? "archivo")}</span>
    ${detail ? `<small>${escapeHtml(detail)}</small>` : ""}
  </div>`;
}

function formatInboxTagLabel(tag) {
  const normalized = normalizeText(tag);
  if (normalized === "template meta" || normalized === "requiere template meta") return "Fuera de 24h";
  return String(tag ?? "");
}

function uniqueInboxTagLabels(tags) {
  return [...new Set(tags.map(formatInboxTagLabel).filter(Boolean))];
}

function formatPhoneForInbox(phoneNumber) {
  if (!phoneNumber) return "";
  if (phoneNumber.startsWith("521") && phoneNumber.length === 13) {
    return `+52 ${phoneNumber.slice(3, 6)} ${phoneNumber.slice(6, 9)} ${phoneNumber.slice(9)}`;
  }
  if (phoneNumber.startsWith("52") && phoneNumber.length === 12) {
    return `+52 ${phoneNumber.slice(2, 5)} ${phoneNumber.slice(5, 8)} ${phoneNumber.slice(8)}`;
  }
  return phoneNumber;
}

function formatInboxDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: config.clinicTimezone
  }).format(new Date(value));
}

function formatAppointmentShort(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: config.clinicTimezone
  }).format(new Date(value));
}

function formatAppointmentFull(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: config.clinicTimezone
  }).format(new Date(value));
}

async function handleWhatsAppWebhook(body) {
  const messages = extractWhatsAppMessages(body);
  for (const message of messages) {
    if (!checkPhoneRateLimit(message.from)) {
      console.warn(`Phone rate limit exceeded for ${maskPhone(message.from)}`);
      continue;
    }
    if (await alreadyProcessed(message.id, message.from)) continue;

    const from = message.from;

    if (phoneCurrentlyProcessing.has(from)) {
      // Meta already received 200 so it won't retry. A concurrent request from
      // the same phone is almost always a duplicate delivery — skip it.
      console.warn(`Concurrent message skipped for ${maskPhone(from)} — previous still processing`);
      continue;
    }

    phoneCurrentlyProcessing.add(from);
    try {
      if (message.type === "audio") {
        await handleIncomingAudio(from, message.audio ?? {});
        continue;
      }

      const messagePayload = extractWhatsAppMessage(message);
      const messageText = messagePayload.text;
      if (!messageText) continue;

      await handleIncomingText(from, messageText, {
        patientDisplayBody: messagePayload.patientDisplayBody
      });
    } catch (error) {
      logSafeError(`Failed handling WhatsApp message ${message.id ?? "without-id"} from ${maskPhone(from)}`, error);
      await safeSendWhatsAppText(
        from,
        "🙏 Perdon, tuve un problema revisando la agenda. Por favor intenta de nuevo en un momento o escribe directamente al consultorio."
      );
    } finally {
      phoneCurrentlyProcessing.delete(from);
    }
  }
}

function extractWhatsAppMessages(body) {
  return body.entry.flatMap((entry) =>
    entry.changes
      .filter((change) => change.field === "messages")
      .flatMap((change) => change.value?.messages ?? [])
  );
}

function extractWhatsAppMessageText(message) {
  return extractWhatsAppMessage(message).text;
}

function extractWhatsAppMessage(message) {
  if (message.type === "text") {
    return {
      text: message.text?.body,
      patientDisplayBody: message.text?.body
    };
  }
  if (message.type === "interactive") {
    const reply = message.interactive?.list_reply ?? message.interactive?.button_reply;
    const text = slotOptionReplyText(reply?.id) ?? dateOptionReplyText(reply?.id) ?? interactiveReplyMap[reply?.id] ?? reply?.title;
    return {
      text,
      patientDisplayBody: buildInteractivePatientDisplay(reply, text)
    };
  }
  if (message.type === "button") {
    const text = interactiveReplyMap[message.button?.payload] ?? message.button?.text;
    return {
      text,
      patientDisplayBody: buildInteractivePatientDisplay({
        id: message.button?.payload,
        title: message.button?.text
      }, text)
    };
  }
  return { text: undefined, patientDisplayBody: undefined };
}

function buildInteractivePatientDisplay(reply, parsedText) {
  const title = reply?.title ?? parsedText ?? "opcion";
  const id = reply?.id;
  return `Paciente toco: ${title}${id ? `\nPayload: ${id}` : ""}`;
}

async function handleIncomingText(from, text, options = {}) {
  console.log(`Incoming WhatsApp from ${maskPhone(from)}`);
  const lower = text.trim().toLowerCase();
  const normalized = normalizeText(text);
  const detectedIntent = detectIntent(normalized);
  const patientDisplayBody = options.patientDisplayBody ?? text;
  await recordConversationMessage(from, "patient", patientDisplayBody);
  await addConversationTags(from, suggestTagsFromText(normalized, detectedIntent.intent));
  await notifyIncomingPatientMessage(from, patientDisplayBody);

  const conversationState = (await getConversationState(from)) ?? conversations.get(from);
  if (conversationState?.botPaused) {
    if (isHumanPauseExpired(conversationState)) {
      await setConversationHumanMode(from, false);
      setMemoryHumanMode(from, false);
      console.log(`Bot pause expired for ${maskPhone(from)}; auto-released conversation.`);
    } else {
      console.log(`Bot paused for ${maskPhone(from)}; message stored without auto-reply.`);
      webhookRuntimeDiagnostics.lastBotPausedAt = new Date().toISOString();
      return;
    }
  }

  if (lower.startsWith("encuesta ")) {
    await handleSurveyReply(from, lower);
    return;
  }

  const existing = await getPatientSession(from);

  if (await maybeProtectExistingAppointmentFromScheduling(from, normalized, detectedIntent.intent)) {
    return;
  }

  if (existing && isActiveSessionRestart(normalized)) {
    await deletePatientSession(from);
    await sendGreetingMenuToPatient(from);
    return;
  }

  if (existing && isActiveSessionContinue(normalized)) {
    await continueActiveSession(from, existing);
    return;
  }

  if (existing?.step === "promoOffer") {
    await handlePromoOfferReply(from, normalized, detectedIntent.intent);
    return;
  }

  if (existing && detectedIntent.intent === "greeting") {
    await replyWithActiveSessionButtons(from, buildActiveSessionGreeting(existing));
    return;
  }

  if (existing && isVagueActiveSessionReply(normalized)) {
    await replyWithActiveSessionButtons(from, buildVagueActiveSessionPrompt(existing));
    return;
  }

  if (existing && await handleActiveSessionFaqQuestion(from, normalized, detectedIntent.intent, existing)) {
    return;
  }

  if (existing?.step === "collectingEmail" && isSkipEmailText(normalized)) {
    const updated = { ...existing, emailSkipped: true };
    await setPatientSession(from, updated);
    if (!updated.firstVisit) {
      await setPatientSession(from, { ...updated, step: "collectingFirstVisit" });
      await replyWithFirstVisitButtons(from, "📝 ¿Es tu primera vez con nosotros?");
    } else if (!updated.reason) {
      await setPatientSession(from, { ...updated, step: "collectingService" });
      await replyWithServiceOptions(from, "Gracias 😊 ¿Que servicio o motivo general quieres agendar?");
    } else {
      await replyWithDateOptions(from, `📅 Gracias, ${updated.name}. ¿Que dia te gustaria la cita?`);
    }
    return;
  }

  if (existing?.step === "confirmingCancellation") {
    await handleCancellationConfirmation(from, normalized, existing);
    return;
  }

  if (existing?.step === "confirmingReschedule") {
    await handleRescheduleConfirmation(from, normalized, existing);
    return;
  }

  if (existing?.step === "waitlistOffer") {
    await handleWaitlistConfirmation(from, normalized, existing);
    return;
  }

  if (detectedIntent.intent === "medical_urgent" || detectedIntent.intent === "medical_emergency") {
    setMemoryTags(from, suggestTagsFromText(normalized, detectedIntent.intent));
    await replyToPatientWithButtons(
      from,
      getIntentResponse("medical_urgent"),
      [
        { id: "talk_human", title: "Persona" },
        { id: "location", title: "Ubicacion" },
        { id: "promo_schedule", title: "Agendar" }
      ]
    );
    return;
  }

  if (detectedIntent.intent === "recent_sex_before_exam") {
    await addConversationTags(from, ["Papanicolaou", "Revisar indicacion"]);
    await sendRecentSexBeforeExamResponse(from);
    return;
  }

  if (detectedIntent.intent === "medication_question") {
    await replyToPatientWithButtons(
      from,
      getIntentResponse("medication_question"),
      [
        { id: "promo_schedule", title: "Agendar" },
        { id: "talk_human", title: "Persona" },
        { id: "promo_info", title: "Ver promo" }
      ]
    );
    return;
  }

  if (detectedIntent.intent === "cancel_appointment") {
    await handleCancellationRequest(from);
    return;
  }

  if (isResetCommand(normalized)) {
    await deletePatientSession(from);
    await sendMainMenuToPatient(from);
    return;
  }

  if (detectedIntent.intent === "reschedule_appointment") {
    await handleRescheduleRequest(from);
    return;
  }

  if (detectedIntent.intent === "late_arrival") {
    await replyToPatientWithButtons(from, getIntentResponse("late_arrival"), [
      { id: "reschedule", title: "Reagendar" },
      { id: "talk_human", title: "Persona" },
      { id: "main_availability", title: "Ver horarios" }
    ]);
    return;
  }

  if (detectedIntent.intent === "patient_results") {
    await handlePatientResultsRequest(from);
    return;
  }

  if (detectedIntent.intent === "direct_contact") {
    await setConversationHumanMode(from, true, "patient_request");
    setMemoryHumanMode(from, true);
    await replyToPatient(from, getIntentResponse("direct_contact"));
    return;
  }

  if (detectedIntent.intent === "contact_info") {
    await sendContactInfoResponse(from);
    return;
  }

  if (normalized === "confirmo asistencia") {
    await handleAttendanceConfirmation(from, true);
    return;
  }

  if (detectedIntent.intent === "confirm_appointment" && existing?.step !== "confirmingAppointment") {
    await handleConfirmAppointmentRequest(from);
    return;
  }

  if (detectedIntent.intent === "closing" && existing?.step !== "confirmingAppointment") {
    await deletePatientSession(from);
    await replyToPatient(from, getIntentResponse("closing"));
    return;
  }

  if (from === config.doctorWhatsappNumber && /^(?:agenda|mi agenda|ver agenda)$/.test(lower)) {
    await replyToPatient(from, "📅 Por ahora te aviso cada cita nueva por aqui. El resumen diario lo agregamos en la siguiente version.");
    return;
  }

  const dateLikeRequest = looksLikeDateRequest(normalized);

  if (!existing && normalized === "manana") {
    await sendMananDisambiguationButtons(from);
    return;
  }

  if (!existing && normalized === "agendar promo") {
    await startAppointmentFlow(from, { reason: "Chequeo ginecologico completo $1,200" });
    return;
  }

  if (!existing && isAmbiguousShortReply(normalized)) {
    await replyToPatientWithButtons(
      from,
      "Va 😊 ¿A que te refieres?",
      [
        { id: "promo_schedule", title: "Agendar" },
        { id: "promo_info", title: "Ver promo" },
        { id: "talk_human", title: "Humano" }
      ]
    );
    return;
  }

  if (!existing && !dateLikeRequest) {
    const menuHandled = await handleMenuOption(from, normalized, detectedIntent.intent);
    if (menuHandled) return;
  }

  const faqAnswer = getIntentResponse(detectedIntent.intent) ?? answerFaq(normalized);
  if (faqAnswer && !existing && !dateLikeRequest) {
    if (detectedIntent.intent === "greeting") {
      await sendGreetingMenuToPatient(from);
      return;
    }
    if (detectedIntent.intent === "featured_promo") {
      await sendFeaturedPromoResponse(from);
      return;
    }
    if (detectedIntent.intent === "recent_sex_before_exam") {
      await sendRecentSexBeforeExamResponse(from);
      return;
    }
    if (detectedIntent.intent === "contact_info") {
      await sendContactInfoResponse(from);
      return;
    }
    if (detectedIntent.intent === "morning_hours" || detectedIntent.intent === "saturday") {
      await replyToPatientWithButtons(from, faqAnswer, [
        { id: "main_schedule", title: "Ver horarios" },
        { id: "talk_human", title: "Hablar con persona" }
      ]);
      return;
    }
    await sendFaqResponseWithButtons(from, detectedIntent.intent, faqAnswer);
    return;
  }

  if (!existing) {
    const learnedAnswer = await findApprovedKnowledgeAnswer(normalized);
    if (learnedAnswer?.action === "human_handoff") {
      await setConversationHumanMode(from, true, "faq_handoff");
      setMemoryHumanMode(from, true);
      await replyToPatient(from, learnedAnswer.answer ?? getIntentResponse("direct_contact"));
      return;
    }
    if (learnedAnswer?.answer) {
      await replyToPatient(from, learnedAnswer.answer);
      return;
    }
  }

  if (!existing && detectedIntent.intent === "fallback" && !dateLikeRequest) {
    await saveUnrecognizedQuestion(from, text, detectedIntent.category);
    await sendFallbackMenuToPatient(from);
    return;
  }

  let parsed;
  try {
    parsed = await understandMessage(text, existing);
  } catch (error) {
    if (error.message?.includes("Missing OpenAI") || error.message?.includes("Missing Gemini")) {
      await replyToPatient(
        from,
        "Ya estoy conectado al WhatsApp del consultorio. Falta activar la IA y Google Calendar para poder agendar citas automaticamente."
      );
      return;
    }
    if (error.message?.includes("insufficient_quota")) {
      await replyToPatient(
        from,
        "Ya estoy conectado a WhatsApp, pero la IA configurada no tiene saldo. Podemos usar Gemini con una llave gratuita/barata para entender y agendar citas automaticamente."
      );
      return;
    }
    throw error;
  }
  const emailSkippedNow = config.emailOptional && /^(?:sin correo|no tengo correo|no tengo|omitir|no email|no correo|skip)$/.test(normalized);
  const session = {
    from,
    step: existing?.step ?? "collecting",
    name: parsed.name ?? existing?.name,
    email: emailSkippedNow ? undefined : (parsed.email ?? existing?.email),
    emailSkipped: emailSkippedNow || existing?.emailSkipped,
    firstVisit: parsed.firstVisit ?? existing?.firstVisit,
    paymentType: parsed.paymentType ?? existing?.paymentType,
    reason: parsed.reason ?? existing?.reason,
    preferredDateText: parsed.preferredDateText ?? existing?.preferredDateText,
    preferredDateISO: parsed.preferredDateISO ?? existing?.preferredDateISO,
    preferredTimeRange: parsed.preferredTimeRange ?? existing?.preferredTimeRange,
    offeredSlots: existing?.offeredSlots,
    pendingSlot: existing?.pendingSlot,
    rescheduleFromCitaId: existing?.rescheduleFromCitaId,
    rescheduleFromGoogleEventId: existing?.rescheduleFromGoogleEventId,
    availabilityOnly: existing?.availabilityOnly ?? (!existing && parsed.intent === "check_availability")
  };

  if (session.step === "confirmingAppointment") {
    if (parsed.email && parsed.email !== session.email) {
      const updated = { ...session, email: parsed.email };
      await setPatientSession(from, updated);
      await replyToPatient(
        from,
        `Listo, actualice el correo 😊\n\n${buildAppointmentReviewMessage({ ...updated, slot: updated.pendingSlot })}`
      );
      return;
    }

    if (parsed.name && parsed.name !== session.name) {
      const updated = { ...session, name: parsed.name };
      await setPatientSession(from, updated);
      await replyToPatient(
        from,
        `Listo, actualice el nombre 😊\n\n${buildAppointmentReviewMessage({ ...updated, slot: updated.pendingSlot })}`
      );
      return;
    }

    if (parsed.firstVisit && parsed.firstVisit !== session.firstVisit) {
      const updated = { ...session, firstVisit: parsed.firstVisit };
      await setPatientSession(from, updated);
      await replyToPatient(
        from,
        `Listo, actualice ese dato 😊\n\n${buildAppointmentReviewMessage({ ...updated, slot: updated.pendingSlot })}`
      );
      return;
    }

    if (parsed.paymentType && parsed.paymentType !== session.paymentType) {
      const updated = { ...session, paymentType: parsed.paymentType };
      await setPatientSession(from, updated);
      await replyToPatient(
        from,
        `Listo, actualice el tipo de consulta 😊\n\n${buildAppointmentReviewMessage({ ...updated, slot: updated.pendingSlot })}`
      );
      return;
    }

    if (isEmailCorrectionNotice(normalized)) {
      await setPatientSession(from, session);
      await replyToPatient(from, "Claro 😊 Mandame el correo correcto y actualizo la cita antes de confirmarla.");
      return;
    }

    if (parsed.preferredDateText) {
      await setPatientSession(from, {
        ...session,
        step: "collecting",
        preferredDateText: parsed.preferredDateText,
        preferredDateISO: parsed.preferredDateISO,
        offeredSlots: undefined,
        pendingSlot: undefined,
        pendingSlotSelectedIndex: undefined
      });
      await offerAvailableSlots(from, {
        ...session,
        step: "collecting",
        preferredDateText: parsed.preferredDateText,
        preferredDateISO: parsed.preferredDateISO,
        offeredSlots: undefined,
        pendingSlot: undefined,
        pendingSlotSelectedIndex: undefined
      });
      return;
    }

    if (isAffirmativeConfirmation(normalized)) {
      await confirmAppointmentFromSession(from, session);
      return;
    }

    if (isNegativeConfirmation(normalized)) {
      await resetSlotSelection(from, session);
      await replyWithDateOptions(from, "Sin problema 😊 No agende esa cita. ¿Que otra fecha quieres revisar?");
      return;
    }

    await replyToPatient(from, "Para confirmar la cita responde SI. Si algun dato esta mal, puedes mandarme el dato correcto. Por ejemplo: \"correo nuevo@correo.com\". Si prefieres otro horario, responde NO.");
    return;
  }

  if ((session.step === "choosingSlot" || session.step === "choosingAvailabilitySlot") && parsed.selectedSlotIndex) {
    const slot = session.offeredSlots?.[parsed.selectedSlotIndex - 1];
    const slotValidation = validateSlotSelection({ slot, session, selectedSlotIndex: parsed.selectedSlotIndex });

    if (!slotValidation.ok) {
      await resetSlotSelection(from, session);
      await replyWithDateOptions(from, "Ese horario ya no es valido. ¿Que dia quieres revisar para pasarte nuevos horarios?");
      return;
    }

    if (session.step === "choosingAvailabilitySlot" || session.availabilityOnly) {
      const returningProfile = await loadReturningPatientProfile(from);
      if (returningProfile?.patientName) {
        const updated = applyReturningProfile({
          ...session,
          step: "collectingService",
          availabilityOnly: false,
          pendingSlot: slot,
          pendingSlotSelectedIndex: parsed.selectedSlotIndex
        }, returningProfile);
        await setPatientSession(from, updated);
        await replyWithServiceOptions(
          from,
          `Perfecto 😊 Tomo como referencia este horario: ${slot.label}.\n\n${buildReturningPatientDataSummary(returningProfile)}\n\n¿Que servicio o motivo general quieres agendar esta vez?`
        );
        return;
      }
      await setPatientSession(from, {
        ...session,
        step: "collecting",
        availabilityOnly: false,
        pendingSlot: slot,
        pendingSlotSelectedIndex: parsed.selectedSlotIndex
      });
      await replyToPatient(
        from,
        `Perfecto 😊 Tomo como referencia este horario: ${slot.label}.\n\n¿A nombre de quien agendamos la cita?`
      );
      return;
    }

    await setPatientSession(from, {
      ...session,
      step: "confirmingAppointment",
      pendingSlot: slot,
      pendingSlotSelectedIndex: parsed.selectedSlotIndex
    });
    await replyWithAppointmentReview(from, buildAppointmentReviewMessage({ ...session, slot }));
    return;
  }

  if (session.availabilityOnly && session.preferredDateText) {
    await offerAvailableSlots(from, session, { allowSelection: false });
    return;
  }

  if (session.availabilityOnly && !session.preferredDateText) {
    await setPatientSession(from, session);
    await replyWithDateOptions(from, getIntentResponse("check_availability"));
    return;
  }

  if (!session.name) {
    const returningProfile = await loadReturningPatientProfile(from);
    if (returningProfile?.patientName) {
      const updated = applyReturningProfile(session, returningProfile);
      await setPatientSession(from, updated);
      await replyWithServiceOptions(from, buildReturningAppointmentPrompt(returningProfile));
      return;
    }
    await setPatientSession(from, session);
    await replyToPatient(from, "😊 Claro, te ayudo a agendar. ¿Me compartes tu nombre completo?");
    return;
  }

  if (!session.email && !session.emailSkipped) {
    await setPatientSession(from, { ...session, step: "collectingEmail" });
    const emailPrompt = config.emailOptional
      ? `📩 Gracias, ${session.name}. ¿Me compartes tu correo para la confirmacion por Google Calendar? (Si no tienes, escribe "sin correo")`
      : `📩 Gracias, ${session.name}. ¿Me compartes tu correo electronico para enviarte la confirmacion de Google Calendar?`;
    await replyToPatient(from, emailPrompt);
    return;
  }

  if (!session.firstVisit) {
    await setPatientSession(from, { ...session, step: "collectingFirstVisit" });
    await replyWithFirstVisitButtons(from, "📝 ¿Es tu primera vez con nosotros?");
    return;
  }

  if (!session.reason) {
    await setPatientSession(from, { ...session, step: "collectingService" });
    await replyWithServiceOptions(
      from,
      "Gracias 😊 ¿Que servicio o motivo general quieres agendar?"
    );
    return;
  }

  if (!session.paymentType) {
    await setPatientSession(from, { ...session, step: "collectingPaymentType" });
    await replyWithPaymentButtons(from, "💳 ¿Tu consulta es particular o por parte de alguna red medica/aseguradora?");
    return;
  }

  if (session.pendingSlot) {
    await setPatientSession(from, {
      ...session,
      step: "confirmingAppointment"
    });
    await replyWithAppointmentReview(from, buildAppointmentReviewMessage({ ...session, slot: session.pendingSlot }));
    return;
  }

  if (parsed.intent === "check_availability" && !session.preferredDateText) {
    await setPatientSession(from, { ...session, step: "collectingDateOnly", availabilityOnly: true });
    await replyWithDateOptions(from, getIntentResponse("check_availability"));
    return;
  }

  if (!session.preferredDateText) {
    await setPatientSession(from, session);
    await replyWithDateOptions(from, `📅 Gracias, ${session.name}. ¿Que dia te gustaria la cita?`);
    return;
  }

  await offerAvailableSlots(from, session);
}

async function offerAvailableSlots(from, session, options = {}) {
  const allowSelection = options.allowSelection !== false;

  if (session.preferredDateISO && isBlockedDate(session.preferredDateISO)) {
    await replyToPatient(from, "📅 Lo sentimos, ese dia el consultorio no tiene citas disponibles por vacaciones o dia no laborable.\n\n¿Te gustaria que revisara otro dia?");
    return;
  }

  let slots;
  try {
    slots = await findAvailableSlots(session.preferredDateText, session.preferredDateISO);
    slots = filterSlotsByPreferredRange(slots, session.preferredTimeRange);
    slots = await filterSlotsByConfirmedAppointments(slots);
    slots = filterSlotsAgainstBusyRanges(slots, options.excludeSlots);
  } catch (error) {
    if (error.message?.includes("Missing Google Calendar")) {
      await replyToPatient(
        from,
        "📅 Ya entendi tu solicitud, pero falta conectar Google Calendar para revisar horarios y agendar la cita."
      );
      return;
    }
    throw error;
  }
  if (slots.length === 0) {
    await setPatientSession(from, { ...session, step: "waitlistOffer", waitlistDateISO: session.preferredDateISO, waitlistDateText: session.preferredDateText });
    await replyToPatientWithButtons(
      from,
      buildNoSlotsWaitlistMessage(session, options.prefix),
      [
        { id: "waitlist_yes", title: "Si" },
        { id: "waitlist_other_day", title: "Otro dia" },
        { id: "waitlist_human", title: "Persona" }
      ]
    );
    return;
  }

  await setPatientSession(from, allowSelection ? {
    ...session,
    step: "choosingSlot",
    offeredSlots: slots
  } : {
    ...session,
    step: "choosingAvailabilitySlot",
    offeredSlots: slots
  });

  await replyWithSlotOptions(from, {
    body: `${options.prefix ?? ""}${buildAvailabilityIntro(session, slots)}`,
    slots,
    allowSelection
  });
}

async function filterSlotsByConfirmedAppointments(slots) {
  if (!isDatabaseEnabled() || slots.length === 0) return slots;

  const firstStart = slots[0]?.start;
  const lastEnd = slots.at(-1)?.end;
  if (!firstStart || !lastEnd) return slots;

  const confirmed = await loadConfirmedCitasBetween(firstStart, lastEnd);
  return filterSlotsAgainstBusyRanges(slots, confirmed);
}

function filterSlotsByPreferredRange(slots, range) {
  if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end)) return slots;
  return slots.filter((slot) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: config.clinicTimezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(slot.start));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    const total = hour * 60 + minute;
    return total >= range.start && total < range.end;
  });
}

async function confirmAppointmentFromSession(from, session) {
  const slot = session.pendingSlot;
  const name = session.name ?? "Paciente";
  const slotValidation = validateSlotSelection({
    slot,
    session: { ...session, offeredSlots: [slot] },
    selectedSlotIndex: 1
  });

  if (!slotValidation.ok) {
    await resetSlotSelection(from, session);
    await replyWithDateOptions(from, "Ese horario ya no es valido. ¿Que dia quieres revisar para pasarte nuevos horarios?");
    return;
  }

  let lock;
  let event;
  try {
    lock = await lockAppointmentSlot(from, slot);
    if (lock === false) {
      await resetSlotSelection(from, session);
      await replyWithDateOptions(from, "😕 Ese horario se acaba de apartar. ¿Que dia te gustaria revisar para pasarte nuevos horarios?");
      return;
    }

    const stillAvailable = await isSlotAvailable(slot);
    if (!stillAvailable) {
      await resetSlotSelection(from, session);
      await replyWithDateOptions(from, "😕 Ese horario se acaba de ocupar. ¿Que dia te gustaria revisar para pasarte nuevos horarios?");
      return;
    }

    const stillOpenInDatabase = await isSlotOpenInDatabase(slot);
    if (!stillOpenInDatabase) {
      throw new Error("double_booking: slot already confirmed in database");
    }

    try {
      event = await createAppointment(slot, {
        name,
        phone: from,
        email: session.email,
        firstVisit: session.firstVisit,
        paymentType: session.paymentType,
        reason: config.includeSensitiveAppointmentNotes ? session.reason : undefined
      });
    } catch (calendarError) {
      logSafeError(`Could not create Google Calendar event for slot ${slot.start} - ${slot.end} on calendar ${config.googleCalendarId}`, calendarError);
      throw calendarError;
    }
    if (!event?.id) {
      throw new Error("Google Calendar did not return an event id");
    }

    const cita = await saveConfirmedCita(from, session, slot, event);
    await finishConfirmedAppointment(from, session, slot, cita, name);
  } catch (error) {
    if (event?.id) {
      await markCitaFailedByGoogleEvent(event.id, error?.message ?? error);
      try {
        await cancelAppointment(event.id);
      } catch (cancelError) {
        logSafeError("Could not rollback Google Calendar event after appointment failure", cancelError);
      }
    }
    const failureType = classifyAppointmentError(error);
    logSafeError(`Could not confirm appointment for ${maskPhone(from)} [${failureType}]`, error);
    if (failureType === "double_booking") {
      await offerAlternativeSlotsAfterDoubleBooking(from, session);
      return;
    } else {
      await resetSlotSelection(from, session);
      await replyToPatient(from, buildAppointmentFailureMessage(failureType));
    }
    const adminHint =
      failureType === "database_schema"
        ? "Probable migracion pendiente o cache de schema en Supabase. Ejecuta supabase/migration-existing.sql y revisa la tabla citas."
        : failureType === "double_booking"
          ? "El horario parece duplicado u ocupado. Ofrece otro horario al paciente."
          : "Revisa Calendar/Supabase antes de confirmar manualmente.";
    await safeSendWhatsAppText(
      config.doctorWhatsappNumber,
      `⚠️ Error al confirmar cita por WhatsApp (${failureType}). Telefono: ${maskPhone(from)}. ${adminHint}`
    );
  } finally {
    if (lock && typeof lock === "object") await releaseAppointmentLock(lock.token);
  }
}

async function finishConfirmedAppointment(from, session, slot, cita, name) {
  await scheduleAppointmentReminder(from, session, slot, cita);
  await cancelPreviousRescheduledAppointment(session);
  await deletePatientSession(from);

  // Keep the in-memory conversation up to date so background workers
  // (e.g. post-appointment survey) can read slotEnd without waiting for a restart.
  const existing = conversations.get(from) ?? { phoneNumber: from, messages: [], updatedAt: new Date().toISOString() };
  existing.appointment = {
    patientName: name,
    patientEmail: session.email ?? undefined,
    googleEventId: cita?.googleEventId ?? undefined,
    slotStart: slot.start,
    slotEnd: slot.end,
    status: "confirmed"
  };
  conversations.set(from, existing);
  void appendAppointmentToSheet({
    phone: from,
    name,
    slotLabel: slot.label,
    service: session.reason ?? "",
    status: "confirmed"
  }).catch(() => {});

  try {
    await replyToPatient(from, buildPatientConfirmationMessage({ name, slot, email: session.email }));
  } catch (error) {
    logSafeError(`Could not send confirmed appointment message to ${maskPhone(from)}`, error);
  }

  if (session.email && isEmailEnabled()) {
    void sendAppointmentConfirmationEmail({
      to: session.email,
      name,
      slotLabel: slot.label,
      clinicName: config.clinicName,
      clinicAddress: config.clinicAddress
    }).catch((error) => logSafeError("Could not send confirmation email", error));
  }

  try {
    await sendWhatsAppText(
      config.doctorWhatsappNumber,
      buildAdminAppointmentNotification({ name, from, slot, session })
    );
  } catch (error) {
    logSafeError("Could not send admin appointment notification", error);
  }
}

async function offerAlternativeSlotsAfterDoubleBooking(from, session) {
  const pendingSlotDateISO = session.pendingSlot?.start ? zonedDateOnly(session.pendingSlot.start) : undefined;
  const dateISO = pendingSlotDateISO ?? session.preferredDateISO;
  const retrySession = {
    ...session,
    step: "collecting",
    preferredDateText: dateISO ?? session.preferredDateText ?? "hoy",
    preferredDateISO: dateISO,
    offeredSlots: undefined,
    pendingSlot: undefined,
    pendingSlotSelectedIndex: undefined
  };

  await offerAvailableSlots(from, retrySession, {
    prefix: `${buildAppointmentFailureMessage("double_booking")}\n\n`,
    excludeSlots: session.pendingSlot ? [session.pendingSlot] : []
  });
}

async function isSlotOpenInDatabase(slot) {
  if (!isDatabaseEnabled()) {
    if (config.requireDatabaseForAppointments) {
      throw new Error("Database is required before confirming appointments");
    }
    return true;
  }

  const confirmed = await loadConfirmedCitasBetween(slot.start, slot.end);
  for (const cita of confirmed) {
    console.warn(
      `Supabase confirmed cita blocks slot. id=${cita.id} slot_start=${cita.slotStart} slot_end=${cita.slotEnd} google_event_id=${cita.googleEventId}`
    );
  }
  return confirmed.length === 0;
}

function formatMinutesToTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return m > 0 ? `${h12}:${String(m).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

function buildAvailabilityIntro(session, slots) {
  const requestedDateISO = session.preferredDateISO;
  const requestedDate = requestedDateISO ? dateOnlyFromISO(requestedDateISO) : undefined;
  const firstSlotDate = slots[0]?.start ? zonedDateOnly(slots[0].start) : undefined;
  const timeHint = session.preferredTimeRange ? ` (${session.preferredTimeRange})` : "";

  if (requestedDate && firstSlotDate && requestedDate !== firstSlotDate) {
    const requestedLabel = formatDateOnlyFull(requestedDateISO);
    if (!isClinicWorkDate(requestedDateISO)) {
      return `📅 No, el ${requestedLabel} no trabajamos. Por el momento atendemos de lunes a viernes de 4:40 p.m. a 8:00 p.m.\n\nTe comparto opciones cercanas:`;
    }
    return `📅 Para el ${requestedLabel}${timeHint} ya no encontre espacios libres.\n\nTe comparto opciones cercanas:`;
  }

  return timeHint
    ? `🕒 Tengo estos horarios disponibles${timeHint}:`
    : "🕒 Tengo estos horarios disponibles:";
}

function buildNoSlotsWaitlistMessage(session, prefix = "") {
  const requestedDateISO = session.preferredDateISO;
  const requestedLabel = requestedDateISO ? ` para el ${formatDateOnlyFull(requestedDateISO)}` : " para ese dia";
  return `${prefix ?? ""}Por ahora no tengo horarios disponibles${requestedLabel} 😕\n\n¿Quieres que te agregue a lista de espera por si se libera un espacio?`;
}

function dateOnlyFromISO(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? value : undefined;
}

function zonedDateOnly(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.clinicTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(value));
}

function formatDateOnlyFull(value) {
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "full",
    timeZone: config.clinicTimezone
  }).format(new Date(`${value}T12:00:00`));
}

function isClinicWorkDate(value) {
  return isClinicWorkDateISO(value);
}

async function resetSlotSelection(from, session) {
  await setPatientSession(from, {
    ...session,
    step: "collecting",
    preferredDateText: undefined,
    preferredDateISO: undefined,
    offeredSlots: undefined,
    pendingSlot: undefined,
    pendingSlotSelectedIndex: undefined
  });
}

async function lockAppointmentSlot(from, slot) {
  if (!isDatabaseEnabled()) {
    if (config.requireDatabaseForAppointments) {
      throw new Error("Database is required before confirming appointments");
    }
    return null;
  }

  const lock = await acquireAppointmentLock({
    slotStart: slot.start,
    slotEnd: slot.end,
    phoneNumber: from
  });

  return lock || false;
}

async function handleIncomingAudio(from, audio) {
  await recordConversationMessage(from, "patient", "[Audio / nota de voz]");
  await notifyIncomingPatientMessage(from, "[Audio / nota de voz]");

  const state = (await getConversationState(from)) ?? conversations.get(from);
  if (state?.botPaused) {
    console.log(`Bot paused for ${maskPhone(from)}; audio stored without auto-reply.`);
    return;
  }

  console.log(`Audio message received from ${maskPhone(from)} mime=${audio.mime_type ?? "?"} voice=${audio.voice ?? false}`);

  if (audio.id) {
    try {
      const { buffer, mimeType } = await downloadWhatsAppAudio(audio.id);
      const transcript = await transcribeAudio(buffer, mimeType);
      if (transcript && transcript.trim().length > 2) {
        console.log(`Transcribed audio from ${maskPhone(from)}: "${transcript.slice(0, 80)}"`);
        // handleIncomingText records the message and notifies the inbox internally
        await handleIncomingText(from, transcript);
        return;
      }
    } catch (error) {
      logSafeError(`Could not transcribe audio from ${maskPhone(from)}`, error);
    }
  }

  const body = [
    "Recibimos tu nota de voz 😊",
    "",
    "Para atenderte mejor, ¿que necesitas?"
  ].join("\n");

  try {
    await sendWhatsAppButtons(from, {
      body,
      buttons: [
        { id: "main_schedule", title: "Agendar cita" },
        { id: "promo_info", title: "Ver promocion" },
        { id: "main_human", title: "Hablar con persona" }
      ]
    });
    await recordConversationMessage(from, "bot", body);
    await notifyBotReply(from, body);
  } catch (error) {
    logSafeError(`Failed sending audio reply to ${maskPhone(from)}`, error);
    await safeSendWhatsAppText(from, body);
  }
}

async function handleMenuOption(from, text, intent = detectIntent(text).intent) {
  const option = menuOptionNumber(text);
  if (text === "agendar promo" || intent === "promo_schedule") {
    await startAppointmentFlow(from, { reason: "Chequeo ginecologico completo $1,200" });
    return true;
  }
  if (option === 1 || intent === "schedule_appointment" || intent === "new_patient") {
    await startAppointmentFlow(from);
    return true;
  }

  if (option === 2 || intent === "check_availability") {
    await setPatientSession(from, { from, step: "collectingDateOnly", availabilityOnly: true });
    await replyWithDateOptions(from, getIntentResponse("check_availability"));
    return true;
  }

  if (option === 3 || intent === "featured_promo" || intent === "promotion") {
    await sendFeaturedPromoResponse(from);
    return true;
  }

  if (option === 4 || intent === "medical_services") {
    await replyToPatientWithButtons(
      from,
      getIntentResponse("medical_services"),
      [
        { id: "promo_schedule", title: "Agendar cita" },
        { id: "promo_includes", title: "Que incluye" },
        { id: "main_preparation", title: "Preparacion" }
      ]
    );
    return true;
  }

  if (intent === "contact_info") {
    await sendContactInfoResponse(from);
    return true;
  }

  if (text === "que incluye el chequeo" || text === "promo_includes") {
    await sendPromoIncludesResponse(from);
    return true;
  }

  if (option === 5 || intent === "cost") {
    await replyToPatientWithButtons(
      from,
      `${getIntentResponse("cost")}\n\n${getIntentResponse("promotion")}`,
      [
        { id: "promo_schedule", title: "Agendar cita" },
        { id: "promo_includes", title: "Que incluye" },
        { id: "main_payments", title: "Formas de pago" }
      ]
    );
    return true;
  }

  if (option === 6 || intent === "location") {
    await sendLocationResponse(from);
    return true;
  }

  if (option === 7 || intent === "appointment_preparation" || intent === "appointment_requirements" || intent === "appointment_duration") {
    await sendFaqResponseWithButtons(from, "appointment_preparation", getIntentResponse("appointment_preparation"));
    return true;
  }

  if (option === 8 || intent === "clinic_hours" || intent === "morning_hours" || intent === "saturday") {
    await sendFaqResponseWithButtons(from, "clinic_hours", getIntentResponse("clinic_hours"));
    return true;
  }

  if (option === 9 || intent === "payment_methods" || intent === "insurance_network") {
    await replyToPatientWithButtons(
      from,
      `${getIntentResponse("payment_methods")}\n\n${getIntentResponse("insurance_network")}`,
      [
        { id: "promo_schedule", title: "Agendar cita" },
        { id: "promo_info", title: "Ver promo" },
        { id: "main_costs", title: "Costos" }
      ]
    );
    return true;
  }

  if (option === 10 || intent === "patient_results") {
    await handlePatientResultsRequest(from);
    return true;
  }

  if (option === 11 || intent === "direct_contact") {
    await setConversationHumanMode(from, true, "patient_request");
    setMemoryHumanMode(from, true);
    await replyToPatient(from, getIntentResponse("direct_contact"));
    return true;
  }

  return false;
}

async function sendFaqResponseWithButtons(from, intent, answer) {
  if (intent === "location") {
    await sendLocationResponse(from);
    return;
  }

  if (intent === "clinic_hours" || intent === "morning_hours" || intent === "saturday") {
    await replyToPatientWithButtons(from, answer, [
      { id: "main_availability", title: "Ver horarios" },
      { id: "promo_schedule", title: "Agendar" },
      { id: "main_location", title: "Ubicacion" }
    ]);
    return;
  }

  if (intent === "appointment_preparation" || intent === "appointment_requirements" || intent === "appointment_duration") {
    await replyToPatientWithButtons(from, answer, [
      { id: "promo_schedule", title: "Agendar" },
      { id: "promo_info", title: "Ver promo" },
      { id: "main_hours", title: "Horario" }
    ]);
    return;
  }

  if (intent === "payment_methods") {
    await replyToPatientWithButtons(from, answer, [
      { id: "promo_schedule", title: "Agendar" },
      { id: "promo_info", title: "Ver promo" },
      { id: "talk_human", title: "Persona" }
    ]);
    return;
  }

  if (intent === "insurance_network") {
    await replyToPatientWithButtons(from, answer, [
      { id: "payment_private", title: "Particular" },
      { id: "payment_network", title: "Red medica" },
      { id: "promo_schedule", title: "Agendar" }
    ]);
    return;
  }

  if (intent === "invoice") {
    await replyToPatientWithButtons(from, answer, [
      { id: "talk_human", title: "Persona" },
      { id: "promo_schedule", title: "Agendar" },
      { id: "main_payments", title: "Pagos" }
    ]);
    return;
  }

  if (intent === "medical_services") {
    await replyToPatientWithButtons(from, answer, [
      { id: "promo_schedule", title: "Agendar" },
      { id: "promo_includes", title: "Que incluye" },
      { id: "talk_human", title: "Persona" }
    ]);
    return;
  }

  await replyToPatient(from, answer);
}

async function sendLocationResponse(to) {
  await replyToPatientWithButtons(to, getIntentResponse("location"), [
    { id: "promo_schedule", title: "Agendar" },
    { id: "main_costs", title: "Costos" },
    { id: "talk_human", title: "Persona" }
  ]);
}

async function handlePromoOfferReply(from, text, intent) {
  if (
    text === "agendar promo" ||
    intent === "promo_schedule" ||
    intent === "schedule_appointment" ||
    isAffirmativeConfirmation(text) ||
    hasAny(text, ["me interesa", "agendar", "apartar", "reservar", "cita"])
  ) {
    await startAppointmentFlow(from, { reason: "Chequeo ginecologico completo $1,200" });
    return;
  }

  if (
    text === "que incluye el chequeo" ||
    intent === "featured_promo" ||
    hasAny(text, ["que incluye", "incluye", "que trae", "que tiene", "detalles"])
  ) {
    await sendPromoIncludesResponse(from);
    return;
  }

  if (intent === "location" || text === "ubicacion") {
    await sendLocationResponse(from);
    return;
  }

  if (intent === "payment_methods" || text === "formas de pago") {
    await replyToPatientWithButtons(
      from,
      getIntentResponse("payment_methods"),
      [
        { id: "promo_schedule", title: "Agendar" },
        { id: "promo_info", title: "Ver promo" },
        { id: "talk_human", title: "Humano" }
      ]
    );
    return;
  }

  if (intent === "direct_contact" || text === "quiero hablar con una persona") {
    await setConversationHumanMode(from, true, "promo_human_request");
    setMemoryHumanMode(from, true);
    await replyToPatient(from, getIntentResponse("direct_contact"));
    return;
  }

  if (isNegativeConfirmation(text)) {
    await deletePatientSession(from);
    await replyToPatient(from, "Sin problema 😊 Si luego quieres agendar la promocion o resolver una duda, aqui estoy.");
    return;
  }

  await replyToPatientWithButtons(
    from,
    "Te ayudo 😊 ¿Quieres agendar la promocion, ver que incluye o hablar con una persona?",
    [
      { id: "promo_schedule", title: "Agendar" },
      { id: "promo_includes", title: "Que incluye" },
      { id: "talk_human", title: "Humano" }
    ]
  );
}

async function handlePatientResultsRequest(from) {
  await addConversationTags(from, ["Resultados", "Humano requerido"]);
  await setConversationHumanMode(from, true, "results_request");
  setMemoryHumanMode(from, true);

  try {
    await saveConversationNote({
      phoneNumber: from,
      author: "bot",
      body: buildPatientResultsHumanNote()
    });
  } catch (error) {
    logSafeError("Could not save results request note", error);
  }

  await replyToPatientWithButtons(
    from,
    getIntentResponse("patient_results"),
    [
      { id: "talk_human", title: "Persona" },
      { id: "promo_schedule", title: "Agendar" },
      { id: "location", title: "Ubicacion" }
    ]
  );
  await notifyResultsRequest(from);
}

function menuOptionNumber(text) {
  const normalized = normalizeText(text);
  const words = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11 };
  if (/^(?:[1-9]|10|11)$/.test(normalized)) return Number(normalized);
  return words[normalized];
}

async function replyToPatient(to, body) {
  await sendWhatsAppText(to, body);
  await recordConversationMessage(to, "bot", body);
  await notifyBotReply(to, body);
}

async function sendMainMenuToPatient(to) {
  const body = [
    "Hola 😊 Soy el asistente virtual del consultorio.",
    "",
    "Puedo ayudarte a agendar, revisar horarios, explicar la promo, dar ubicacion, costos, formas de pago, servicios y preparacion de cita.",
    "",
    PRIVACY_CONSENT_TEXT,
    "",
    "Elige una opcion. Si necesitas a una persona, escribe humano."
  ].join("\n");
  try {
    await sendWhatsAppList(to, {
      body,
      buttonText: "Opciones",
      sections: [{ title: "Menu del consultorio", rows: mainMenuRows }]
    });
    await recordConversationMessage(to, "bot", `${body}\n\n${mainMenuRows.map((row, index) => `${index + 1}. ${row.title}`).join("\n")}`);
    await notifyBotReply(to, "Menu interactivo enviado.");
  } catch (error) {
    logSafeError(`Failed sending WhatsApp interactive menu to ${maskPhone(to)}`, error);
    await replyToPatient(to, getIntentResponse("greeting"));
  }
}

async function sendFallbackMenuToPatient(to) {
  const body = "Perdon, no entendi bien. ¿Con que te ayudo?";
  try {
    await sendWhatsAppButtons(to, {
      body,
      buttons: [
        { id: "promo_info", title: "Promo $1200" },
        { id: "promo_schedule", title: "Agendar" },
        { id: "main_menu", title: "Ver opciones" }
      ]
    });
    await recordConversationMessage(to, "bot", `${body}\n\n1. Promo $1200\n2. Agendar\n3. Ver opciones`);
    await notifyBotReply(to, "Menu por fallback enviado.");
  } catch (error) {
    logSafeError(`Failed sending fallback buttons to ${maskPhone(to)}`, error);
    try {
      await sendWhatsAppList(to, {
        body: "Perdon, no entendi bien 😅\n\nPuedo ayudarte con estas opciones:",
        buttonText: "Opciones",
        sections: [{ title: "Menu del consultorio", rows: mainMenuRows }]
      });
      await recordConversationMessage(to, "bot", `Perdon, no entendi bien.\n\n${mainMenuRows.map((row, index) => `${index + 1}. ${row.title}`).join("\n")}`);
      await notifyBotReply(to, "Menu por fallback enviado.");
    } catch (listError) {
      logSafeError(`Failed sending fallback list to ${maskPhone(to)}`, listError);
      await replyToPatient(to, getIntentResponse("fallback"));
    }
  }
}

async function sendFeaturedPromoResponse(to) {
  const body = [
    "Claro 😊 La promocion es el chequeo ginecologico completo por $1,200.",
    "",
    "Incluye:",
    "✅ Consulta ginecologica",
    "✅ Papanicolaou",
    "✅ Ultrasonido pelvico",
    "✅ Ultrasonido endovaginal",
    "✅ Revision de mamas",
    "✅ Apoyo para deteccion oportuna de cancer cervico uterino",
    "✅ Apoyo para deteccion oportuna de cancer ovarico",
    "",
    "📍 Estamos en Plaza de la Paz #20, consultorio 14, segundo piso, Col. Centro, Guanajuato, Gto.",
    "",
    "¿Que te gustaria hacer?"
  ].join("\n");

  await addConversationTags(to, ["Promo $1200", "Lead frio"]);
  await setPromoOfferSession(to, "frio");
  void appendLeadToSheet({ phone: to, intent: "promo_info", tags: ["Promo $1200", "Lead frio"] }).catch(() => {});
  try {
    await sendWhatsAppButtons(to, {
      body,
      buttons: [
        { id: "promo_schedule", title: "Agendar" },
        { id: "promo_includes", title: "Que incluye" },
        { id: "location", title: "Ubicacion" }
      ]
    });
    await recordConversationMessage(to, "bot", `${body}\n\n1. Agendar\n2. Que incluye\n3. Ubicacion`);
    await notifyBotReply(to, "Promo $1200 enviada.");
  } catch (error) {
    logSafeError(`Failed sending promo buttons to ${maskPhone(to)}`, error);
    await replyToPatient(to, `${body}\n\nEscribe: *agendar*, *que incluye* o *ubicacion*`);
  }
}

async function sendPromoIncludesResponse(to) {
  const body = [
    "El chequeo ginecologico completo de $1,200 incluye:",
    "",
    "✅ Consulta ginecologica",
    "✅ Papanicolaou",
    "✅ Ultrasonido pelvico",
    "✅ Ultrasonido endovaginal",
    "✅ Revision de mamas",
    "✅ Apoyo para deteccion oportuna de cancer cervico uterino",
    "✅ Apoyo para deteccion oportuna de cancer ovarico",
    "",
    "Todo por $1,200 con la Dra. Blanca Carranza 😊",
    "",
    "¿Quieres agendar tu cita?"
  ].join("\n");

  await addConversationTags(to, ["Promo $1200", "Lead tibio"]);
  await setPromoOfferSession(to, "tibio");
  try {
    await sendWhatsAppButtons(to, {
      body,
      buttons: [
        { id: "promo_schedule", title: "Agendar" },
        { id: "location", title: "Ubicacion" },
        { id: "talk_human", title: "Hablar con alguien" }
      ]
    });
    await recordConversationMessage(to, "bot", `${body}\n\n1. Agendar\n2. Ubicacion\n3. Hablar con alguien`);
    await notifyBotReply(to, "Que incluye promo enviado.");
  } catch (error) {
    logSafeError(`Failed sending promo includes buttons to ${maskPhone(to)}`, error);
    await replyToPatient(to, body);
  }
}

async function setPromoOfferSession(to, leadStage) {
  await setPatientSession(to, {
    from: to,
    step: "promoOffer",
    lastIntent: "featured_promo",
    lastBotQuestion: "promo_agenda_cta",
    lastOfferedOptions: ["promo_schedule", "promo_includes", "location"],
    selectedPromo: "featured_promo",
    leadStage,
    appointmentService: "Chequeo ginecologico completo $1,200",
    reason: "Chequeo ginecologico completo $1,200"
  });
}

async function sendRecentSexBeforeExamResponse(to) {
  const body = [
    "Gracias por avisar 😊",
    "",
    "Para el Papanicolaou se recomienda evitar relaciones sexuales, duchas vaginales, ovulos, cremas o medicamentos vaginales durante las 48 horas previas, porque pueden alterar la muestra.",
    "",
    "Como el chequeo completo incluye Papanicolaou, lo mejor es que una persona del consultorio confirme si conviene realizarlo o reagendar."
  ].join("\n");

  await addConversationTags(to, ["Papanicolaou", "Revisar indicacion"]);
  try {
    await sendWhatsAppButtons(to, {
      body,
      buttons: [
        { id: "reschedule", title: "Reagendar" },
        { id: "talk_human", title: "Hablar con persona" },
        { id: "search_new_date", title: "Ver otra fecha" }
      ]
    });
    await recordConversationMessage(to, "bot", `${body}\n\n1. Reagendar\n2. Hablar con persona\n3. Ver otra fecha`);
    await notifyBotReply(to, "Respuesta sobre relaciones antes del Pap enviada.");
  } catch (error) {
    logSafeError(`Failed sending recent sex before exam buttons to ${maskPhone(to)}`, error);
    await replyToPatient(to, body);
  }
}

async function sendContactInfoResponse(to) {
  const body = [
    "Por este medio podemos ayudarte con citas, ubicacion, costos y dudas generales 😊",
    "",
    "Si necesitas atencion directa, puedo dejar esta conversacion para que una persona del consultorio la revise."
  ].join("\n");

  try {
    await sendWhatsAppButtons(to, {
      body,
      buttons: [
        { id: "promo_schedule", title: "Agendar" },
        { id: "promo_info", title: "Ver promo" },
        { id: "talk_human", title: "Hablar con persona" }
      ]
    });
    await recordConversationMessage(to, "bot", `${body}\n\n1. Agendar\n2. Ver promo\n3. Hablar con persona`);
    await notifyBotReply(to, "Info de contacto enviada.");
  } catch (error) {
    logSafeError(`Failed sending contact info buttons to ${maskPhone(to)}`, error);
    await replyToPatient(to, body);
  }
}

async function sendMananDisambiguationButtons(to) {
  const body = "¿Quieres revisar citas para manana o preguntas por el horario de atencion?";
  try {
    await sendWhatsAppButtons(to, {
      body,
      buttons: [
        { id: "date_tomorrow", title: "Cita manana" },
        { id: "choose_morning", title: "Horario manana" },
        { id: "talk_human", title: "Hablar con persona" }
      ]
    });
    await recordConversationMessage(to, "bot", `${body}\n\n1. Cita manana\n2. Horario manana\n3. Hablar con persona`);
    await notifyBotReply(to, "Disambiguacion manana enviada.");
  } catch (error) {
    logSafeError(`Failed sending manana disambiguation to ${maskPhone(to)}`, error);
    await replyToPatient(to, `${body}\n\n1. Cita para manana\n2. Horario de manana\n3. Hablar con persona`);
  }
}

async function sendGreetingMenuToPatient(to) {
  const profile = await loadReturningPatientProfile(to);
  if (!profile?.patientName) {
    await sendMainMenuToPatient(to);
    return;
  }

  const body = buildReturningPatientMenuBody(profile);
  const rows = [
    { id: "returning_schedule", title: "Agendar otra cita", description: "Usar tus datos guardados" },
    { id: "returning_next", title: "Ver mi cita", description: "Consultar tu cita registrada" },
    { id: "returning_reschedule", title: "Reagendar", description: "Cambiar tu proxima cita" },
    { id: "returning_cancel", title: "Cancelar cita", description: "Cancelar con confirmacion" },
    { id: "returning_results", title: "Resultados", description: "Solicitar estudios aprobados" },
    { id: "main_location", title: "Ubicacion", description: "Direccion del consultorio" },
    { id: "returning_human", title: "Hablar con persona", description: "Pedir apoyo del consultorio" }
  ];

  try {
    await sendWhatsAppList(to, {
      body,
      buttonText: "Opciones",
      sections: [{ title: "Paciente recurrente", rows }]
    });
    await recordConversationMessage(to, "bot", `${body}\n\n${rows.map((row, index) => `${index + 1}. ${row.title}`).join("\n")}`);
    await notifyBotReply(to, "Menu de paciente recurrente enviado.");
  } catch (error) {
    logSafeError(`Failed sending returning patient menu to ${maskPhone(to)}`, error);
    await replyToPatient(
      to,
      `${body}\n\nPuedes escribirme: "agendar otra cita", "tengo cita", "reagendar", "cancelar", "resultados", "ubicacion" o "humano".`
    );
  }
}

async function maybeProtectExistingAppointmentFromScheduling(from, text, intent) {
  if (!mayNeedExistingAppointmentProtection(text, intent)) {
    return false;
  }

  const cita = await loadReturningPatientProfile(from);
  if (!shouldProtectExistingAppointmentFromScheduling(text, intent, cita)) {
    return false;
  }

  await deletePatientSession(from);
  await replyWithExistingAppointmentOptions(from, cita);
  return true;
}

async function replyWithExistingAppointmentOptions(to, cita) {
  const body = [
    `Claro 😊 ya tengo registrada tu cita para ${formatAppointmentFull(cita.slotStart)}.`,
    "",
    "No voy a moverla ni agendar otra por error.",
    "¿Que necesitas hacer?"
  ].join("\n");
  const rows = [
    { id: "returning_next", title: "Ver mi cita", description: "Confirmar dia y hora" },
    { id: "returning_reschedule", title: "Reagendar", description: "Cambiar tu cita" },
    { id: "returning_cancel", title: "Cancelar cita", description: "Cancelar con confirmacion" },
    { id: "returning_schedule", title: "Agendar otra", description: "Crear una cita adicional" },
    { id: "returning_human", title: "Hablar con persona", description: "Pedir apoyo del consultorio" }
  ];

  try {
    await sendWhatsAppList(to, {
      body,
      buttonText: "Opciones",
      sections: [{ title: "Cita registrada", rows }]
    });
    await recordConversationMessage(to, "bot", `${body}\n\n${rows.map((row, index) => `${index + 1}. ${row.title}`).join("\n")}`);
    await notifyBotReply(to, "Opciones de cita existente enviadas.");
  } catch (error) {
    logSafeError(`Failed sending existing appointment options to ${maskPhone(to)}`, error);
    await replyToPatient(
      to,
      `${body}\n\nPuedes escribirme: "tengo cita", "reagendar", "cancelar", "agendar otra cita" o "humano".`
    );
  }
}

async function replyWithDateOptions(to, body) {
  const rows = buildDateOptionRows();
  try {
    await sendMessageWithOptions(to, body, rows);
    await recordConversationMessage(to, "bot", `${body}\n\n${rows.map((row, index) => `${index + 1}. ${row.title} - ${row.description}`).join("\n")}\n\nTambien puedes escribir otra fecha.`);
    await notifyBotReply(to, "Opciones de fecha enviadas.");
  } catch (error) {
    logSafeError(`Failed sending date options to ${maskPhone(to)}`, error);
    await replyToPatient(to, `${body}\n\n${rows.map((row, index) => `${index + 1}. ${row.title} - ${row.description}`).join("\n")}\n\nTambien puedes escribir otra fecha.`);
  }
}

async function replyWithServiceOptions(to, body) {
  try {
    await sendWhatsAppList(to, {
      body,
      buttonText: "Servicios",
      sections: [{ title: "Servicio o motivo", rows: serviceOptionRows }]
    });
    await recordConversationMessage(to, "bot", `${body}\n\n${serviceOptionRows.map((row, index) => `${index + 1}. ${row.title} - ${row.description}`).join("\n")}\n\nTambien puedes escribirlo con tus palabras.`);
    await notifyBotReply(to, "Opciones de servicio enviadas.");
  } catch (error) {
    logSafeError(`Failed sending service options to ${maskPhone(to)}`, error);
    await replyToPatient(
      to,
      `${body}\n\nPuedes responder: consulta, promocion, ultrasonido, papanicolaou, colposcopia, control prenatal u otro motivo general.`
    );
  }
}

async function replyWithFirstVisitButtons(to, body) {
  await replyToPatientWithButtons(to, body, [
    { id: "first_visit_yes", title: "Si" },
    { id: "first_visit_no", title: "No" }
  ]);
}

async function replyWithPaymentButtons(to, body) {
  await replyToPatientWithButtons(to, body, [
    { id: "payment_private", title: "Particular" },
    { id: "payment_network", title: "Red medica" },
    { id: "payment_human", title: "Persona" }
  ]);
}

async function replyWithActiveSessionButtons(to, body) {
  await replyToPatientWithButtons(to, body, [
    { id: "active_continue", title: "Continuar" },
    { id: "active_restart", title: "Nuevo inicio" },
    { id: "active_human", title: "Persona" }
  ]);
}

async function handleActiveSessionFaqQuestion(from, text, intent, session) {
  if (!isSafeActiveSessionFaqIntent(intent)) return false;
  if (shouldLetAppointmentFlowUseReply(text, intent, session)) return false;

  const answer = buildActiveSessionFaqAnswer(intent);
  if (!answer) return false;

  await replyWithActiveSessionButtons(
    from,
    [
      answer,
      "",
      buildActiveSessionResumePrompt(session)
    ].join("\n")
  );
  return true;
}

function isSafeActiveSessionFaqIntent(intent) {
  return new Set([
    "location",
    "clinic_hours",
    "morning_hours",
    "saturday",
    "cost",
    "promotion",
    "featured_promo",
    "payment_methods",
    "insurance_network",
    "appointment_preparation",
    "appointment_requirements",
    "appointment_duration",
    "medical_services",
    "invoice",
    "contact_info"
  ]).has(intent);
}

function shouldLetAppointmentFlowUseReply(text, intent, session) {
  if (session?.step === "collectingPaymentType") {
    return ["insurance_network", "payment_methods"].includes(intent) || isLikelyPaymentTypeChoice(text);
  }

  if (session?.step !== "collectingService") return false;
  if (!["promotion", "featured_promo", "medical_services"].includes(intent)) return false;

  return isLikelyServiceChoice(text);
}

function isLikelyServiceChoice(text) {
  return (
    /^(?:una|un)?\s*(?:cita|consulta|revision|chequeo)\s*$/.test(text) ||
    /^(?:promo|promocion|paquete|paquete promocional|1200)\s*$/.test(text) ||
    /^(?:ultrasonido|ultra|papanicolaou|papanicolau|papanicolao|colposcopia|colposkopia|colpo|control prenatal|embarazo|otro|otro motivo|otro motivo general)\s*$/.test(text) ||
    /\b(?:quiero|necesito|ocupo|voy por|agendar|hacer|sacar|reservar)\b.*\b(?:consulta|cita|promo|promocion|ultrasonido|papanicolaou|colposcopia|control prenatal)\b/.test(text)
  );
}

function isLikelyPaymentTypeChoice(text) {
  return (
    /^(?:particular|privado|privada|red medica|red médica|red|aseguradora|aseguradoras|seguro|gastos medicos|gastos médicos|axa|gnp|metlife|bupa|seguros monterrey|monterrey)\s*$/.test(text) ||
    /\b(?:vengo|voy|es|sera|seria|consulta|cita)\b.*\b(?:particular|privado|privada|red medica|red médica|aseguradora|seguro|gastos medicos|gastos médicos)\b/.test(text)
  );
}

function isEmailCorrectionNotice(text) {
  return (
    /\b(?:correo|email|mail|gmail)\b/.test(text) &&
    /\b(?:mal|equivocado|equivocada|incorrecto|incorrecta|corregir|corrige|correccion|cambiar|cambio|puse mal|esta mal|lo puse mal)\b/.test(text)
  );
}

function buildActiveSessionFaqAnswer(intent) {
  if (intent === "cost") {
    return `${getIntentResponse("cost")}\n\n${getIntentResponse("promotion")}`;
  }
  if (intent === "payment_methods") {
    return `${getIntentResponse("payment_methods")}\n\n${getIntentResponse("insurance_network")}`;
  }
  if (intent === "appointment_requirements" || intent === "appointment_duration") {
    return getIntentResponse("appointment_preparation");
  }
  return getIntentResponse(intent);
}

function buildActiveSessionResumePrompt(session) {
  const stepLabel = formatSessionStep(session?.step).toLowerCase();

  if (session?.step === "choosingSlot" || session?.step === "choosingAvailabilitySlot") {
    return [
      "Seguimos con los horarios que te mande.",
      "Toca Continuar para verlos otra vez, Nuevo inicio para empezar de cero o Persona si necesitas apoyo."
    ].join("\n");
  }

  if (session?.step === "confirmingAppointment") {
    return [
      "Seguimos revisando tu cita antes de confirmarla.",
      "Toca Continuar para ver el resumen otra vez, o responde SI para agendar / NO para elegir otro horario."
    ].join("\n");
  }

  if (!session?.name) {
    return "Seguimos con tu registro. Me falta tu nombre completo.";
  }

  if (!session?.email && !session?.emailSkipped) {
    return "Seguimos con tu registro. Me falta tu correo para la confirmacion de Google Calendar.";
  }

  if (!session?.firstVisit) {
    return "Seguimos con tu registro. Me falta saber si es tu primera vez con nosotros.";
  }

  if (!session?.reason) {
    return "Seguimos con tu registro. Me falta el servicio o motivo general de la cita.";
  }

  if (!session?.paymentType) {
    return "Seguimos con tu registro. Me falta saber si vienes particular o por red medica/aseguradora.";
  }

  if (!session?.preferredDateText) {
    return "Seguimos con tu cita. Me falta el dia que quieres revisar.";
  }

  return [
    `Seguimos en: ${stepLabel}.`,
    "Toca Continuar para retomar el paso exacto, Nuevo inicio para empezar de cero o Persona si necesitas apoyo."
  ].join("\n");
}

async function continueActiveSession(from, session) {
  if (session.step === "confirmingCancellation") {
    await replyToPatientWithButtons(
      from,
      `Claro, seguimos 😊\n\nEncontre tu cita para ${formatAppointmentFull(session.cancellationSlotStart)}.\n\n¿Seguro que deseas cancelarla?`,
      [
        { id: "cancel_yes", title: "Si, cancelar" },
        { id: "cancel_no", title: "No, conservar" }
      ]
    );
    return;
  }

  if (session.step === "confirmingReschedule") {
    await replyToPatientWithButtons(
      from,
      `Claro, seguimos 😊\n\nEncontre tu cita para ${formatAppointmentFull(session.rescheduleFromSlotStart)}.\n¿Quieres cambiarla?`,
      [
        { id: "reschedule_yes", title: "Si, cambiar" },
        { id: "reschedule_no", title: "No, conservar" },
        { id: "reschedule_human", title: "Persona" }
      ]
    );
    return;
  }

  if (session.step === "waitlistOffer") {
    await replyToPatientWithButtons(
      from,
      buildNoSlotsWaitlistMessage(session, "Claro, seguimos 😊\n\n"),
      [
        { id: "waitlist_yes", title: "Si" },
        { id: "waitlist_other_day", title: "Otro dia" },
        { id: "waitlist_human", title: "Persona" }
      ]
    );
    return;
  }

  if (session.step === "confirmingAppointment" && session.pendingSlot) {
    await replyWithAppointmentReview(from, buildAppointmentReviewMessage({ ...session, slot: session.pendingSlot }));
    return;
  }

  if ((session.step === "choosingSlot" || session.step === "choosingAvailabilitySlot") && session.offeredSlots?.length) {
    await replyWithSlotOptions(from, {
      body: `Claro, seguimos 😊\n\n${buildAvailabilityIntro(session, session.offeredSlots)}`,
      slots: session.offeredSlots,
      allowSelection: session.step === "choosingSlot" && !session.availabilityOnly
    });
    return;
  }

  if (!session.name) {
    await replyToPatient(from, "😊 Claro, seguimos. ¿Me compartes tu nombre completo?");
    return;
  }

  if (!session.email) {
    await replyToPatient(from, `📩 Gracias, ${session.name}. ¿Me compartes tu correo electronico para enviarte la confirmacion de Google Calendar?`);
    return;
  }

  if (!session.firstVisit) {
    await replyWithFirstVisitButtons(from, "📝 ¿Es tu primera vez con nosotros?");
    return;
  }

  if (!session.reason) {
    await replyWithServiceOptions(from, "Gracias 😊 ¿Que servicio o motivo general quieres agendar?");
    return;
  }

  if (!session.paymentType) {
    await replyWithPaymentButtons(from, "💳 ¿Tu consulta es particular o por parte de alguna red medica/aseguradora?");
    return;
  }

  if (session.pendingSlot) {
    await replyWithAppointmentReview(from, buildAppointmentReviewMessage({ ...session, slot: session.pendingSlot }));
    return;
  }

  if (!session.preferredDateText) {
    await replyWithDateOptions(from, `📅 Gracias, ${session.name}. ¿Que dia te gustaria la cita?`);
    return;
  }

  await offerAvailableSlots(from, session, { allowSelection: !session.availabilityOnly });
}

async function replyWithSlotOptions(to, { body, slots, allowSelection }) {
  const rows = buildSlotOptionRows(slots);
  const instruction = allowSelection
    ? "Toca el boton para elegir un horario. Si ninguno te acomoda, dime otra fecha."
    : "Toca el boton si algun horario te acomoda y te ayudo a agendarlo. Si no, dime otra fecha.";
  const fallbackText = buildSlotOptionsText(body, slots, allowSelection);

  try {
    await sendMessageWithOptions(to, `${body}\n\n${instruction}`, rows);
    await recordConversationMessage(to, "bot", fallbackText);
    await notifyBotReply(to, "Horarios disponibles enviados.");
  } catch (error) {
    logSafeError(`Failed sending slot options to ${maskPhone(to)}`, error);
    await replyToPatient(to, fallbackText);
  }
}

function buildSlotOptionsText(body, slots, allowSelection) {
  return `${body}\n${slots
    .map((slot, index) => `${index + 1}. ${slot.label}`)
    .join("\n")}\n\n${allowSelection ? "Responde con el numero del horario que prefieras para confirmar. Si ninguno te acomoda, dime otra fecha." : "Si alguno te acomoda, responde con el numero del horario y te ayudo a agendarlo. Si no, dime otra fecha."}`;
}

async function startAppointmentFlow(from, options = {}) {
  const presetReason = options.reason ?? undefined;
  const profile = await loadReturningPatientProfile(from);

  if (profile?.patientName) {
    const sessionStep = presetReason ? "collecting" : "collectingService";
    const session = applyReturningProfile({ from, step: sessionStep }, profile);
    if (presetReason) session.reason = presetReason;
    await setPatientSession(from, session);
    if (presetReason) {
      await replyWithDateOptions(from, `Perfecto 😊 Te ayudo a agendar el ${presetReason}.\n\n¿Para qué día te gustaría la cita?`);
    } else {
      await replyWithServiceOptions(from, buildReturningAppointmentPrompt(profile));
    }
    return;
  }

  const session = { from, step: "collecting" };
  if (presetReason) session.reason = presetReason;
  await setPatientSession(from, session);

  if (presetReason) {
    await replyToPatient(from, `😊 Perfecto, te ayudo a agendar el ${presetReason}.\n\n¿Me compartes tu nombre completo?`);
  } else {
    await replyToPatient(from, getIntentResponse("schedule_appointment"));
  }
}

async function loadReturningPatientProfile(phoneNumber) {
  try {
    return await getLatestConfirmedCitaByPhone(phoneNumber);
  } catch (error) {
    logSafeError(`Could not load returning patient profile for ${maskPhone(phoneNumber)}`, error);
    return null;
  }
}

function applyReturningProfile(session, profile) {
  return {
    ...session,
    name: session.name ?? profile.patientName,
    email: session.email ?? profile.patientEmail,
    firstVisit: session.firstVisit ?? "No",
    paymentType: session.paymentType ?? profile.paymentType
  };
}

function buildReturningPatientMenuBody(profile) {
  const lines = [
    `Hola ${firstName(profile.patientName)} 😊 que gusto volver a verte.`,
    "",
    "Ya tengo tu informacion basica guardada:",
    `Nombre: ${profile.patientName}`,
    profile.patientEmail ? `Correo: ${maskEmail(profile.patientEmail)}` : undefined,
    profile.slotStart ? `Ultima/proxima cita registrada: ${formatAppointmentShort(profile.slotStart)}` : undefined,
    "",
    "¿En que te puedo ayudar?"
  ];
  return lines.filter(Boolean).join("\n");
}

function buildReturningAppointmentPrompt(profile) {
  const lines = [
    `Hola ${firstName(profile.patientName)} 😊 que gusto volver a verte.`,
    "",
    "Ya tengo estos datos guardados:",
    `Nombre: ${profile.patientName}`,
    profile.patientEmail ? `Correo: ${maskEmail(profile.patientEmail)}` : undefined,
    "",
    "¿Que servicio o motivo general quieres agendar esta vez?"
  ];
  return lines.filter(Boolean).join("\n");
}

function buildReturningPatientDataSummary(profile) {
  const lines = [
    "Ya tengo estos datos guardados:",
    `Nombre: ${profile.patientName}`,
    profile.patientEmail ? `Correo: ${maskEmail(profile.patientEmail)}` : undefined
  ];
  return lines.filter(Boolean).join("\n");
}

function firstName(value) {
  return String(value ?? "Paciente").trim().split(/\s+/)[0] || "Paciente";
}

async function replyWithAppointmentReview(to, body) {
  await replyToPatientWithButtons(to, body, [
    { id: "confirm_yes", title: "Si, confirmar" },
    { id: "appointment_change_time", title: "Cambiar horario" },
    { id: "confirm_no", title: "Cancelar" }
  ]);
}

async function replyToPatientWithButtons(to, body, buttons) {
  try {
    await sendWhatsAppButtons(to, { body, buttons });
    await recordConversationMessage(
      to,
      "bot",
      `${body}\n\n${buttons.map((button, index) => `${index + 1}. ${button.title}`).join("\n")}`
    );
    await notifyBotReply(to, body);
  } catch (error) {
    logSafeError(`Failed sending WhatsApp buttons to ${maskPhone(to)}`, error);
    await replyToPatient(to, `${body}\n\n${buttons.map((button, index) => `${index + 1}. ${button.title}`).join("\n")}`);
  }
}

async function notifyIncomingPatientMessage(from, body) {
  if (!shouldForwardConversation(from)) return;
  await safeSendWhatsAppText(
    config.doctorWhatsappNumber,
    buildForwardCopyMessage({ type: "patient", phone: from, body })
  );
}

async function notifyBotReply(to, body) {
  if (!shouldForwardConversation(to)) return;
  await safeSendWhatsAppText(
    config.doctorWhatsappNumber,
    buildForwardCopyMessage({ type: "bot", phone: to, body })
  );
}

async function notifyResultsRequest(from) {
  await safeSendWhatsAppText(
    config.doctorWhatsappNumber,
    [
      "📎 Solicitud de resultados/estudios",
      `Telefono: ${maskPhone(from)}`,
      "",
      "Revisa el inbox. Verifica identidad, correo confirmado y archivo aprobado por el consultorio. No envies resultados por WhatsApp."
    ].join("\n")
  );
}

function buildForwardCopyMessage({ type, phone, body }) {
  const prefix = type === "bot" ? "🤖 Bot respondio" : "💬 Mensaje de paciente";
  const lines = [prefix, `Telefono: ${maskPhone(phone)}`];
  if (config.forwardConversationBodies) {
    lines.push("", sanitizeForwardedBody(body));
  } else {
    lines.push("", "Contenido oculto por privacidad. Revisa la conversacion en el inbox.");
  }
  return lines.join("\n");
}

function sanitizeForwardedBody(body) {
  return String(body ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function shouldForwardConversation(phoneNumber) {
  return config.forwardConversationCopies && phoneNumber !== config.doctorWhatsappNumber;
}

async function recordConversationMessage(phoneNumber, sender, body, metadata = {}) {
  const existing = conversations.get(phoneNumber) ?? {
    phoneNumber,
    updatedAt: undefined,
    botPaused: false,
    messages: []
  };

  const message = {
    sender,
    body,
    metadata,
    timestamp: new Date().toISOString()
  };

  existing.messages.push(message);
  existing.messages = existing.messages.slice(-maxMessagesPerConversation);
  existing.updatedAt = message.timestamp;
  conversations.set(phoneNumber, existing);

  if (!isDatabaseEnabled()) return;
  try {
    await saveConversationMessage(phoneNumber, sender, body, metadata);
  } catch (error) {
    logSafeError("Could not save conversation to Supabase", error);
  }
}

function setMemoryHumanMode(phoneNumber, enabled) {
  const existing = conversations.get(phoneNumber) ?? {
    phoneNumber,
    updatedAt: new Date().toISOString(),
    messages: []
  };
  existing.botPaused = enabled;
  existing.botPausedAt = enabled ? new Date().toISOString() : undefined;
  existing.assignedTo = enabled ? "consultorio" : undefined;
  existing.updatedAt = new Date().toISOString();
  conversations.set(phoneNumber, existing);
}

async function addConversationTags(phoneNumber, tags) {
  const cleanTags = [...new Set((tags ?? []).filter(Boolean))].slice(0, 12);
  if (cleanTags.length === 0) return;

  const existing = conversations.get(phoneNumber) ?? {
    phoneNumber,
    updatedAt: new Date().toISOString(),
    messages: []
  };
  existing.tags = [...new Set([...(existing.tags ?? []), ...cleanTags])].slice(0, 12);
  conversations.set(phoneNumber, existing);

  try {
    await setConversationTags(phoneNumber, existing.tags);
  } catch (error) {
    logSafeError("Could not save conversation tags", error);
  }
}

function setMemoryTags(phoneNumber, tags) {
  const existing = conversations.get(phoneNumber) ?? {
    phoneNumber,
    updatedAt: new Date().toISOString(),
    messages: []
  };
  existing.tags = [...new Set([...(existing.tags ?? []), ...(tags ?? [])])].slice(0, 12);
  conversations.set(phoneNumber, existing);
}

function suggestTagsFromText(text, intent) {
  const tags = [];
  if (intent === "medical_urgent" || /urgente|emergencia|sangrado|dolor fuerte|me duele mucho/.test(text)) tags.push("Urgente", "Humano requerido");
  if (intent === "direct_contact") tags.push("Humano requerido");
  if (intent === "patient_results" || /resultado|resultados|diagnostico|diagnosticos|examen|examenes|analisis|mis estudios/.test(text)) tags.push("Resultados", "Humano requerido");
  if (intent === "reschedule_appointment") tags.push("Reagendar");
  if (intent === "cancel_appointment") tags.push("Cancelar");
  if (/embarazo|prenatal/.test(text)) tags.push("Embarazo", "Control prenatal");
  if (/ultrasonido/.test(text)) tags.push("Ultrasonido");
  if (/papanicolaou|papanicolau|papanicolao/.test(text)) tags.push("Papanicolau");
  if (/colposcopia/.test(text)) tags.push("Colposcopia");
  if (/primera vez|paciente nueva/.test(text)) tags.push("Primera vez", "Nueva paciente");
  if (intent === "featured_promo") tags.push("Promo $1200", "Lead frio");
  if (intent === "recent_sex_before_exam") tags.push("Papanicolaou", "Revisar indicacion");
  if (intent === "contact_info") tags.push("Consulta rapida");
  if (intent === "schedule_appointment" && /promo|1200|chequeo|paquete/.test(text)) {
    tags.push("Promo $1200", "Lead caliente");
  } else if (intent === "schedule_appointment") {
    tags.push("Lead caliente");
  }
  if (hasAny(text, ["que incluye", "incluye ultrasonido", "incluye papanicolaou"])) tags.push("Lead tibio");
  if (hasAny(text, ["me interesa", "quiero el paquete", "me interesa la promo", "quiero agendar la promo"])) tags.push("Lead caliente", "Promo $1200");
  if (hasAny(text, ["vi el anuncio", "vi la promo", "facebook", "instagram", "meta"])) tags.push("Meta Ads");
  return tags;
}

function isHumanPauseExpired(conversationState) {
  return isHumanPauseExpiredState(conversationState, config.botPauseTimeoutMinutes);
}

async function getPatientSession(phoneNumber) {
  const cached = sessions.get(phoneNumber);
  if (cached) return cached;

  if (!isDatabaseEnabled()) return undefined;
  try {
    const saved = await getSession(phoneNumber);
    if (saved) {
      sessions.set(phoneNumber, saved);
      return saved;
    }
  } catch (error) {
    logSafeError("Could not load session from Supabase; using memory fallback", error);
  }

  return undefined;
}

async function setPatientSession(phoneNumber, session) {
  sessions.set(phoneNumber, session);
  const existing = conversations.get(phoneNumber) ?? {
    phoneNumber,
    updatedAt: new Date().toISOString(),
    messages: []
  };
  const { from: _from, updatedAt: _updatedAt, step = "collecting", ...data } = session;
  existing.session = {
    step,
    data,
    updatedAt: new Date().toISOString()
  };
  conversations.set(phoneNumber, existing);

  if (!isDatabaseEnabled()) return;
  try {
    await setSession(phoneNumber, session);
  } catch (error) {
    logSafeError("Could not save session to Supabase", error);
  }
}

async function deletePatientSession(phoneNumber) {
  sessions.delete(phoneNumber);
  const existing = conversations.get(phoneNumber);
  if (existing) {
    existing.session = undefined;
    conversations.set(phoneNumber, existing);
  }

  if (!isDatabaseEnabled()) return;
  try {
    await deleteSession(phoneNumber);
  } catch (error) {
    logSafeError("Could not delete session from Supabase", error);
  }
}

async function saveConfirmedCita(phoneNumber, session, slot, event) {
  if (!event?.id) {
    throw new Error("Google Calendar event id is required before saving appointment");
  }

  const fallback = {
    id: undefined,
    phoneNumber,
    googleEventId: event.id,
    slotStart: slot.start,
    slotEnd: slot.end,
    status: "confirmed"
  };

  if (!isDatabaseEnabled()) return fallback;

  try {
    const saved = await saveCita({
      phoneNumber,
      patientName: session.name,
      patientEmail: session.email,
      googleEventId: event?.id,
      slotStart: slot.start,
      slotEnd: slot.end,
      firstVisit: session.firstVisit,
      paymentType: session.paymentType,
      reason: config.includeSensitiveAppointmentNotes ? session.reason : undefined
    });
    if (!saved) throw new Error("Supabase did not return saved appointment");
    if (!saved.googleEventId) throw new Error("Supabase did not persist google_event_id");
    return saved;
  } catch (error) {
    logSafeError("Could not save cita to Supabase", error);
    throw new Error("Could not persist confirmed appointment", { cause: error });
  }
}

async function handleCancellationRequest(from) {
  let cita;
  try {
    cita = await getLatestConfirmedCitaByPhone(from);
  } catch (error) {
    logSafeError("Could not load cita for cancellation", error);
  }

  if (!cita) {
    await deletePatientSession(from);
    await replyToPatient(
      from,
      "No encontre una cita confirmada para cancelar por aqui. Por favor contacta directamente al consultorio para revisarlo."
    );
    return;
  }

  await setPatientSession(from, {
    from,
    step: "confirmingCancellation",
    cancellationCitaId: cita.id,
    cancellationGoogleEventId: cita.googleEventId,
    cancellationSlotStart: cita.slotStart,
    cancellationPatientName: cita.patientName
  });
  await replyToPatientWithButtons(
    from,
    `Encontre tu cita para ${formatAppointmentFull(cita.slotStart)}.\n\n¿Seguro que deseas cancelarla?`,
    [
      { id: "cancel_yes", title: "Si, cancelar" },
      { id: "cancel_no", title: "No, conservar" }
    ]
  );
}

async function handleCancellationConfirmation(from, normalized, session) {
  if (isNegativeConfirmation(normalized) || menuOptionNumber(normalized) === 2) {
    await deletePatientSession(from);
    await replyToPatient(from, "Perfecto, conservamos tu cita 😊");
    return;
  }

  if (!isAffirmativeConfirmation(normalized) && menuOptionNumber(normalized) !== 1) {
    await replyToPatient(from, "Para cancelar responde 1 o SI. Para conservar tu cita responde 2 o NO.");
    return;
  }

  let calendarOk = false;
  let dbOk = false;

  try {
    await cancelAppointment(session.cancellationGoogleEventId);
    calendarOk = true;
  } catch (error) {
    logSafeError("Could not cancel Google Calendar event", error);
  }

  if (calendarOk) {
    try {
      await cancelCita(session.cancellationCitaId);
      dbOk = true;
    } catch (error) {
      logSafeError("Could not cancel cita in Supabase", error);
    }
  }

  if (calendarOk && dbOk) {
    await deletePatientSession(from);
    await replyToPatientWithButtons(from, "✅ Listo, tu cita fue cancelada.\n\n¿Quieres agendar una nueva cita?", [
      { id: "main_schedule", title: "Agendar nueva cita" },
      { id: "main_human", title: "Hablar con persona" }
    ]);
    await safeSendWhatsAppText(
      config.doctorWhatsappNumber,
      `🛑 Cita cancelada por WhatsApp:\nPaciente: ${session.cancellationPatientName ?? "Paciente"}\nFecha: ${formatAppointmentFull(session.cancellationSlotStart)}\nTelefono: ${from}`
    );
    await notifyWaitlistForCancelledSlot(session.cancellationSlotStart);
  } else {
    logSafeError(`Cancellation incomplete calendarOk=${calendarOk} dbOk=${dbOk} for ${maskPhone(from)}`, new Error("Partial cancellation"));
    await setConversationHumanMode(from, true, "cancellation_failure");
    setMemoryHumanMode(from, true);
    await replyToPatient(
      from,
      "No pude confirmar la cancelacion automaticamente. Deje este mensaje marcado para que alguien del consultorio lo revise y confirme la cancelacion contigo directamente."
    );
    await safeSendWhatsAppText(
      config.doctorWhatsappNumber,
      `⚠️ Cancelacion incompleta — revisar manualmente:\nPaciente: ${session.cancellationPatientName ?? "Paciente"}\nFecha: ${formatAppointmentFull(session.cancellationSlotStart)}\nTelefono: ${from}\nCalendar: ${calendarOk ? "OK" : "FALLO"} | Supabase: ${dbOk ? "OK" : "FALLO"}`
    );
  }
}

async function handleAttendanceConfirmation(from, confirmed) {
  const name = await getPatientDisplayName(from);
  if (confirmed) {
    await replyToPatient(from, `✅ Perfecto, ${firstName(name) ? `${firstName(name)}, ` : ""}te esperamos. Si necesitas cancelar o cambiar tu cita, escribe aqui antes de tu cita.`);
    await addConversationTags(from, ["Confirmo asistencia"]);
    await safeSendWhatsAppText(
      config.doctorWhatsappNumber,
      `✅ Paciente confirmo asistencia:\nTelefono: ${from}${name ? `\nNombre: ${name}` : ""}`
    );
  } else {
    await handleCancellationRequest(from);
  }
}

async function getPatientDisplayName(phone) {
  try {
    const cita = await getLatestConfirmedCitaByPhone(phone);
    return cita?.patientName ?? "";
  } catch {
    return "";
  }
}

async function handleRescheduleRequest(from) {
  let cita;
  try {
    cita = await getLatestConfirmedCitaByPhone(from);
  } catch (error) {
    logSafeError("Could not load cita for reschedule", error);
  }

  if (!cita) {
    await setPatientSession(from, { from, step: "collecting" });
    await replyToPatient(
      from,
      "No encontre una cita confirmada registrada por aqui.\n\nSi gustas, puedo ayudarte a revisar horarios disponibles para agendar una cita. ¿Me compartes tu nombre completo?"
    );
    return;
  }

  await setPatientSession(from, {
    from,
    step: "confirmingReschedule",
    name: cita.patientName,
    email: cita.patientEmail,
    rescheduleFromCitaId: cita.id,
    rescheduleFromGoogleEventId: cita.googleEventId,
    rescheduleFromSlotStart: cita.slotStart
  });
  await replyToPatientWithButtons(
    from,
    `Claro, te ayudo a reagendar 😊\n\nEncontre tu cita para ${formatAppointmentFull(cita.slotStart)}.\n¿Quieres cambiarla?`,
    [
      { id: "reschedule_yes", title: "Si, cambiar" },
      { id: "reschedule_no", title: "No, conservar" },
      { id: "reschedule_human", title: "Persona" }
    ]
  );
}

async function handleRescheduleConfirmation(from, normalized, session) {
  const option = menuOptionNumber(normalized);
  if (isNegativeConfirmation(normalized) || option === 2) {
    await deletePatientSession(from);
    await replyToPatient(from, "Perfecto, conservamos tu cita actual 😊");
    return;
  }
  if (option === 3 || detectIntent(normalized).intent === "direct_contact") {
    await setConversationHumanMode(from, true, "reschedule_request");
    setMemoryHumanMode(from, true);
    await deletePatientSession(from);
    await replyToPatient(from, getIntentResponse("direct_contact"));
    return;
  }
  if (!isAffirmativeConfirmation(normalized) && option !== 1) {
    await replyToPatient(from, "Para cambiarla responde 1 o SI. Para conservarla responde 2 o NO.");
    return;
  }

  await setPatientSession(from, { ...session, step: "collecting", preferredDateText: undefined, preferredDateISO: undefined });
  await replyWithDateOptions(from, "Perfecto 😊 ¿Que dia te gustaria revisar para tu nuevo horario?");
}

async function handleWaitlistConfirmation(from, normalized, session) {
  const option = menuOptionNumber(normalized);
  if (isAffirmativeConfirmation(normalized) || option === 1) {
    try {
      await saveWaitlistEntry({
        phoneNumber: from,
        patientName: session.name,
        desiredDate: session.waitlistDateISO,
        desiredRange: session.preferredTimeRange?.label,
        service: session.reason
      });
      await deletePatientSession(from);
      await replyToPatient(from, "✅ Listo, te agregue a lista de espera. Si se libera un espacio, el consultorio podra revisarlo.");
    } catch (error) {
      logSafeError("Could not save waitlist entry", error);
      await replyToPatient(from, "No pude agregarte a lista de espera por ahora. Puedo revisar otro dia o pasarte con una persona.");
    }
    return;
  }

  if (option === 2 || /otro dia|otra fecha|ver otro/.test(normalized)) {
    await setPatientSession(from, { ...session, step: "collecting", preferredDateText: undefined, preferredDateISO: undefined });
    await replyWithDateOptions(from, "Claro 😊 ¿Que otro dia quieres revisar?");
    return;
  }

  if (option === 3 || detectIntent(normalized).intent === "direct_contact") {
    await setConversationHumanMode(from, true, "waitlist_request");
    setMemoryHumanMode(from, true);
    await deletePatientSession(from);
    await replyToPatient(from, getIntentResponse("direct_contact"));
    return;
  }

  await replyToPatient(from, "Responde 1 para lista de espera, 2 para revisar otro dia o 3 para hablar con una persona.");
}

async function notifyWaitlistForCancelledSlot(slotStart) {
  const dateISO = slotStart ? zonedDateOnly(slotStart) : undefined;
  if (!dateISO) return;
  try {
    const waiting = await loadWaitingListByDate(dateISO, 5);
    if (waiting.length === 0) return;
    await safeSendWhatsAppText(
      config.doctorWhatsappNumber,
      `📌 Se libero un horario el ${formatDateOnlyFull(dateISO)} y hay ${waiting.length} paciente(s) en lista de espera. Revisa el inbox para avisar manualmente.`
    );
  } catch (error) {
    logSafeError("Could not inspect waitlist after cancellation", error);
  }
}

async function handleConfirmAppointmentRequest(from) {
  let cita;
  try {
    cita = await getLatestConfirmedCitaByPhone(from);
  } catch (error) {
    logSafeError("Could not load cita confirmation", error);
  }

  if (!cita) {
    await replyToPatient(
      from,
      "No encontre una cita confirmada registrada por aqui.\n\nSi gustas, puedo ayudarte a revisar horarios disponibles para agendar una cita."
    );
    return;
  }

  await replyToPatient(
    from,
    `✅ Tu cita queda confirmada para el dia ${formatAppointmentFull(cita.slotStart)}.${config.clinicAddress ? `\n\nTe esperamos en ${config.clinicAddress}.` : "\n\nPor ahora el consultorio compartira la ubicacion directamente."}`
  );
}

async function cancelPreviousRescheduledAppointment(session) {
  if (!session.rescheduleFromCitaId && !session.rescheduleFromGoogleEventId) return;

  try {
    await cancelAppointment(session.rescheduleFromGoogleEventId);
    await cancelCita(session.rescheduleFromCitaId);
  } catch (error) {
    logSafeError("Could not cancel previous rescheduled appointment", error);
  }
}

async function scheduleAppointmentReminder(phoneNumber, session, slot, cita) {
  const slotStartMs = new Date(slot.start).getTime();
  const reminders = [
    {
      phoneNumber: config.doctorWhatsappNumber,
      reminderType: "admin_24h",
      remindAt: new Date(slotStartMs - 24 * 60 * 60 * 1000),
      payload: {
        patientPhone: phoneNumber,
        patientName: session.name,
        slotLabel: slot.label,
        slotStart: slot.start
      }
    },
    ...buildPatientReminderJobs({ phoneNumber, session, slot, slotStartMs })
  ];

  try {
    for (const reminder of reminders) {
      if (reminder.remindAt <= new Date()) continue;
      await scheduleReminder({
        citaId: cita?.id,
        phoneNumber: reminder.phoneNumber,
        reminderType: reminder.reminderType,
        remindAt: reminder.remindAt.toISOString(),
        payload: reminder.payload
      });
    }
  } catch (error) {
    logSafeError("Could not schedule appointment reminder", error);
  }
}

function startReminderWorker() {
  if (!config.enableReminderWorker) return;

  void cleanupProcessedWhatsAppMessages();
  void processDueReminders();
  setInterval(() => {
    void processDueReminders();
  }, Math.max(15_000, config.reminderWorkerIntervalMs)).unref?.();
}

let lastDailyReportDate = "";

function startDailyReportWorker() {
  if (!config.enableDailyReport) return;

  setInterval(() => {
    const now = new Date();
    const tz = config.clinicTimezone;
    const localHour = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(now));
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);

    if (localHour === config.dailyReportHour && localDate !== lastDailyReportDate) {
      lastDailyReportDate = localDate;
      void sendDailyReport(localDate).catch((err) => logSafeError("Daily report failed", err));
    }
  }, 60_000).unref?.();
}

async function sendDailyReport(todayISO) {
  let citas = [];
  try {
    const dayStart = new Date(`${todayISO}T00:00:00`);
    const dayEnd = new Date(`${todayISO}T23:59:59`);
    citas = (await loadConfirmedCitasBetween(dayStart.toISOString(), dayEnd.toISOString())) ?? [];
  } catch (error) {
    logSafeError("Could not load citas for daily report", error);
  }

  let promoLeads = 0;
  let humanMode = 0;
  let urgentes = 0;

  for (const conversation of conversations.values()) {
    const lastMsg = conversation.messages?.at(-1);
    if (!lastMsg?.timestamp) continue;
    if (lastMsg.timestamp.slice(0, 10) !== todayISO) continue;
    const tags = new Set((conversation.tags ?? []).map((t) => t.toLowerCase()));
    if (tags.has("promo $1200")) promoLeads++;
    if (conversation.botPaused) humanMode++;
    if (tags.has("urgente")) urgentes++;
  }

  const convRate = promoLeads > 0 ? Math.round((citas.length / promoLeads) * 100) : 0;
  const dateLabel = new Intl.DateTimeFormat("es-MX", { dateStyle: "full", timeZone: config.clinicTimezone }).format(new Date(`${todayISO}T12:00:00`));

  const lines = [
    `📊 Reporte diario — ${dateLabel}`,
    "",
    `✅ Citas confirmadas: ${citas.length}`,
    `🎯 Leads Promo $1,200: ${promoLeads}`,
    promoLeads > 0 ? `📈 Conversion promo: ${convRate}%` : undefined,
    humanMode > 0 ? `👩‍💼 Modo humano activo: ${humanMode}` : undefined,
    urgentes > 0 ? `⚠️ Urgencias: ${urgentes}` : undefined,
    "",
    ...citas.map((cita) => {
      const time = cita.slotStart
        ? new Intl.DateTimeFormat("es-MX", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: config.clinicTimezone }).format(new Date(cita.slotStart))
        : "?";
      return `• ${time} — ${cita.patientName ?? "Paciente"}`;
    }),
    citas.length === 0 ? "Sin citas confirmadas para hoy." : undefined
  ].filter(Boolean).join("\n");

  await persistDailyReport({
    date: todayISO,
    title: "Reporte diario",
    text: lines,
    body: lines,
    source: "daily",
    author: "bot",
    generatedAt: new Date().toISOString()
  });

  if (config.enableDailyReport) {
    await safeSendWhatsAppText(config.doctorWhatsappNumber, lines);
  }
}

function startPostAppointmentSurveyWorker() {
  if (!config.enablePostAppointmentSurvey) return;

  setInterval(() => {
    void processPostAppointmentSurveys();
  }, 30 * 60 * 1000).unref?.();
}

const SURVEY_BODY = "Hola 😊 Esperamos que tu cita haya sido de tu agrado.\n\n¿Como fue tu experiencia con nosotros?";

async function processPostAppointmentSurveys() {
  const now = Date.now();
  const delayMs = config.postAppointmentSurveyDelayHours * 60 * 60 * 1000;
  const windowMs = delayMs + 60 * 60 * 1000;

  for (const [phone, conversation] of conversations.entries()) {
    try {
      if (conversation.botPaused) continue;
      if ((conversation.tags ?? []).some((t) => t.toLowerCase() === "encuesta enviada")) continue;

      const slotEnd = conversation.appointment?.slotEnd;
      if (!slotEnd) continue;

      const elapsed = now - new Date(slotEnd).getTime();
      if (elapsed < delayMs || elapsed > windowMs) continue;

      // Meta compliance: free-form messages only allowed within the 24h window.
      const windowState = getWhatsAppWindowState(conversation, now);
      if (windowState.key !== "open" && windowState.key !== "closing") continue;

      await sendWhatsAppButtons(phone, {
        body: SURVEY_BODY,
        buttons: [
          { id: "survey_great", title: "Excelente ⭐⭐⭐⭐⭐" },
          { id: "survey_good", title: "Bien 👍" },
          { id: "survey_regular", title: "Regular" }
        ]
      });

      await recordConversationMessage(phone, "bot", SURVEY_BODY);
      await addConversationTags(phone, ["encuesta enviada"]);
      console.log(`Post-appointment survey sent to ${maskPhone(phone)}`);
    } catch (error) {
      logSafeError(`Could not send survey to ${maskPhone(phone)}`, error);
    }
  }
}

async function handleSurveyReply(from, rating) {
  const labelMap = {
    "encuesta excelente": "Excelente ⭐⭐⭐⭐⭐",
    "encuesta bien": "Bien 👍",
    "encuesta regular": "Regular"
  };
  const label = labelMap[rating] ?? rating;
  await addConversationTags(from, [`encuesta: ${label.toLowerCase()}`]);
  await replyToPatient(from, `¡Muchas gracias por tu calificacion! 😊 Nos da mucho gusto que hayas venido.${rating === "encuesta regular" ? " Si tuviste alguna inconveniencia, dejanos saber por aqui y con gusto lo atendemos." : ""}`);
}

function startColdLeadFollowupWorker() {
  if (!config.coldLeadFollowupEnabled) return;

  setInterval(() => {
    void processColdLeadFollowups();
  }, 30 * 60 * 1000).unref?.();
}

function startReconciliationWorker() {
  if (!isDatabaseEnabled()) return;
  // Re-reconcile every 6 hours so Calendar events deleted while the server is
  // running stop blocking slots without requiring a restart.
  setInterval(() => {
    reconcileConfirmedCitasWithGoogleCalendar().catch((err) => {
      console.error("Periodic reconciliation failed:", err?.message);
    });
  }, 6 * 60 * 60 * 1000).unref?.();
}

async function processColdLeadFollowups() {
  const now = Date.now();
  const minElapsedMs = config.coldLeadFollowupHours * 60 * 60 * 1000;
  const maxElapsedMs = 23 * 60 * 60 * 1000;

  for (const [phone, conversation] of conversations.entries()) {
    try {
      if (conversation.botPaused) continue;
      if (conversation.appointment) continue;

      const tags = new Set((conversation.tags ?? []).map((t) => t.toLowerCase()));
      if (!tags.has("promo $1200") && !tags.has("lead frio")) continue;
      if (tags.has("followup enviado")) continue;

      const lastPatientMsg = [...(conversation.messages ?? [])].reverse().find((m) => m.sender === "patient");
      if (!lastPatientMsg?.timestamp) continue;
      if (getWhatsAppWindowState(conversation).key === "expired") continue;

      const elapsedMs = now - new Date(lastPatientMsg.timestamp).getTime();
      if (elapsedMs < minElapsedMs || elapsedMs > maxElapsedMs) continue;

      const followupMsg = [
        "Hola 😊 ¿Pudiste resolver tu duda sobre el chequeo ginecologico completo de $1,200?",
        "",
        "Si quieres, con gusto te ayudo a agendar tu cita. Solo escribe 'agendar' y empezamos 😊"
      ].join("\n");

      await safeSendWhatsAppText(phone, followupMsg);
      await recordConversationMessage(phone, "bot", followupMsg);
      await addConversationTags(phone, ["followup enviado"]);
      console.log(`Cold lead follow-up sent to ${maskPhone(phone)}`);
    } catch (error) {
      logSafeError(`Could not send cold lead follow-up to ${maskPhone(phone)}`, error);
    }
  }
}

async function processDueReminders() {
  try {
    const reminders = await loadDueReminders();
    for (const reminder of reminders) {
      try {
        await sendReminder(reminder);
        await markReminderSent(reminder.id);
      } catch (error) {
        logSafeError(`Could not send reminder ${reminder.id}`, error);
        await markReminderFailed(reminder.id, error.message);
      }
    }
  } catch (error) {
    logSafeError("Reminder worker skipped cycle", error);
  }
}

async function sendReminder(reminder) {
  if (reminder.reminderType === "admin_24h") {
    await sendWhatsAppText(
      reminder.phoneNumber,
      `⏰ Recordatorio de cita mañana:\nPaciente: ${reminder.payload.patientName ?? "Paciente"}\nFecha: ${
        reminder.payload.slotLabel ?? formatAppointmentFull(reminder.payload.slotStart)
      }\nTelefono: ${reminder.payload.patientPhone ?? "No capturado"}`
    );
    return;
  }

  if (reminder.reminderType === "patient_24h") {
    if (!config.whatsappReminderTemplate24h) return;
    await sendWhatsAppTemplate(
      reminder.phoneNumber,
      config.whatsappReminderTemplate24h,
      config.whatsappTemplateLanguage,
      [reminder.payload.patientName ?? "Paciente", reminder.payload.slotLabel ?? formatAppointmentFull(reminder.payload.slotStart)]
    );
    return;
  }

  if (reminder.reminderType === "patient_2h") {
    if (!config.whatsappReminderTemplate2h) return;
    await sendWhatsAppTemplate(
      reminder.phoneNumber,
      config.whatsappReminderTemplate2h,
      config.whatsappTemplateLanguage,
      [reminder.payload.patientName ?? "Paciente", reminder.payload.slotLabel ?? formatAppointmentFull(reminder.payload.slotStart)]
    );
    return;
  }

  if (reminder.reminderType === "patient_attendance_confirm") {
    const name = reminder.payload.patientName ?? "Paciente";
    const slotLabel = reminder.payload.slotLabel ?? formatAppointmentFull(reminder.payload.slotStart);
    const body = `⏰ Hola ${firstName(name)}, te recuerdo tu cita para ${slotLabel}.\n\n¿Confirmas tu asistencia?`;
    await sendWhatsAppButtons(reminder.phoneNumber, {
      body,
      buttons: [
        { id: "attendance_yes", title: "Si, voy" },
        { id: "attendance_cancel", title: "Necesito cancelar" }
      ]
    });
  }
}

function answerFaq(text) {
  return getIntentResponse(detectIntent(text).intent);
}

function getIntentResponse(intent) {
  const responses = {
    greeting: [
      "Hola 😊 Soy el asistente virtual del consultorio.",
      "",
      "Puedo ayudarte con:",
      "1. 📅 Agendar una cita",
      "2. 🕒 Ver horarios disponibles",
      "3. 🎁 Promo $1200",
      "4. 🩺 Servicios",
      "5. 💰 Costos",
      "6. 📍 Ubicacion",
      "7. 📝 Preparacion",
      "8. 🕓 Horario de atencion",
      "9. 💵 Formas de pago",
      "10. 📎 Resultados/estudios",
      "11. 👩‍💼 Hablar con persona",
      "",
      PRIVACY_CONSENT_TEXT,
      "",
      "¿Que necesitas? Si necesitas a una persona, escribe humano."
    ].join("\n"),
    location: buildLocationMessage(),
    clinic_hours: "🕓 Atendemos de lunes a viernes por la tarde, de 4:40 p.m. a 8:00 p.m.\n\nNo atendemos sabados, domingos ni por la manana.\n\nPuedo ayudarte a revisar horarios disponibles para agendar.",
    morning_hours: "🌙 No atendemos por la manana. Solo por la tarde, de 4:40 p.m. a 8:00 p.m.\n\n¿Quieres que revise horarios por la tarde?",
    saturday: "📅 No atendemos los sabados ni domingos. Solo de lunes a viernes por la tarde.\n\n¿Quieres que revise disponibilidad entre semana?",
    cost: `💰 La consulta tiene un costo de ${formatMoney(config.consultationPrice)} MXN.`,
    promotion: config.promotionDetails
      ? `🎁 Si, contamos con paquete promocional en ${formatMoney(config.promotionPrice)} MXN.\n\nIncluye:\n${config.promotionDetails}\n\n¿Quieres revisar horarios disponibles?`
      : `🎁 Si, contamos con paquete promocional en ${formatMoney(config.promotionPrice)} MXN.\n\nPara confirmarte exactamente que incluye segun el servicio que necesitas, puedo ayudarte a agendar o pasarte con una persona del consultorio.\n\n¿Quieres revisar horarios disponibles?`,
    payment_methods: "💵 Por el momento aceptamos efectivo o transferencia bancaria.\n\nNo contamos con pago con tarjeta por ahora.",
    insurance_network: "🏥 La cita puede registrarse como particular o por red medica/aseguradora.\n\nSi vienes por red medica, el consultorio confirma los datos necesarios al registrar tu cita.",
    schedule_appointment: "😊 Claro, te ayudo a agendar tu cita.\n\n¿Me compartes tu nombre completo?",
    check_availability: "🕒 Claro. ¿Para que dia te gustaria revisar disponibilidad?\n\nPuedes decirme, por ejemplo: hoy, manana, viernes o una fecha especifica.",
    closing: "😊 Con gusto. Si necesitas algo mas, aqui estoy para ayudarte.",
    appointment_preparation: [
      "⏱️ Cada cita dura aproximadamente 40 minutos.",
      "",
      "Para presentarte a tu cita o paquete, te recomendamos:",
      "",
      "• No estar en el periodo menstrual (regla).",
      "• No haber tenido relaciones sexuales en las 48 horas previas.",
      "• No haberse realizado duchas vaginales durante las 48 horas previas.",
      "• No haberse aplicado tratamiento medico vaginal (ovulos o cremas) durante las ultimas 48 horas.",
      "",
      "Si tienes dolor fuerte, sangrado abundante o una urgencia, acude a urgencias o contacta directamente al consultorio."
    ].join("\n"),
    appointment_duration: "⏱️ Las citas tienen una duracion aproximada de 40 minutos.",
    new_patient: "Claro 😊 Podemos ayudarte a agendar tu primera consulta.\n\n¿Me compartes tu nombre completo para iniciar el registro?",
    medical_services:
      "Podemos ayudarte con informacion administrativa sobre:\n\n• Consulta ginecologica\n• Promo de chequeo completo $1,200\n• Papanicolaou\n• Ultrasonido pelvico/endovaginal\n• Colposcopia\n• Control prenatal/embarazo\n• Revision de mamas\n• Pacientes adolescentes\n\nSi quieres, puedo ayudarte a agendar y elegir horario.",
    medical_urgent: [
      MEDICAL_URGENCY_TEXT,
      "",
      MEDICAL_CHAT_SAFE_TEXT
    ].join("\n"),
    medication_question: [
      MEDICAL_CHAT_SAFE_TEXT,
      "",
      MEDICAL_URGENCY_TEXT
    ].join("\n"),
    patient_results:
      `${RESULTS_PRIVACY_TEXT}\n\nYa deje tu solicitud marcada para revision en el inbox.\n\n${MEDICAL_URGENCY_TEXT}`,
    direct_contact:
      "Claro 😊 Ya deje esta conversacion para revision del consultorio.\n\nMientras tanto, tambien puedo ayudarte automaticamente con citas, horarios, ubicacion, costos, promo, pagos, preparacion o resultados.\n\nSi es una urgencia medica, acude a urgencias o llama a los servicios de emergencia de tu localidad.",
    appointment_requirements:
      "Para tu cita, te recomendamos llevar identificacion y, si tienes, estudios o recetas anteriores relacionados con tu consulta.\n\nSi tu cita incluye Papanicolaou o paquete de promocion, tambien se recomienda no estar en periodo menstrual, no tener relaciones sexuales, no realizar duchas vaginales y no aplicar ovulos o cremas vaginales durante las 48 horas previas.",
    late_arrival:
      "Gracias por avisar 😊\n\nPor favor contacta directamente al consultorio para confirmar si aun es posible atenderte en tu horario o si es necesario reagendar.",
    invoice: "Para temas de factura, por favor consulta directamente con el consultorio para confirmar disponibilidad y requisitos.",
    featured_promo: [
      "Claro 😊 La promocion es el chequeo ginecologico completo por $1,200.",
      "",
      "Incluye:",
      "- Consulta ginecologica",
      "- Papanicolaou",
      "- Ultrasonido pelvico",
      "- Ultrasonido endovaginal",
      "- Revision de mamas",
      "- Apoyo para deteccion oportuna de cancer cervico uterino",
      "- Apoyo para deteccion oportuna de cancer ovarico",
      "",
      "Estamos en Plaza de la Paz #20, consultorio 14, segundo piso.",
      "",
      "Escribe 'agendar' para reservar tu cita 😊"
    ].join("\n"),
    recent_sex_before_exam: [
      "Gracias por avisar 😊",
      "",
      "Para el Papanicolaou se recomienda evitar relaciones sexuales, duchas vaginales, ovulos, cremas o medicamentos vaginales durante las 48 horas previas, porque pueden alterar la muestra.",
      "",
      "Lo mejor es que una persona del consultorio confirme si conviene realizarlo o reagendar."
    ].join("\n"),
    contact_info: [
      "Por este medio podemos ayudarte con citas, ubicacion, costos y dudas generales 😊",
      "",
      "Si necesitas atencion directa, escribe 'humano' para que una persona del consultorio te apoye."
    ].join("\n"),
    fallback: [
      "Perdon, no entendi bien.",
      "",
      "¿Con que te ayudo?"
    ].join("\n")
  };

  return responses[intent];
}

function formatMoney(value) {
  const raw = String(value).replace(/[^\d.]/g, "");
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return String(value).startsWith("$") ? value : `$${value}`;
  return `$${new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 }).format(amount)}`;
}

function formatFileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "0 MB";
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${Math.round((size / 1024 / 1024) * 10) / 10} MB`;
}

async function findApprovedKnowledgeAnswer(normalizedText) {
  if (!normalizedText || isAppointmentLikeQuestion(normalizedText)) return undefined;

  try {
    const suggestions = await loadKnowledgeSuggestions("approved", 50);
    const match = suggestions.find(
      (suggestion) =>
        suggestion.active !== false &&
        (knowledgeMatches(normalizedText, suggestion.question) ||
          (suggestion.variations ?? []).some((variation) => knowledgeMatches(normalizedText, variation)))
    );
    if (!match) return undefined;
    return {
      answer: match.answer,
      action: match.action ?? "answer"
    };
  } catch (error) {
    logSafeError("Could not load approved knowledge", error);
    return undefined;
  }
}

function knowledgeMatches(text, question) {
  const words = meaningfulWords(normalizeText(question ?? ""));
  if (words.length === 0) return false;
  const hits = words.filter((word) => text.includes(word)).length;
  return hits >= Math.min(2, words.length);
}

function parseVariations(value) {
  return String(value ?? "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 3)
    .slice(0, 20);
}

async function saveUnrecognizedQuestion(from, text, category) {
  try {
    await saveKnowledgeSuggestion({
      question: text,
      answer: "",
      sourcePhone: from,
      conversationPhone: from,
      category: category ?? "desconocido",
      status: "pending"
    });
  } catch (error) {
    logSafeError(`Could not save unrecognized question for ${maskPhone(from)}`, error);
  }
  void appendUnknownQuestionToSheet({ phone: from, question: text, category: category ?? "desconocido" }).catch(() => {});
}

function isResetCommand(text) {
  return /^(?:menu|menú|reiniciar|empezar de nuevo|volver al menu|volver al menú)$/.test(text);
}

function isSkipEmailText(text) {
  return /^(?:sin correo|no tengo correo|no tengo|sin email|omitir|saltar|no quiero correo|no email|no tiene)$/.test(text);
}

function isAmbiguousShortReply(text) {
  return /^(?:si|sí|ok|okay|va|sale|claro|bueno|me interesa|quiero|agendar|agenda|apartar|reservar|ya)$/.test(text);
}

function isActiveSessionContinue(text) {
  return /^(?:continuar|seguir|seguimos|sigamos|continuemos|donde ibamos|donde vamos)$/.test(text);
}

function isActiveSessionRestart(text) {
  return /^(?:nuevo inicio|empezar de nuevo|reiniciar|menu|menú|volver al menu|volver al menú)$/.test(text);
}

function buildActiveSessionGreeting(session) {
  const stepLabel = formatSessionStep(session.step).toLowerCase();
  return [
    "Hola 😊 Veo que teniamos una conversacion en proceso.",
    `Estabamos en: ${stepLabel}.`,
    "",
    "¿Quieres continuar donde ibamos o empezar de nuevo?"
  ].join("\n");
}

function buildVagueActiveSessionPrompt(session) {
  const stepLabel = formatSessionStep(session.step).toLowerCase();
  return [
    "Te entiendo 😊 Para no confundirme ni mover tu cita por error:",
    `tenemos un flujo abierto en ${stepLabel}.`,
    "",
    "¿Quieres continuar, empezar de nuevo o hablar con una persona?"
  ].join("\n");
}

function isVagueActiveSessionReply(text) {
  return /^(?:a ver|aver|ok|okay|va|sale|mmm|mm|no se|nose|pues|ya|aja|ah ok|bueno)$/.test(text);
}

function isAffirmativeConfirmation(text) {
  return /^(?:si|sí|confirmo|confirmar|correcto|asi esta bien|esta bien|ok|okay|va|sale|adelante)$/.test(text);
}

function isNegativeConfirmation(text) {
  return /^(?:no|nel|mejor no|no confirmar|cambiar|otro horario|otra fecha|no gracias)$/.test(text);
}


async function safeSendWhatsAppText(to, body) {
  try {
    await sendWhatsAppText(to, body);
  } catch (error) {
    logSafeError(`Failed sending fallback WhatsApp message to ${maskPhone(to)}`, error);
  }
}

function isValidWebhookSignature(req, rawBody) {
  if (!config.whatsappAppSecret) {
    if (!config.allowUnsignedWebhooks) return false;
    if (isUnsignedWebhookExpired()) return false;
    if (!appSecretWarningShown) {
      console.warn("WARNING: WHATSAPP_APP_SECRET is not configured; accepting unsigned webhooks because ALLOW_UNSIGNED_WEBHOOKS=true.");
      appSecretWarningShown = true;
    }
    return true;
  }

  if (!config.requireWebhookSignature) return true;

  return verifyMetaSignature({
    appSecret: config.whatsappAppSecret,
    signatureHeader: req.headers["x-hub-signature-256"],
    rawBody
  });
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data: https:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
}

function checkRateLimit(req, url, scope) {
  const now = Date.now();
  const isLogin = scope === "inbox-login";
  const windowMs = isLogin ? 15 * 60_000 : 60_000;
  const limit = getRateLimitForScope(url, scope);
  const key = `${scope ?? url.pathname}:${getClientIp(req)}`;
  if (url.pathname.startsWith("/webhook") && !checkBucket(`webhook-global:${Math.floor(now / windowMs)}`, config.webhookRateLimitPerMinute, windowMs, now)) {
    return false;
  }
  return checkBucket(key, limit, windowMs, now);
}

function getRateLimitForScope(url, scope) {
  if (scope === "inbox-login") return config.inboxLoginRateLimitPer15Minutes;
  if (scope === "inbox-send") return config.inboxSendRateLimitPerMinute;
  if (scope === "inbox-action") return config.inboxActionRateLimitPerMinute;
  if (url.pathname.startsWith("/inbox") || url.pathname.startsWith("/debug")) return config.inboxRateLimitPerMinute;
  return config.webhookRateLimitPerMinute;
}

function checkBucket(key, limit, windowMs, now = Date.now()) {
  const bucket = rateLimitBuckets.get(key) ?? { count: 0, resetAt: now + windowMs };

  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }

  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);

  for (const [bucketKey, value] of rateLimitBuckets) {
    if (now > value.resetAt + windowMs) rateLimitBuckets.delete(bucketKey);
  }

  return bucket.count <= limit;
}

function checkPhoneRateLimit(phoneNumber) {
  const now = Date.now();
  const windowMs = 60_000;
  const key = `phone:${normalizePhone(phoneNumber) || "unknown"}`;
  const bucket = rateLimitBuckets.get(key) ?? { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  return bucket.count <= config.webhookPhoneRateLimitPerMinute;
}

async function alreadyProcessed(messageId, fromPhone) {
  if (!messageId) return false;

  const now = Date.now();
  for (const [id, timestamp] of processedMessages) {
    if (now - timestamp > processedMessageTtlMs) processedMessages.delete(id);
  }

  if (processedMessages.has(messageId)) return true;

  if (isDatabaseEnabled()) {
    try {
      const duplicate = await rememberProcessedWhatsAppMessage(messageId, fromPhone);
      if (duplicate) {
        processedMessages.set(messageId, now);
        return true;
      }
    } catch (error) {
      logSafeError("Could not persist WhatsApp message dedupe", error);
    }
  }

  processedMessages.set(messageId, now);
  return false;
}

function isUnsignedWebhookExpired() {
  if (!config.unsignedWebhookExpiresAt) return false;
  const expiresAt = new Date(config.unsignedWebhookExpiresAt).getTime();
  return Number.isFinite(expiresAt) && Date.now() > expiresAt;
}

function redirectInbox(res, phone, message, kind = "error", extraParams = {}) {
  const params = new URLSearchParams();
  if (phone) params.set("phone", phone);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value) params.set(key, value);
  }
  if (message) params.set(kind === "success" ? "success" : "error", message);
  res.writeHead(303, { Location: `/inbox${params.toString() ? `?${params}` : ""}` }).end();
}

function createLoginCsrfToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function setLoginCsrfCookie(res, token) {
  const cookie = [`login_csrf=${encodeURIComponent(token)}`, "HttpOnly", "SameSite=Lax", "Path=/inbox", "Max-Age=600"];
  if (config.nodeEnv === "production") cookie.push("Secure");
  res.setHeader("Set-Cookie", cookie.join("; "));
}

function isValidLoginCsrf(req, token) {
  const expected = parseCookies(req.headers.cookie ?? "").login_csrf;
  return Boolean(expected && token && secureCompare(expected, token));
}

function createSessionCsrfToken(req) {
  const sessionToken = parseCookies(req.headers.cookie ?? "").inbox_session ?? "";
  return crypto.createHmac("sha256", getCookieSecret()).update(sessionToken).digest("base64url");
}

function isValidCsrf(req, token) {
  return Boolean(token && secureCompare(createSessionCsrfToken(req), token));
}

function getCookieSecret() {
  return config.cookieSecret || config.inboxPasswordHash || config.inboxPassword || config.whatsappVerifyToken;
}

function isValidInboxPassword(password) {
  if (config.inboxPasswordHash) {
    return secureCompare(hashPassword(password), normalizePasswordHash(config.inboxPasswordHash));
  }
  return Boolean(config.inboxPassword && secureCompare(password, config.inboxPassword));
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
}

function normalizePasswordHash(hash) {
  return String(hash).replace(/^sha256:/i, "").trim();
}

function normalizePhone(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function isValidWhatsAppPhone(value) {
  return /^\d{10,15}$/.test(normalizePhone(value));
}

function maskPhone(value) {
  const phone = normalizePhone(value);
  if (phone.length <= 6) return phone ? "***" : "";
  return `${phone.slice(0, 5)}****${phone.slice(-3)}`;
}

function maskIdentifier(value) {
  const id = String(value ?? "").trim();
  if (!id) return "";
  if (id.length <= 8) return "***";
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function secureCompare(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function logSafeError(message, error) {
  console.error(message, {
    name: error?.name,
    message: redactSecrets(error?.message ?? String(error))
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
