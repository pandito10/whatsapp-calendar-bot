import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { understandMessage } from "./ai.js";
import { cancelAppointment, createAppointment, findAvailableSlots, isClinicWorkDateISO, isSlotAvailable } from "./calendar.js";
import { config } from "./config.js";
import { buildDateOptionRows, dateOptionReplyText } from "./date-options.js";
import { readForm, readRawBody } from "./form.js";
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
import { detectIntent, isAppointmentLikeQuestion, looksLikeDateRequest, meaningfulWords, normalizeText } from "./intents.js";
import {
  buildInboxStats as buildInboxMetrics,
  buildLocalConversationSummary,
  filterInboxConversations as filterInboxConversationList,
  getConversationStatus as getInboxConversationStatus,
  getOfferedSlots,
  getWhatsAppWindowState,
  sortInboxConversations
} from "./inbox.js";
import { verifyMetaSignature } from "./security.js";
import {
  acquireAppointmentLock,
  checkDatabaseHealth,
  cancelCita,
  cleanupProcessedWhatsAppMessages,
  deleteSession,
  getConversationState,
  getLatestConfirmedCitaByPhone,
  getSession,
  isDatabaseEnabled,
  loadActiveAppointmentLocks,
  loadDueReminders,
  loadConversations,
  loadConfirmedCitasBetween,
  loadWaitingListByDate,
  markReminderFailed,
  markReminderSent,
  markCitaFailedByGoogleEvent,
  markConversationHumanReply,
  releaseAppointmentLock,
  rememberProcessedWhatsAppMessage,
  loadKnowledgeSuggestions,
  deleteKnowledgeSuggestion,
  reviewKnowledgeSuggestion,
  saveCita,
  saveConversationMessage,
  saveConversationNote,
  saveKnowledgeSuggestion,
  saveWaitlistEntry,
  scheduleReminder,
  setConversationHumanMode,
  setConversationTags,
  setSession,
  updateKnowledgeSuggestion
} from "./db.js";
import { sendWhatsAppButtons, sendWhatsAppList, sendWhatsAppMedia, sendWhatsAppTemplate, sendWhatsAppText } from "./whatsapp.js";

const sessions = new Map();
const processedMessages = new Map();
const processedMessageTtlMs = 24 * 60 * 60 * 1000;
const conversations = new Map();
const maxMessagesPerConversation = 100;
const rateLimitBuckets = new Map();
let appSecretWarningShown = false;
let isShuttingDown = false;

const mainMenuRows = [
  { id: "main_schedule", title: "Agendar cita", description: "Iniciar registro y elegir horario" },
  { id: "main_availability", title: "Ver horarios", description: "Revisar fechas disponibles" },
  { id: "main_location", title: "Ubicacion", description: "Direccion del consultorio" },
  { id: "main_costs", title: "Costos", description: "Consulta y promocion" },
  { id: "main_payments", title: "Formas de pago", description: "Efectivo o transferencia" },
  { id: "main_services", title: "Servicios", description: "Dudas generales de servicios" },
  { id: "main_human", title: "Hablar con persona", description: "Pedir apoyo del consultorio" }
];

const interactiveReplyMap = {
  main_schedule: "1",
  main_availability: "2",
  main_location: "3",
  main_costs: "4",
  main_payments: "5",
  main_services: "6",
  main_human: "7",
  returning_schedule: "quiero agendar otra cita",
  returning_next: "tengo cita",
  returning_reschedule: "quiero reagendar",
  returning_cancel: "quiero cancelar",
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
  waitlist_human: "3"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    setSecurityHeaders(res);

    if (!checkRateLimit(req, url)) {
      res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
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
      if (!isValidWebhookSignature(req, rawBody)) {
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
        console.warn(`Rejected WhatsApp webhook payload: ${validation.reason}`);
        res.writeHead(validation.status ?? 400, { "Content-Type": "text/plain; charset=utf-8" }).end(validation.publicMessage ?? "invalid payload");
        return;
      }
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

    if (req.method === "POST" && url.pathname === "/inbox/takeover") {
      await handleInboxTakeover(req, url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/inbox/release") {
      await handleInboxRelease(req, url, res);
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
    if (config.whatsappBusinessAccountId && entry?.id !== config.whatsappBusinessAccountId) {
      return { ok: false, reason: "unexpected business account id", status: 403, publicMessage: "forbidden" };
    }

    if (!Array.isArray(entry?.changes)) {
      return { ok: false, reason: "changes is not array", status: 400, publicMessage: "invalid payload" };
    }

    for (const change of entry.changes) {
      if (change?.field !== "messages") continue;
      hasProcessableChange = true;

      const metadata = change.value?.metadata;
      if (metadata?.phone_number_id !== config.whatsappPhoneNumberId) {
        return { ok: false, reason: "unexpected phone_number_id", status: 403, publicMessage: "forbidden" };
      }

      if (
        config.whatsappDisplayPhoneNumber &&
        normalizePhone(metadata?.display_phone_number) !== normalizePhone(config.whatsappDisplayPhoneNumber)
      ) {
        return { ok: false, reason: "unexpected display_phone_number", status: 403, publicMessage: "forbidden" };
      }
    }
  }

  if (!hasProcessableChange) return { ok: true, noMessages: true };
  return { ok: true };
}

async function handleHealth(req, res, options = {}) {
  const db = await checkDatabaseHealth();
  const health = buildOperationalHealth({
    db,
    conversationCount: conversations.size,
    memorySessionCount: sessions.size,
    processedMessageCount: processedMessages.size
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
        calendarIdSource: config.googleCalendarIdConfigured ? "env" : "default-calendario-azul",
        usingConfiguredCalendar: config.googleCalendarIdConfigured,
        clinicTimezone: config.clinicTimezone,
        appointmentMinutes: config.appointmentMinutes,
        maxOfferedSlots: config.maxOfferedSlots,
        workStart: config.workStart,
        workEnd: config.workEnd,
        whatsappPhoneNumberId: config.whatsappPhoneNumberId,
        whatsappBusinessAccountId: config.whatsappBusinessAccountId,
        webhookSignatureMode: config.whatsappAppSecret && config.requireWebhookSignature ? "signed" : config.allowUnsignedWebhooks ? "unsigned-temporary" : "blocked",
        webhookPathSecretEnabled: Boolean(config.webhookPathSecret),
        doctorWhatsappNumber: maskPhone(config.doctorWhatsappNumber),
        databaseEnabled: isDatabaseEnabled(),
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

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderInboxPage(list, selected, req, url, knowledgeSuggestions, diagnostics));
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
      ok: Boolean(config.whatsappAccessToken && config.whatsappPhoneNumberId),
      detail: config.whatsappAccessToken && config.whatsappPhoneNumberId ? "Configurado" : "Faltan token o phone number id"
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
      label: "Inbox",
      ok: Boolean((config.inboxPassword || config.inboxPasswordHash) && config.cookieSecret),
      detail: (config.inboxPassword || config.inboxPasswordHash) && config.cookieSecret ? "Protegido" : "Falta auth/cookie"
    },
    {
      label: "Recordatorios",
      ok: !config.enableReminderWorker || config.enablePatientReminderTemplates,
      detail: config.enableReminderWorker
        ? config.enablePatientReminderTemplates ? "Templates activos" : "Worker activo sin templates"
        : "Apagados seguro"
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

  function initInbox() {
    bindQuickReplies();
    bindCopyButtons();
    bindComposerEnhancements();
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
  const attachmentValidation = validAttachment ? validateInboxAttachment(validAttachment) : undefined;

  if (!isValidWhatsAppPhone(phone) || (!message && !validAttachment) || message.length > 2000) {
    await redirectInbox(res, phone, "Mensaje invalido o telefono invalido.");
    return;
  }
  if (message && validAttachment && message.length > 1024) {
    await redirectInbox(res, phone, "El texto con archivo debe ser de maximo 1024 caracteres.");
    return;
  }
  if (attachmentValidation) {
    await redirectInbox(res, phone, attachmentValidation);
    return;
  }

  try {
    if (validAttachment) {
      const mediaResult = await sendWhatsAppMedia(phone, validAttachment, { caption: message });
      await recordConversationMessage(
        phone,
        "human",
        buildInboxAttachmentBody(validAttachment, mediaResult.mediaType, message),
        {
          source: "inbox",
          media: {
            id: mediaResult.mediaId,
            type: mediaResult.mediaType,
            filename: validAttachment.filename,
            contentType: validAttachment.contentType,
            size: validAttachment.size
          }
        }
      );
    } else {
      await sendWhatsAppText(phone, message);
      await recordConversationMessage(phone, "human", message, { source: "inbox" });
      await saveHumanKnowledgeSuggestion(phone, message);
    }
    await markConversationHumanReply(phone);
    console.log(`Inbox human reply sent to ${maskPhone(phone)}`);
    await redirectInbox(res, phone);
  } catch (error) {
    logSafeError(`Could not send inbox reply to ${maskPhone(phone)}`, error);
    await redirectInbox(res, phone, "No se pudo enviar el mensaje por WhatsApp.");
  }
}

function validateInboxAttachment(file) {
  if (file.size > config.inboxMediaMaxBytes) {
    return `El archivo supera el limite de ${formatFileSize(config.inboxMediaMaxBytes)}.`;
  }

  const contentType = String(file.contentType ?? "").toLowerCase();
  const filename = String(file.filename ?? "").toLowerCase();
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  const allowedTypes = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "video/mp4",
    "video/3gpp",
    "application/pdf",
    "text/plain",
    "text/csv",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ]);
  const allowedExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".mp4", ".3gp", ".pdf", ".txt", ".csv", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);

  if (!allowedTypes.has(contentType) && !(contentType === "application/octet-stream" && allowedExtensions.has(extension))) {
    return "Tipo de archivo no permitido. Usa foto, video, PDF, Word, Excel, PowerPoint, TXT o CSV.";
  }

  return undefined;
}

function buildInboxAttachmentBody(file, mediaType, caption) {
  const label = mediaType === "image" ? "Imagen enviada" : mediaType === "video" ? "Video enviado" : "Archivo enviado";
  const lines = [`${mediaType === "image" ? "🖼️" : mediaType === "video" ? "🎥" : "📎"} ${label}: ${file.filename}`];
  if (caption) lines.push("", caption);
  return lines.join("\n");
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

function parseTags(value) {
  return String(value ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length >= 2)
    .slice(0, 12);
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
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #2d1724; background: #fff1f6; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at top left, rgba(244, 114, 182, 0.28), transparent 28rem), linear-gradient(135deg, #fff7fb, #ffe4ef); }
    main { width: min(420px, 100%); background: rgba(255, 255, 255, 0.92); border: 1px solid #f3c9d8; border-radius: 22px; padding: 30px; box-shadow: 0 20px 52px rgba(157, 23, 77, 0.14); }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { margin: 0 0 20px; color: #8a5c6e; line-height: 1.45; }
    label { display: block; font-weight: 700; font-size: 14px; margin-bottom: 8px; }
    input { width: 100%; border: 1px solid #f1b9cf; border-radius: 14px; padding: 12px; font: inherit; }
    input:focus { border-color: #db2777; box-shadow: 0 0 0 4px rgba(219, 39, 119, 0.12); outline: none; }
    button { width: 100%; margin-top: 14px; border: 0; border-radius: 14px; padding: 12px; background: linear-gradient(135deg, #db2777, #f472b6); color: white; font: inherit; font-weight: 800; cursor: pointer; box-shadow: 0 12px 24px rgba(219, 39, 119, 0.2); }
    .error { margin-bottom: 14px; padding: 10px 12px; border-radius: 10px; color: #991b1b; background: #fee2e2; border: 1px solid #fecaca; }
  </style>
</head>
<body>
  <main>
    <h1>Inbox del bot</h1>
    <p>Entra con la clave privada del consultorio.</p>
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

function renderInboxPage(list, selected, req, url, knowledgeSuggestions = [], diagnostics) {
  const csrf = createSessionCsrfToken(req);
  const q = normalizeText(url.searchParams.get("q") ?? "");
  const filter = url.searchParams.get("filter") ?? "all";
  const filteredList = sortInboxConversations(filterInboxConversationList(list, q, filter));
  if (selected && !filteredList.some((conversation) => conversation.phoneNumber === selected.phoneNumber)) {
    filteredList.unshift(selected);
  }
  const stats = buildInboxMetrics(list);
  const operationalStatus = renderOperationalStatusBadges();
  const selectedStatus = selected ? getInboxConversationStatus(selected) : undefined;
  const selectedName = selected ? getConversationDisplayName(selected) : "";
  const appointmentCard = selected?.appointment ? renderAppointmentCard(selected.appointment) : "";
  const inboxError = url.searchParams.get("error");
  const selectedPhone = selected?.phoneNumber ?? "";
  const windowState = selected ? getWhatsAppWindowState(selected) : undefined;
  const needsTemplateNotice = windowState?.key === "expired";
  const closingTemplateNotice = windowState?.key === "closing";
  const quickReplies = selected ? renderQuickReplies() : "";
  const rightPanel = renderPatientPanel(selected, { csrf, selectedPhone, selectedStatus, windowState, knowledgeSuggestions });
  const filterOptions = renderInboxQuickFilters(filter, url.searchParams.get("q") ?? "");
  const diagnosticsCard = renderInboxDiagnostics(diagnostics);
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
            return `<a class="thread${active}" href="/inbox?${buildInboxQuery({ phone: conversation.phoneNumber, q: url.searchParams.get("q"), filter })}">
              <div class="avatar">${escapeHtml(conversation.phoneNumber.slice(-2))}</div>
              <div class="thread-copy">
                <div class="thread-top">
                  <strong>${escapeHtml(title)}</strong>
                  <span>${formatInboxDate(conversation.updatedAt)}</span>
                </div>
                <div class="thread-sub">${escapeHtml(formatPhoneForInbox(conversation.phoneNumber))}</div>
                <p>${escapeHtml(last?.body ?? "")}</p>
                <div class="thread-tags">
                  <span class="tag ${status.className}">${status.label}</span>
                  ${conversationWindow.key === "closing" ? `<span class="tag closing">24h por cerrar</span>` : ""}
                  ${conversationWindow.key === "expired" ? `<span class="tag expired">Template Meta</span>` : ""}
                  ${conversation.botPaused ? `<span class="tag human">Modo humano</span>` : ""}
                  ${(conversation.tags ?? []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
                  ${conversation.appointment?.slotStart ? `<span class="tag">${formatAppointmentShort(conversation.appointment.slotStart)}</span>` : ""}
                </div>
              </div>
            </a>`;
          })
          .join("");

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
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="20">
  <title>Inbox del bot</title>
  <script src="/inbox.js" defer></script>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #fff1f6;
      color: #2d1724;
      --line: #f3c9d8;
      --muted: #8a5c6e;
      --brand: #db2777;
      --brand-dark: #9d174d;
      --brand-soft: #fce7f3;
      --brand-pale: #fff5f8;
      --surface: #ffffff;
      --soft: #fff7fb;
      --shadow: rgba(157, 23, 77, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(244, 114, 182, 0.26), transparent 32rem),
        radial-gradient(circle at 88% 12%, rgba(251, 207, 232, 0.72), transparent 24rem),
        linear-gradient(135deg, #fff7fb 0%, #ffe4ef 48%, #fff7fb 100%);
    }
    header {
      height: 72px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 28px;
      border-bottom: 1px solid rgba(243, 201, 216, 0.86);
      background: rgba(255, 247, 251, 0.9);
      backdrop-filter: blur(14px);
      position: sticky;
      top: 0;
      z-index: 3;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-mark {
      display: grid;
      place-items: center;
      width: 38px;
      height: 38px;
      border-radius: 12px;
      background: linear-gradient(135deg, #db2777, #f472b6);
      color: #ffffff;
      font-weight: 800;
      box-shadow: 0 12px 28px rgba(219, 39, 119, 0.26);
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
      border: 1px solid #f3c9d8;
      background: #ffffff;
      color: #6b2144;
      box-shadow: 0 6px 14px rgba(157, 23, 77, 0.06);
    }
    .health-pill.ok { color: #166534; background: #dcfce7; border-color: #bbf7d0; }
    .health-pill.warn { color: #92400e; background: #fef3c7; border-color: #fde68a; }
    .health-pill.err { color: #991b1b; background: #fee2e2; border-color: #fecaca; }
    .metric-strip {
      display: flex;
      gap: 8px;
      overflow-x: auto;
      padding: 12px 18px 0;
    }
    .metric-pill {
      flex: 0 0 auto;
      min-width: 92px;
      padding: 10px 12px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.82);
      border: 1px solid #f7d3e1;
      box-shadow: 0 10px 22px rgba(157, 23, 77, 0.08);
    }
    .metric-pill strong { display: block; font-size: 18px; line-height: 1; }
    .metric-pill span { color: var(--muted); display: block; font-size: 11px; margin-top: 5px; }
    main {
      display: grid;
      grid-template-columns: minmax(280px, 340px) minmax(0, 1fr) minmax(280px, 340px);
      height: calc(100vh - 124px);
      padding: 18px;
      gap: 18px;
    }
    aside {
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.9);
      overflow: auto;
      border-radius: 18px;
      box-shadow: 0 18px 44px var(--shadow);
    }
    .sidebar-head {
      padding: 18px 18px 12px;
      border-bottom: 1px solid #f9d8e5;
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
      border-bottom: 1px solid #f9d8e5;
    }
    .stat {
      min-width: 0;
      padding: 10px;
      border-radius: 12px;
      background: var(--soft);
      border: 1px solid #f7d3e1;
    }
    .stat strong { display: block; font-size: 18px; line-height: 1; }
    .stat span { display: block; color: var(--muted); font-size: 11px; margin-top: 5px; }
    .diagnostics-card {
      margin: 0 14px 14px;
      padding: 12px;
      border: 1px solid #f7d3e1;
      border-radius: 14px;
      background: #fffafd;
    }
    .diagnostics-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    .diagnostics-head strong { font-size: 13px; }
    .diagnostics-grid {
      display: grid;
      gap: 7px;
    }
    .diagnostic-row {
      display: grid;
      grid-template-columns: 10px minmax(0, 82px) minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      font-size: 12px;
      color: #5f3046;
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
      padding: 14px 16px;
      color: inherit;
      text-decoration: none;
      border-bottom: 1px solid #f9d8e5;
      transition: background 0.15s ease, transform 0.15s ease;
    }
    .thread:hover {
      background: #fff0f6;
    }
    .thread.active {
      background: #fce7f3;
      border-left: 4px solid var(--brand);
      padding-left: 12px;
    }
    .avatar {
      flex: 0 0 auto;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #ffffff;
      background: linear-gradient(135deg, #be185d, #f472b6);
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
      background: #fff1f6;
      border: 1px solid #f7d3e1;
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
    .tools {
      display: grid;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid #f9d8e5;
    }
    .quick-filters {
      display: flex;
      gap: 7px;
      overflow-x: auto;
      padding: 0 14px 12px;
      border-bottom: 1px solid #f9d8e5;
    }
    .filter-chip {
      flex: 0 0 auto;
      color: #9d174d;
      background: #fff7fb;
      border: 1px solid #f7d3e1;
      border-radius: 999px;
      padding: 7px 10px;
      font-size: 12px;
      font-weight: 800;
      text-decoration: none;
    }
    .filter-chip.active {
      color: #ffffff;
      background: linear-gradient(135deg, #db2777, #f472b6);
      border-color: transparent;
    }
    .tools input, .tools select, textarea {
      width: 100%;
      border: 1px solid #f1b9cf;
      border-radius: 12px;
      padding: 10px 11px;
      font: inherit;
      background: #ffffff;
    }
    .tools input:focus, .tools select:focus, textarea:focus {
      border-color: var(--brand);
      box-shadow: 0 0 0 4px rgba(219, 39, 119, 0.12);
      outline: none;
    }
    .tool-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    button, .button-link {
      border: 0;
      border-radius: 12px;
      padding: 10px 12px;
      background: linear-gradient(135deg, var(--brand), #f472b6);
      color: #ffffff;
      font: inherit;
      font-weight: 800;
      text-decoration: none;
      cursor: pointer;
      box-shadow: 0 10px 18px rgba(219, 39, 119, 0.16);
      transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
    }
    button:hover, .button-link:hover {
      transform: translateY(-1px);
      box-shadow: 0 14px 24px rgba(219, 39, 119, 0.2);
    }
    button:disabled {
      cursor: wait;
      opacity: 0.72;
      transform: none;
    }
    .button-secondary { background: #7c2d52; }
    .button-danger { background: linear-gradient(135deg, #be123c, #f43f5e); }
    .mobile-back { display: none; }
    .chat {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.86);
      border-radius: 18px;
      box-shadow: 0 18px 48px var(--shadow);
    }
    .patient-panel {
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.92);
      overflow: auto;
      border-radius: 18px;
      box-shadow: 0 18px 44px var(--shadow);
    }
    .panel-section {
      padding: 16px;
      border-bottom: 1px solid #f9d8e5;
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
    .info-row {
      display: grid;
      gap: 3px;
      padding: 9px 10px;
      border: 1px solid #f7d3e1;
      border-radius: 12px;
      background: #fff7fb;
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
      background: #fff7fb;
      border: 1px solid #f7d3e1;
    }
    .notes-list {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .note-card {
      padding: 10px;
      border-radius: 12px;
      background: #fff7fb;
      border: 1px solid #f7d3e1;
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .note-card small {
      color: var(--muted);
      display: block;
      margin-bottom: 5px;
      font-size: 11px;
    }
    .chat-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 22px;
      background: rgba(255, 247, 251, 0.96);
      border-bottom: 1px solid var(--line);
    }
    .chat-title strong { display: block; font-size: 16px; }
    .chat-title span { color: var(--muted); font-size: 13px; }
    .chip {
      flex: 0 0 auto;
      color: var(--brand-dark);
      background: #fce7f3;
      border: 1px solid #f9a8d4;
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
    .appointment-card {
      margin: 18px 24px 0;
      padding: 14px 16px;
      border-radius: 14px;
      background: #fff1f6;
      border: 1px solid #f9a8d4;
      color: #831843;
    }
    .appointment-card strong {
      display: block;
      margin-bottom: 8px;
      font-size: 14px;
    }
    .appointment-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 14px;
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
      padding: 24px;
      overflow: auto;
      background:
        linear-gradient(rgba(255, 247, 251, 0.88), rgba(255, 247, 251, 0.88)),
        radial-gradient(circle, rgba(219, 39, 119, 0.08) 1px, transparent 1px);
      background-size: auto, 18px 18px;
      flex: 1;
    }
    .message {
      display: flex;
      margin-bottom: 14px;
    }
    .message.bot { justify-content: flex-end; }
    .bubble {
      max-width: min(720px, 86%);
      padding: 11px 13px 10px;
      border-radius: 16px 16px 16px 4px;
      background: var(--surface);
      box-shadow: 0 8px 22px rgba(157, 23, 77, 0.08);
      line-height: 1.45;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .bot .bubble {
      color: #831843;
      background: #fce7f3;
      border-radius: 16px 16px 4px 16px;
    }
    .human { justify-content: flex-end; }
    .human .bubble {
      color: #ffffff;
      background: linear-gradient(135deg, #be185d, #ec4899);
      border-radius: 16px 16px 4px 16px;
    }
    .human .meta { color: rgba(255, 255, 255, 0.78); }
    .meta {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .body { font-size: 14px; }
    .attachment-card {
      display: grid;
      gap: 2px;
      margin-top: 10px;
      padding: 10px 11px;
      border: 1px solid rgba(219, 39, 119, 0.18);
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
      background: rgba(255, 247, 251, 0.98);
      padding: 14px;
    }
    .composer form { display: grid; gap: 10px; }
    .message-input-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: stretch;
    }
    .message-input-row textarea {
      min-height: 58px;
      max-height: 150px;
      resize: vertical;
      border-radius: 16px;
      background: #ffffff;
    }
    .send-button {
      min-width: 118px;
      border-radius: 16px;
      font-size: 15px;
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
      background: #fff1f6;
      color: #9d174d;
      border: 1px solid #f9a8d4;
      padding: 8px 10px;
      font-size: 12px;
    }
    .file-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 6px;
      color: #8a5c6e;
      font-size: 13px;
      font-weight: 700;
    }
    .file-row input {
      border: 1px dashed #f0a3c2;
      border-radius: 10px;
      padding: 10px;
      background: #fffafd;
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
    @media (max-width: 780px) {
      body { min-height: 100dvh; overflow: hidden; }
      header { padding: 0 14px; height: 64px; min-height: 64px; gap: 12px; }
      .brand-mark { width: 34px; height: 34px; border-radius: 10px; }
      h1 { font-size: 16px; }
      .status { display: none; }
      .metric-strip { display: none; }
      main { display: block; height: calc(100dvh - 64px); min-height: 0; padding: 0; }
      body.has-selection aside { display: none; }
      body.no-selection .chat { display: none; }
      .patient-panel { display: none; }
      aside {
        height: calc(100dvh - 64px);
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
      .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); padding: 10px; }
      .tools {
        position: sticky;
        top: 63px;
        z-index: 2;
        background: rgba(255, 255, 255, 0.96);
      }
      .thread { padding: 13px 14px; }
      .thread.active { padding-left: 10px; }
      .chat {
        height: calc(100dvh - 64px);
        min-height: 0;
        border: 0;
        border-radius: 0;
        box-shadow: none;
      }
      .chat-title {
        padding: 12px 14px;
        align-items: flex-start;
        gap: 10px;
      }
      .chat-title > div:first-child { min-width: 0; }
      .chat-title span { display: block; margin-top: 3px; }
      .chat-actions { justify-content: flex-start; margin-top: 8px; }
      .mobile-back { display: inline-flex; }
      .conversation-tools {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .conversation-tools .button-link,
      .conversation-tools button {
        width: 100%;
        text-align: center;
        font-size: 12px;
        padding: 9px 8px;
      }
      .conversation-tools form { display: flex; min-width: 0; }
      .messages { padding: 12px; }
      .appointment-card { margin: 10px 12px 0; }
      .notice, .error-banner { margin: 10px 12px 0; }
      .appointment-grid { grid-template-columns: 1fr; }
      .bubble { max-width: 92%; }
      .composer {
        padding: 10px;
        padding-bottom: max(10px, env(safe-area-inset-bottom));
      }
      .composer form { gap: 8px; }
      .message-input-row {
        grid-template-columns: 1fr;
      }
      .send-button {
        width: 100%;
        min-height: 48px;
      }
      .quick-replies { margin: 0 -2px; padding: 0 2px 4px; }
      .quick-reply { font-size: 12px; padding: 7px 9px; }
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
<body class="${selected ? "has-selection" : "no-selection"}">
  <header>
    <div class="brand">
      <div class="brand-mark">Dra</div>
      <div>
        <h1>Inbox del bot</h1>
        <div class="subtitle">Conversaciones del consultorio</div>
      </div>
    </div>
    <div class="status">
      <span class="health-pill ok">${list.length} conversaciones</span>
      <span class="health-pill ok">${stats.confirmed} citas</span>
      <span class="health-pill ${stats.followup > 0 ? "warn" : "ok"}">${stats.followup} seguimiento</span>
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
  <main>
    <aside>
      <div class="sidebar-head">
        <strong>Pacientes</strong>
        <span>Ultimos mensajes recibidos</span>
      </div>
      <div class="stats">
        <div class="stat"><strong>${stats.total}</strong><span>Total</span></div>
        <div class="stat"><strong>${stats.confirmed}</strong><span>Agendadas</span></div>
        <div class="stat"><strong>${stats.followup}</strong><span>Seguimiento</span></div>
        <div class="stat"><strong>${stats.human}</strong><span>Humano</span></div>
        <div class="stat"><strong>${stats.urgent}</strong><span>Urgentes</span></div>
        <div class="stat"><strong>${stats.noReply}</strong><span>No respondio</span></div>
      </div>
      ${diagnosticsCard}
      <form class="tools" method="get" action="/inbox">
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
          </select>
          <button type="submit">Filtrar</button>
        </div>
      </form>
      ${filterOptions}
      ${conversationLinks}
    </aside>
    <section class="chat">
      <div class="chat-title">
        <div>
          <strong>${selected ? escapeHtml(selectedName) : "Sin conversacion seleccionada"}</strong>
          <span>${selected ? `${formatPhoneForInbox(selected.phoneNumber)} · Ultima actividad: ${formatInboxDate(selected.updatedAt)}` : "Cuando llegue un mensaje aparecera aqui."}</span>
          ${
            selected
              ? `<div class="conversation-tools">
                  <a class="mobile-back button-link button-secondary" href="/inbox?${buildInboxQuery({ q: url.searchParams.get("q"), filter })}">← Pacientes</a>
                  <a class="button-link button-secondary" href="/inbox?${buildInboxQuery({ q: url.searchParams.get("q"), filter })}">Cerrar conversacion</a>
                  <a class="button-link button-secondary" href="https://wa.me/${encodeURIComponent(selectedPhone)}" target="_blank" rel="noreferrer">Abrir WhatsApp</a>
                  <button type="button" class="button-secondary" data-copy-phone="${escapeHtml(selectedPhone)}">Copiar telefono</button>
                  ${
                    selected.botPaused
                      ? `<form method="post" action="/inbox/release"><input name="csrf" type="hidden" value="${escapeHtml(csrf)}"><input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}"><button type="submit">Devolver al bot</button></form>`
                      : `<form method="post" action="/inbox/takeover"><input name="csrf" type="hidden" value="${escapeHtml(csrf)}"><input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}"><button class="button-danger" type="submit">Tomar conversacion</button></form>`
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
      ${inboxError ? `<div class="error-banner">${escapeHtml(inboxError)}</div>` : ""}
      ${selected?.botPaused ? `<div class="notice">Modo humano activo: el bot guarda mensajes entrantes, pero no responde automaticamente a este paciente.</div>` : ""}
      ${needsTemplateNotice ? `<div class="notice">La ultima interaccion del paciente fue hace mas de 24 horas. Puede requerir plantilla aprobada de WhatsApp para responder fuera de la ventana de atencion.</div>` : ""}
      ${appointmentCard}
      <div class="messages">${messages}</div>
      ${
        selected
          ? `<div class="composer">
              <form method="post" action="/inbox/send" enctype="multipart/form-data">
                <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                ${quickReplies}
                <div class="message-input-row">
                  <textarea name="message" rows="3" maxlength="2000" placeholder="Escribe una respuesta como humano..."></textarea>
                  <button class="send-button" type="submit">Enviar</button>
                </div>
                <label class="file-row">
                  <span>Adjuntar foto, PDF, archivo o video</span>
                  <input name="attachment" type="file" accept="image/*,video/mp4,video/3gpp,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv">
                </label>
                <div class="composer-actions">
                  <span class="subtitle">Se enviara por WhatsApp y se guardara como Humano. Max ${formatFileSize(config.inboxMediaMaxBytes)} por archivo.</span>
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

function renderInboxDiagnostics(diagnostics) {
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
  </div>`;
}

function renderInboxQuickFilters(current, query = "") {
  const filters = [
    ["all", "Todas"],
    ["priority", "Prioridad"],
    ["urgent", "Urgentes"],
    ["misunderstood", "Bot no entendio"],
    ["awaiting_confirmation", "Por confirmar"],
    ["reschedule", "Reagendar"],
    ["cancel", "Cancelar"],
    ["closing_window", "24h"],
    ["followup", "Sin responder"],
    ["stuck", "Atoradas"],
    ["waiting", "Esperando datos"],
    ["confirmed", "Agendadas"],
    ["human", "Humano"]
  ];

  return `<div class="quick-filters">
    ${filters
      .map(([value, label]) => `<a class="filter-chip${value === current ? " active" : ""}" href="/inbox?${buildInboxQuery({ q: query, filter: value })}">${escapeHtml(label)}</a>`)
      .join("")}
  </div>`;
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
    ["Pedir nombre", "Perfecto 😊 ¿A nombre de quien agendamos la cita?"],
    ["Pedir fecha", "Claro 😊 ¿Que dia te gustaria revisar disponibilidad? Puedes decirme hoy, manana, viernes o una fecha especifica."],
    ["Horarios", "🕒 Claro. ¿Para que dia te gustaria revisar disponibilidad?\n\nPuedes decirme: hoy, mañana, viernes o una fecha especifica."],
    ["Ubicacion", getIntentResponse("location")],
    ["Costos", `${getIntentResponse("cost")}\n\n${getIntentResponse("promotion")}`],
    ["Pago", getIntentResponse("payment_methods")],
    ["Confirmar cita", "✅ Tu cita queda confirmada. Te esperamos en el consultorio. Si necesitas cambiar algo, escribenos por aqui."],
    ["Reagendar", "Claro 😊 Te ayudo a reagendar. ¿Que dia te gustaria revisar para el nuevo horario?"],
    ["Cancelar", "Para cancelar tu cita, confirmame por favor: ¿seguro que deseas cancelarla?"],
    ["Retomar cita", "Hola 😊 ¿Quieres que sigamos con tu cita? Puedo ayudarte a elegir fecha, horario o pasarte con una persona."],
    ["Humano", "Claro 😊 Una persona del consultorio revisara tu mensaje y te apoyara por aqui."],
    ["Requisitos", getIntentResponse("appointment_requirements")],
    ["Urgencias", "⚠️ Si tienes dolor intenso, sangrado abundante o una urgencia, por favor acude a urgencias o contacta directamente al consultorio."]
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
  return `<div class="appointment-card">
    <strong>✅ Cita registrada</strong>
    <div class="appointment-grid">
      <div><span>Paciente</span>${escapeHtml(appointment.patientName ?? "Sin nombre")}</div>
      <div><span>Fecha</span>${escapeHtml(formatAppointmentFull(appointment.slotStart))}</div>
      <div><span>Correo</span>${escapeHtml(appointment.patientEmail ?? "No capturado")}</div>
      <div><span>Tipo</span>${escapeHtml(appointment.paymentType ?? "No capturado")}</div>
      <div><span>Primera vez</span>${escapeHtml(appointment.firstVisit ?? "No capturado")}</div>
      <div><span>Estado</span>${escapeHtml(appointment.status ?? "confirmed")}</div>
    </div>
  </div>`;
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
    const messageText = extractWhatsAppMessageText(message);
    if (!messageText) continue;
    if (!checkPhoneRateLimit(message.from)) {
      console.warn(`Phone rate limit exceeded for ${maskPhone(message.from)}`);
      continue;
    }
    if (await alreadyProcessed(message.id, message.from)) continue;

    try {
      await handleIncomingText(message.from, messageText);
    } catch (error) {
      logSafeError(`Failed handling WhatsApp message ${message.id ?? "without-id"} from ${maskPhone(message.from)}`, error);
      await safeSendWhatsAppText(
        message.from,
        "🙏 Perdon, tuve un problema revisando la agenda. Por favor intenta de nuevo en un momento o escribe directamente al consultorio."
      );
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
  if (message.type === "text") return message.text?.body;
  if (message.type === "interactive") {
    const reply = message.interactive?.list_reply ?? message.interactive?.button_reply;
    return slotOptionReplyText(reply?.id) ?? dateOptionReplyText(reply?.id) ?? interactiveReplyMap[reply?.id] ?? reply?.title;
  }
  if (message.type === "button") {
    return interactiveReplyMap[message.button?.payload] ?? message.button?.text;
  }
  return undefined;
}

async function handleIncomingText(from, text) {
  console.log(`Incoming WhatsApp from ${maskPhone(from)}`);
  const lower = text.trim().toLowerCase();
  const normalized = normalizeText(text);
  const detectedIntent = detectIntent(normalized);
  await recordConversationMessage(from, "patient", text);
  await addConversationTags(from, suggestTagsFromText(normalized, detectedIntent.intent));
  await notifyIncomingPatientMessage(from, text);

  const conversationState = (await getConversationState(from)) ?? conversations.get(from);
  if (conversationState?.botPaused) {
    if (isHumanPauseExpired(conversationState)) {
      await setConversationHumanMode(from, false);
      setMemoryHumanMode(from, false);
      console.log(`Bot pause expired for ${maskPhone(from)}; auto-released conversation.`);
    } else {
      console.log(`Bot paused for ${maskPhone(from)}; message stored without auto-reply.`);
      return;
    }
  }

  const existing = await getPatientSession(from);

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

  if (detectedIntent.intent === "medical_urgent") {
    setMemoryTags(from, suggestTagsFromText(normalized, detectedIntent.intent));
    await replyToPatient(from, getIntentResponse("medical_urgent"));
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
    await replyToPatient(from, getIntentResponse("late_arrival"));
    return;
  }

  if (detectedIntent.intent === "direct_contact") {
    await setConversationHumanMode(from, true, "patient_request");
    setMemoryHumanMode(from, true);
    await replyToPatient(from, getIntentResponse("direct_contact"));
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
    await replyToPatient(from, faqAnswer);
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
    await replyToPatient(from, getIntentResponse("fallback"));
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
  const session = {
    from,
    step: existing?.step ?? "collecting",
    name: parsed.name ?? existing?.name,
    email: parsed.email ?? existing?.email,
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
          step: "collecting",
          availabilityOnly: false,
          pendingSlot: slot,
          pendingSlotSelectedIndex: parsed.selectedSlotIndex
        }, returningProfile);
        await setPatientSession(from, updated);
        await replyToPatient(
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
      await replyToPatient(from, buildReturningAppointmentPrompt(returningProfile));
      return;
    }
    await setPatientSession(from, session);
    await replyToPatient(from, "😊 Claro, te ayudo a agendar. ¿Me compartes tu nombre completo?");
    return;
  }

  if (!session.email) {
    await setPatientSession(from, { ...session, step: "collectingEmail" });
    await replyToPatient(from, `📩 Gracias, ${session.name}. ¿Me compartes tu correo electronico para enviarte la confirmacion de Google Calendar?`);
    return;
  }

  if (!session.firstVisit) {
    await setPatientSession(from, { ...session, step: "collectingFirstVisit" });
    await replyToPatient(from, "📝 ¿Es tu primera vez con nosotros? Responde si o no.");
    return;
  }

  if (!session.reason) {
    await setPatientSession(from, { ...session, step: "collectingService" });
    await replyToPatient(
      from,
      "Gracias 😊 ¿Que servicio o motivo general quieres agendar?\n\nPuedes responder: consulta, ultrasonido, papanicolaou, colposcopia, control prenatal u otro motivo general."
    );
    return;
  }

  if (!session.paymentType) {
    await setPatientSession(from, { ...session, step: "collectingPaymentType" });
    await replyToPatient(from, "💳 ¿Tu consulta es particular o por parte de alguna red medica/aseguradora?");
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

  try {
    await replyToPatient(from, buildPatientConfirmationMessage({ name, slot, email: session.email }));
  } catch (error) {
    logSafeError(`Could not send confirmed appointment message to ${maskPhone(from)}`, error);
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

function buildAvailabilityIntro(session, slots) {
  const requestedDateISO = session.preferredDateISO;
  const requestedDate = requestedDateISO ? dateOnlyFromISO(requestedDateISO) : undefined;
  const firstSlotDate = slots[0]?.start ? zonedDateOnly(slots[0].start) : undefined;

  if (requestedDate && firstSlotDate && requestedDate !== firstSlotDate) {
    const requestedLabel = formatDateOnlyFull(requestedDateISO);
    if (!isClinicWorkDate(requestedDateISO)) {
      return `📅 No, el ${requestedLabel} no trabajamos. Por el momento atendemos de lunes a viernes de 4:40 p.m. a 8:00 p.m.\n\nTe comparto opciones cercanas:`;
    }
    return `📅 Para el ${requestedLabel} ya no encontre espacios libres.\n\nTe comparto opciones cercanas:`;
  }

  return "🕒 Tengo estos horarios disponibles:";
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

async function handleMenuOption(from, text, intent = detectIntent(text).intent) {
  const option = menuOptionNumber(text);
  if (option === 1 || intent === "schedule_appointment" || intent === "new_patient") {
    await startAppointmentFlow(from);
    return true;
  }

  if (option === 2 || intent === "check_availability") {
    await setPatientSession(from, { from, step: "collectingDateOnly", availabilityOnly: true });
    await replyWithDateOptions(from, getIntentResponse("check_availability"));
    return true;
  }

  if (option === 3 || intent === "location") {
    await replyToPatient(from, getIntentResponse("location"));
    return true;
  }

  if (option === 4 || intent === "cost" || intent === "promotion") {
    await replyToPatient(from, `${getIntentResponse("cost")}\n\n${getIntentResponse("promotion")}`);
    return true;
  }

  if (option === 5 || intent === "payment_methods") {
    await replyToPatient(from, getIntentResponse("payment_methods"));
    return true;
  }

  if (option === 6 || intent === "medical_services") {
    await replyToPatient(from, getIntentResponse("medical_services"));
    return true;
  }

  if (option === 7 || intent === "direct_contact") {
    await setConversationHumanMode(from, true, "patient_request");
    setMemoryHumanMode(from, true);
    await replyToPatient(from, getIntentResponse("direct_contact"));
    return true;
  }

  return false;
}

function menuOptionNumber(text) {
  const normalized = normalizeText(text);
  const words = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7 };
  if (/^[1-7]$/.test(normalized)) return Number(normalized);
  return words[normalized];
}

async function replyToPatient(to, body) {
  await sendWhatsAppText(to, body);
  await recordConversationMessage(to, "bot", body);
  await notifyBotReply(to, body);
}

async function sendMainMenuToPatient(to) {
  const body = "Hola 😊 Soy el asistente virtual del consultorio.\n\nPuedo ayudarte a agendar, revisar horarios, ubicacion, costos, formas de pago, servicios o pasarte con una persona.\n\nElige una opcion:";
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
      `${body}\n\nPuedes escribirme: "agendar otra cita", "tengo cita", "reagendar", "cancelar", "ubicacion" o "humano".`
    );
  }
}

async function replyWithDateOptions(to, body) {
  const rows = buildDateOptionRows();
  try {
    await sendWhatsAppList(to, {
      body,
      buttonText: "Ver fechas",
      sections: [{ title: "Fechas sugeridas", rows }]
    });
    await recordConversationMessage(to, "bot", `${body}\n\n${rows.map((row, index) => `${index + 1}. ${row.title} - ${row.description}`).join("\n")}\n\nTambien puedes escribir otra fecha.`);
    await notifyBotReply(to, "Opciones de fecha enviadas.");
  } catch (error) {
    logSafeError(`Failed sending date options to ${maskPhone(to)}`, error);
    await replyToPatient(to, `${body}\n\n${rows.map((row, index) => `${index + 1}. ${row.title} - ${row.description}`).join("\n")}\n\nTambien puedes escribir otra fecha.`);
  }
}

async function replyWithSlotOptions(to, { body, slots, allowSelection }) {
  const rows = buildSlotOptionRows(slots);
  const instruction = allowSelection
    ? "Toca el boton para elegir un horario. Si ninguno te acomoda, dime otra fecha."
    : "Toca el boton si algun horario te acomoda y te ayudo a agendarlo. Si no, dime otra fecha.";
  const fallbackText = buildSlotOptionsText(body, slots, allowSelection);

  try {
    await sendWhatsAppList(to, {
      body: `${body}\n\n${instruction}`,
      buttonText: "Elegir horario",
      sections: [{ title: "Horarios disponibles", rows }]
    });
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

async function startAppointmentFlow(from) {
  const profile = await loadReturningPatientProfile(from);
  if (profile?.patientName) {
    const session = applyReturningProfile({ from, step: "collecting" }, profile);
    await setPatientSession(from, session);
    await replyToPatient(from, buildReturningAppointmentPrompt(profile));
    return;
  }

  await setPatientSession(from, { from, step: "collecting" });
  await replyToPatient(from, getIntentResponse("schedule_appointment"));
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
    profile.patientEmail ? `Correo: ${profile.patientEmail}` : undefined,
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
    profile.patientEmail ? `Correo: ${profile.patientEmail}` : undefined,
    "",
    "¿Que servicio o motivo general quieres agendar esta vez?"
  ];
  return lines.filter(Boolean).join("\n");
}

function buildReturningPatientDataSummary(profile) {
  const lines = [
    "Ya tengo estos datos guardados:",
    `Nombre: ${profile.patientName}`,
    profile.patientEmail ? `Correo: ${profile.patientEmail}` : undefined
  ];
  return lines.filter(Boolean).join("\n");
}

function firstName(value) {
  return String(value ?? "Paciente").trim().split(/\s+/)[0] || "Paciente";
}

async function replyWithAppointmentReview(to, body) {
  await replyToPatientWithButtons(to, body, [
    { id: "appointment_confirm_yes", title: "Si, agendar" },
    { id: "appointment_change_time", title: "Cambiar horario" },
    { id: "appointment_cancel_review", title: "Cancelar" }
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
  if (intent === "reschedule_appointment") tags.push("Reagendar");
  if (intent === "cancel_appointment") tags.push("Cancelar");
  if (/embarazo|prenatal/.test(text)) tags.push("Embarazo", "Control prenatal");
  if (/ultrasonido/.test(text)) tags.push("Ultrasonido");
  if (/papanicolaou|papanicolau|papanicolao/.test(text)) tags.push("Papanicolau");
  if (/colposcopia/.test(text)) tags.push("Colposcopia");
  if (/primera vez|paciente nueva/.test(text)) tags.push("Primera vez", "Nueva paciente");
  return tags;
}

function isHumanPauseExpired(conversationState) {
  if (!config.botPauseTimeoutMinutes || config.botPauseTimeoutMinutes <= 0) return false;
  if (!conversationState.botPausedAt) return false;
  return Date.now() - new Date(conversationState.botPausedAt).getTime() > config.botPauseTimeoutMinutes * 60_000;
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

  try {
    await cancelAppointment(session.cancellationGoogleEventId);
    await cancelCita(session.cancellationCitaId);
    await deletePatientSession(from);
    await replyToPatient(from, "✅ Listo, tu cita fue cancelada. Si quieres, puedo ayudarte a reagendar.");
    await safeSendWhatsAppText(
      config.doctorWhatsappNumber,
      `🛑 Cita cancelada por WhatsApp:\nPaciente: ${session.cancellationPatientName ?? "Paciente"}\nFecha: ${formatAppointmentFull(session.cancellationSlotStart)}\nTelefono: ${from}`
    );
    await notifyWaitlistForCancelledSlot(session.cancellationSlotStart);
  } catch (error) {
    logSafeError("Could not cancel appointment", error);
    await replyToPatient(
      from,
      "No pude cancelar la cita automaticamente. Por favor contacta directamente al consultorio para confirmar la cancelacion."
    );
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
      "3. 📍 Ubicacion",
      "4. 💰 Costos",
      "5. 💵 Formas de pago",
      "6. 🩺 Servicios",
      "7. 👩‍💼 Hablar con una persona",
      "",
      "¿Que necesitas?"
    ].join("\n"),
    location: buildLocationMessage(),
    morning_hours: "🌙 No atendemos por la manana. Solo por la tarde, de 4:40 p.m. a 8:00 p.m.\n\n¿Quieres que revise horarios por la tarde?",
    saturday: "📅 No atendemos los sabados ni domingos. Solo de lunes a viernes por la tarde.\n\n¿Quieres que revise disponibilidad entre semana?",
    cost: `💰 La consulta tiene un costo de ${formatMoney(config.consultationPrice)} MXN.\n\n🎁 Tambien contamos con paquete de promocion en ${formatMoney(config.promotionPrice)} MXN.`,
    promotion: `🎁 Si, aun contamos con paquete de promocion en ${formatMoney(config.promotionPrice)} MXN.\n\nSi gustas, tambien puedo ayudarte a revisar horarios disponibles para agendar tu cita.`,
    payment_methods: "💵 Por el momento aceptamos efectivo o transferencia bancaria.\n\nNo contamos con pago con tarjeta por ahora.",
    schedule_appointment: "😊 Claro, te ayudo a agendar tu cita.\n\n¿Me compartes tu nombre completo?",
    check_availability: "🕒 Claro. ¿Para que dia te gustaria revisar disponibilidad?\n\nPuedes decirme, por ejemplo: hoy, manana, viernes o una fecha especifica.",
    closing: "😊 Con gusto. Si necesitas algo mas, aqui estoy para ayudarte.",
    appointment_duration: "⏱️ Las citas tienen una duracion aproximada de 40 minutos.",
    new_patient: "Claro 😊 Podemos ayudarte a agendar tu primera consulta.\n\n¿Me compartes tu nombre completo para iniciar el registro?",
    medical_services:
      "Estos temas los puede revisar el consultorio 😊\n\nPodemos orientarte sobre consulta, paquete de promocion, ultrasonido, papanicolaou, colposcopia, embarazo/control prenatal y pacientes adolescentes.\n\nPara confirmar si el servicio que necesitas aplica para tu caso, puedo ayudarte a agendar o pasarte con una persona del consultorio.",
    medical_urgent:
      "Por seguridad, lo mejor es que te valore directamente la doctora.\n\nSi presentas dolor fuerte, sangrado abundante, fiebre, desmayo, dificultad para respirar o una emergencia, acude a urgencias o llama a los servicios de emergencia de tu localidad.\n\nTambien puedo ayudarte a agendar una cita o pasarte con una persona del consultorio.",
    medication_question:
      "Por seguridad, no puedo indicar medicamentos ni tratamientos por este medio.\n\nLo mejor es que la doctora pueda valorarte en consulta para darte la indicacion adecuada.\n\nSi gustas, puedo ayudarte a revisar horarios disponibles para agendar una cita.",
    direct_contact:
      "Claro 😊 Ya dejo esta conversacion para que una persona del consultorio pueda revisarla.\n\nPuedes escribir tu duda por aqui. Si es una urgencia medica, acude a urgencias o llama a los servicios de emergencia de tu localidad.",
    appointment_requirements:
      "Para tu cita, te recomendamos llevar identificacion y, si tienes, estudios o recetas anteriores relacionados con tu consulta.\n\nSi es tu primera vez, tambien puedo ayudarte a iniciar el registro por aqui.",
    late_arrival:
      "Gracias por avisar 😊\n\nPor favor contacta directamente al consultorio para confirmar si aun es posible atenderte en tu horario o si es necesario reagendar.",
    invoice: "Para temas de factura, por favor consulta directamente con el consultorio para confirmar disponibilidad y requisitos.",
    fallback: [
      "Perdon, no entendi bien 😅",
      "",
      "¿Quieres agendar, ver costos, ubicacion o hablar con una persona?"
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
}

function isResetCommand(text) {
  return /^(?:menu|menú|reiniciar|empezar de nuevo|volver al menu|volver al menú)$/.test(text);
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
    "default-src 'self'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
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

function redirectInbox(res, phone, error) {
  const params = new URLSearchParams();
  if (phone) params.set("phone", phone);
  if (error) params.set("error", error);
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
