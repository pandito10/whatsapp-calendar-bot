import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { understandMessage } from "./ai.js";
import { cancelAppointment, createAppointment, findAvailableSlots, isSlotAvailable } from "./calendar.js";
import { config } from "./config.js";
import { redactSecrets } from "./http.js";
import {
  buildAdminAppointmentNotification,
  buildManualReviewMessage,
  buildPatientConfirmationMessage,
  classifyAppointmentError,
  validateSlotSelection
} from "./appointments.js";
import { buildOperationalHealth, isOperationallyUnhealthy } from "./health.js";
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
  loadDueReminders,
  loadConversations,
  markReminderFailed,
  markReminderSent,
  markConversationHumanReply,
  releaseAppointmentLock,
  rememberProcessedWhatsAppMessage,
  loadKnowledgeSuggestions,
  reviewKnowledgeSuggestion,
  saveCita,
  saveConversationMessage,
  saveKnowledgeSuggestion,
  scheduleReminder,
  setConversationHumanMode,
  setSession
} from "./db.js";
import { sendWhatsAppText } from "./whatsapp.js";

const sessions = new Map();
const processedMessages = new Map();
const processedMessageTtlMs = 24 * 60 * 60 * 1000;
const conversations = new Map();
const maxMessagesPerConversation = 100;
const rateLimitBuckets = new Map();
let appSecretWarningShown = false;
let isShuttingDown = false;

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
      const rawBody = await readRawBody(req);
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
      handleDebugConfig(req, url, res);
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

    if (req.method === "POST" && url.pathname === "/inbox/knowledge/review") {
      await handleKnowledgeReview(req, url, res);
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

function handleDebugConfig(req, url, res) {
  if (!hasInboxAccess(req, url, res)) {
    return;
  }

  res
    .writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
    .end(
      JSON.stringify({
        aiProvider: config.aiProvider,
        calendarId: config.googleCalendarId,
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
        databaseEnabled: isDatabaseEnabled()
      })
    );
}

async function handleInbox(req, url, res) {
  if (!hasInboxAccess(req, url, res, { redirectToLogin: true })) {
    return;
  }

  const selectedPhone = url.searchParams.get("phone");
  const list = await getInboxConversations();
  const selected = selectedPhone ? conversations.get(selectedPhone) : list[0];
  const knowledgeSuggestions = await loadKnowledgeSuggestions("pending", 8);

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderInboxPage(list, selected, req, url, knowledgeSuggestions));
}

async function handleInboxSend(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-send")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req);
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const phone = normalizePhone(form.get("phone") ?? "");
  const message = String(form.get("message") ?? "").trim();
  if (!isValidWhatsAppPhone(phone) || !message || message.length > 2000) {
    await redirectInbox(res, phone, "Mensaje invalido o telefono invalido.");
    return;
  }

  try {
    await sendWhatsAppText(phone, message);
    await recordConversationMessage(phone, "human", message, { source: "inbox" });
    await markConversationHumanReply(phone);
    await saveHumanKnowledgeSuggestion(phone, message);
    console.log(`Inbox human reply sent to ${maskPhone(phone)}`);
    await redirectInbox(res, phone);
  } catch (error) {
    logSafeError(`Could not send inbox reply to ${maskPhone(phone)}`, error);
    await redirectInbox(res, phone, "No se pudo enviar el mensaje por WhatsApp.");
  }
}

async function handleKnowledgeReview(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  const form = await readForm(req);
  if (!isValidCsrf(req, form.get("csrf"))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return;
  }

  const id = form.get("id");
  const status = form.get("status");
  if (!id || !["approved", "rejected"].includes(status)) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("invalid review");
    return;
  }

  await reviewKnowledgeSuggestion(id, status);
  await redirectInbox(res, form.get("phone") ?? "");
}

async function handleInboxTakeover(req, url, res) {
  if (!hasInboxAccess(req, url, res)) return;
  if (!checkRateLimit(req, url, "inbox-action")) {
    res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8" }).end("too many requests");
    return;
  }

  const form = await readForm(req);
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

  const form = await readForm(req);
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
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #eef3f8; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: linear-gradient(135deg, #f7fbff, #edf3f8); }
    main { width: min(420px, 100%); background: white; border: 1px solid #d9e2ec; border-radius: 14px; padding: 28px; box-shadow: 0 16px 40px rgba(23, 32, 51, 0.1); }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { margin: 0 0 20px; color: #66758a; line-height: 1.45; }
    label { display: block; font-weight: 700; font-size: 14px; margin-bottom: 8px; }
    input { width: 100%; border: 1px solid #cbd5e1; border-radius: 10px; padding: 12px; font: inherit; }
    button { width: 100%; margin-top: 14px; border: 0; border-radius: 10px; padding: 12px; background: #0f766e; color: white; font: inherit; font-weight: 800; cursor: pointer; }
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

  const params = await readForm(req);
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

function renderInboxPage(list, selected, req, url, knowledgeSuggestions = []) {
  const csrf = createSessionCsrfToken(req);
  const q = normalizeText(url.searchParams.get("q") ?? "");
  const filter = url.searchParams.get("filter") ?? "all";
  const filteredList = filterInboxConversations(list, q, filter);
  if (selected && !filteredList.some((conversation) => conversation.phoneNumber === selected.phoneNumber)) {
    filteredList.unshift(selected);
  }
  const stats = buildInboxStats(filteredList);
  const operationalStatus = renderOperationalStatusBadges();
  const selectedStatus = selected ? getConversationStatus(selected) : undefined;
  const selectedName = selected ? getConversationDisplayName(selected) : "";
  const appointmentCard = selected?.appointment ? renderAppointmentCard(selected.appointment) : "";
  const inboxError = url.searchParams.get("error");
  const selectedPhone = selected?.phoneNumber ?? "";
  const lastPatientMessage = selected?.messages ? [...selected.messages].reverse().find((message) => message.sender === "patient") : undefined;
  const needsTemplateNotice = lastPatientMessage ? Date.now() - new Date(lastPatientMessage.timestamp).getTime() > 24 * 60 * 60 * 1000 : false;
  const knowledgePanel = renderKnowledgePanel(knowledgeSuggestions, csrf, selectedPhone);
  const conversationLinks =
    filteredList.length === 0
      ? `<div class="empty-state">Todavia no hay conversaciones.</div>`
      : filteredList
          .map((conversation) => {
            const last = conversation.messages.at(-1);
            const active = selected?.phoneNumber === conversation.phoneNumber ? " active" : "";
            const status = getConversationStatus(conversation);
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
                  ${conversation.botPaused ? `<span class="tag human">Modo humano</span>` : ""}
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
          return `<div class="message ${side}">
            <div class="bubble">
              <div class="meta">${label} · ${formatInboxDate(message.timestamp)}</div>
              <div class="body">${escapeHtml(message.body).replaceAll("\n", "<br>")}</div>
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
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #eef3f8;
      color: #172033;
      --line: #d9e2ec;
      --muted: #66758a;
      --brand: #0f766e;
      --brand-dark: #115e59;
      --surface: #ffffff;
      --soft: #f6f9fc;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(15, 118, 110, 0.14), transparent 32rem),
        linear-gradient(135deg, #f7fbff 0%, #edf3f8 100%);
    }
    header {
      height: 72px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 28px;
      border-bottom: 1px solid rgba(217, 226, 236, 0.82);
      background: rgba(255, 255, 255, 0.86);
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
      background: var(--brand);
      color: #ffffff;
      font-weight: 800;
      box-shadow: 0 10px 24px rgba(15, 118, 110, 0.22);
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
      border: 1px solid #d6e2ee;
      background: #ffffff;
      color: #334155;
      box-shadow: 0 6px 14px rgba(15, 23, 42, 0.05);
    }
    .health-pill.ok { color: #166534; background: #dcfce7; border-color: #bbf7d0; }
    .health-pill.warn { color: #92400e; background: #fef3c7; border-color: #fde68a; }
    .health-pill.err { color: #991b1b; background: #fee2e2; border-color: #fecaca; }
    main {
      display: grid;
      grid-template-columns: minmax(300px, 360px) 1fr;
      height: calc(100vh - 72px);
      padding: 18px;
      gap: 18px;
    }
    aside {
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.92);
      overflow: auto;
      border-radius: 18px;
      box-shadow: 0 16px 40px rgba(23, 32, 51, 0.08);
    }
    .sidebar-head {
      padding: 18px 18px 12px;
      border-bottom: 1px solid #edf1f6;
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
      border-bottom: 1px solid #edf1f6;
    }
    .stat {
      min-width: 0;
      padding: 10px;
      border-radius: 12px;
      background: var(--soft);
      border: 1px solid #e7edf4;
    }
    .stat strong { display: block; font-size: 18px; line-height: 1; }
    .stat span { display: block; color: var(--muted); font-size: 11px; margin-top: 5px; }
    .thread {
      display: flex;
      gap: 12px;
      align-items: center;
      padding: 14px 16px;
      color: inherit;
      text-decoration: none;
      border-bottom: 1px solid #edf1f6;
      transition: background 0.15s ease, transform 0.15s ease;
    }
    .thread:hover {
      background: #f4faf8;
    }
    .thread.active {
      background: #e5f5f0;
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
      background: linear-gradient(135deg, #0f766e, #14b8a6);
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
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 999px;
      padding: 4px 8px;
      font-size: 11px;
      font-weight: 750;
    }
    .tag.confirmed { color: #166534; background: #dcfce7; border-color: #bbf7d0; }
    .tag.followup { color: #854d0e; background: #fef3c7; border-color: #fde68a; }
    .tag.open { color: #075985; background: #e0f2fe; border-color: #bae6fd; }
    .tag.human { color: #6d28d9; background: #ede9fe; border-color: #ddd6fe; }
    .tools {
      display: grid;
      gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid #edf1f6;
    }
    .tools input, .tools select, textarea {
      width: 100%;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 10px 11px;
      font: inherit;
      background: #ffffff;
    }
    .tool-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    button, .button-link {
      border: 0;
      border-radius: 10px;
      padding: 10px 12px;
      background: var(--brand);
      color: #ffffff;
      font: inherit;
      font-weight: 800;
      text-decoration: none;
      cursor: pointer;
    }
    .button-secondary { background: #334155; }
    .button-danger { background: #b45309; }
    .chat {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.82);
      border-radius: 18px;
      box-shadow: 0 16px 40px rgba(23, 32, 51, 0.08);
    }
    .chat-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 22px;
      background: rgba(255, 255, 255, 0.96);
      border-bottom: 1px solid var(--line);
    }
    .chat-title strong { display: block; font-size: 16px; }
    .chat-title span { color: var(--muted); font-size: 13px; }
    .chip {
      flex: 0 0 auto;
      color: var(--brand-dark);
      background: #e5f5f0;
      border: 1px solid #bce4dc;
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
      background: #ecfdf5;
      border: 1px solid #bbf7d0;
      color: #064e3b;
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
      color: #047857;
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
        linear-gradient(rgba(246, 249, 252, 0.86), rgba(246, 249, 252, 0.86)),
        radial-gradient(circle, rgba(15, 118, 110, 0.08) 1px, transparent 1px);
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
      box-shadow: 0 8px 22px rgba(23, 32, 51, 0.08);
      line-height: 1.45;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .bot .bubble {
      background: #d9fdd3;
      border-radius: 16px 16px 4px 16px;
    }
    .human { justify-content: flex-end; }
    .human .bubble {
      color: #3b0764;
      background: #f3e8ff;
      border-radius: 16px 16px 4px 16px;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .body { font-size: 14px; }
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
      background: rgba(255, 255, 255, 0.96);
      padding: 14px;
    }
    .composer form { display: grid; gap: 10px; }
    .composer-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
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
    .conversation-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
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
      header { padding: 0 16px; height: auto; min-height: 72px; gap: 12px; }
      .status { display: none; }
      main { grid-template-columns: 1fr; height: auto; min-height: calc(100vh - 72px); padding: 12px; }
      aside { max-height: 34vh; }
      .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .messages { padding: 16px; }
      .appointment-card { margin: 12px 16px 0; }
      .notice, .error-banner { margin: 12px 16px 0; }
      .appointment-grid { grid-template-columns: 1fr; }
      .chat { min-height: 58vh; }
      .bubble { max-width: 92%; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-mark">WA</div>
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
      </div>
      <form class="tools" method="get" action="/inbox">
        <input name="q" value="${escapeHtml(url.searchParams.get("q") ?? "")}" placeholder="Buscar telefono o nombre">
        <div class="tool-row">
          <select name="filter">
            ${renderFilterOption("all", "Todas", filter)}
            ${renderFilterOption("pending", "Pendientes", filter)}
            ${renderFilterOption("confirmed", "Cita agendada", filter)}
            ${renderFilterOption("human", "Modo humano", filter)}
          </select>
          <button type="submit">Filtrar</button>
        </div>
      </form>
      ${conversationLinks}
      ${knowledgePanel}
    </aside>
    <section class="chat">
      <div class="chat-title">
        <div>
          <strong>${selected ? escapeHtml(selectedName) : "Sin conversacion seleccionada"}</strong>
          <span>${selected ? `${formatPhoneForInbox(selected.phoneNumber)} · Ultima actividad: ${formatInboxDate(selected.updatedAt)}` : "Cuando llegue un mensaje aparecera aqui."}</span>
          ${
            selected
              ? `<div class="conversation-tools">
                  <a class="button-link button-secondary" href="https://wa.me/${encodeURIComponent(selectedPhone)}" target="_blank" rel="noreferrer">Abrir WhatsApp</a>
                  <button type="button" class="button-secondary" onclick="navigator.clipboard?.writeText('${escapeHtml(selectedPhone)}')">Copiar telefono</button>
                  ${
                    selected.botPaused
                      ? `<form method="post" action="/inbox/release"><input name="csrf" type="hidden" value="${escapeHtml(csrf)}"><input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}"><button type="submit">Devolver al bot</button></form>`
                      : `<form method="post" action="/inbox/takeover"><input name="csrf" type="hidden" value="${escapeHtml(csrf)}"><input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}"><button class="button-danger" type="submit">Tomar conversacion</button></form>`
                  }
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
              <form method="post" action="/inbox/send">
                <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                <textarea name="message" rows="3" maxlength="2000" placeholder="Escribe una respuesta como humano..." required></textarea>
                <div class="composer-actions">
                  <span class="subtitle">Se enviara por WhatsApp y se guardara como Humano.</span>
                  <button type="submit">Enviar respuesta</button>
                </div>
              </form>
            </div>`
          : ""
      }
    </section>
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

function buildInboxStats(list) {
  return list.reduce(
    (stats, conversation) => {
      const status = getConversationStatus(conversation);
      stats.total += 1;
      if (status.key === "confirmed") stats.confirmed += 1;
      if (status.key === "followup") stats.followup += 1;
      if (status.key === "open") stats.open += 1;
      return stats;
    },
    { total: 0, confirmed: 0, followup: 0, open: 0 }
  );
}

function renderKnowledgePanel(suggestions, csrf, selectedPhone) {
  const cards =
    suggestions.length === 0
      ? `<div class="empty-state">Sin respuestas pendientes por aprobar.</div>`
      : suggestions
          .map(
            (suggestion) => `<div class="knowledge-card">
              <p>${escapeHtml(suggestion.question ?? "Pregunta no capturada")}</p>
              <strong>${escapeHtml(suggestion.answer)}</strong>
              <div class="knowledge-actions">
                <form method="post" action="/inbox/knowledge/review">
                  <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                  <input name="id" type="hidden" value="${escapeHtml(suggestion.id)}">
                  <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                  <button name="status" value="approved" type="submit">Aprobar</button>
                </form>
                <form method="post" action="/inbox/knowledge/review">
                  <input name="csrf" type="hidden" value="${escapeHtml(csrf)}">
                  <input name="id" type="hidden" value="${escapeHtml(suggestion.id)}">
                  <input name="phone" type="hidden" value="${escapeHtml(selectedPhone)}">
                  <button class="button-secondary" name="status" value="rejected" type="submit">Rechazar</button>
                </form>
              </div>
            </div>`
          )
          .join("");

  return `<div class="knowledge">
    <h2>Aprendizaje supervisado</h2>
    ${cards}
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

function filterInboxConversations(list, q, filter) {
  return list.filter((conversation) => {
    const status = getConversationStatus(conversation);
    const name = normalizeText(getConversationDisplayName(conversation));
    const phone = normalizePhone(conversation.phoneNumber);
    const matchesQuery = !q || name.includes(q) || phone.includes(normalizePhone(q));
    const matchesFilter =
      filter === "all" ||
      (filter === "pending" && status.key === "followup") ||
      (filter === "confirmed" && status.key === "confirmed") ||
      (filter === "human" && conversation.botPaused);
    return matchesQuery && matchesFilter;
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

function getConversationStatus(conversation) {
  if (conversation.botPaused) {
    return { key: "human", label: "Modo humano activo", className: "human" };
  }

  if (conversation.appointment?.status === "confirmed") {
    return { key: "confirmed", label: "Cita agendada", className: "confirmed" };
  }

  const last = conversation.messages.at(-1);
  if (last?.sender === "patient") {
    return { key: "followup", label: "Responder / seguimiento", className: "followup" };
  }

  return { key: "open", label: "En atencion", className: "open" };
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
    if (message.type !== "text") continue;
    if (!checkPhoneRateLimit(message.from)) {
      console.warn(`Phone rate limit exceeded for ${maskPhone(message.from)}`);
      continue;
    }
    if (await alreadyProcessed(message.id, message.from)) continue;

    try {
      await handleIncomingText(message.from, message.text.body);
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

async function handleIncomingText(from, text) {
  console.log(`Incoming WhatsApp from ${maskPhone(from)}`);
  const lower = text.trim().toLowerCase();
  const normalized = normalizeText(text);
  const detectedIntent = detectIntent(normalized);
  await recordConversationMessage(from, "patient", text);
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

  if (detectedIntent.intent === "medical_urgent") {
    await replyToPatient(from, getIntentResponse("medical_urgent"));
    return;
  }

  if (detectedIntent.intent === "cancel_appointment") {
    await handleCancellationRequest(from);
    return;
  }

  if (isResetCommand(normalized)) {
    await deletePatientSession(from);
    await replyToPatient(from, answerFaq("hola"));
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

  if (detectedIntent.intent === "confirm_appointment") {
    await handleConfirmAppointmentRequest(from);
    return;
  }

  if (detectedIntent.intent === "closing") {
    await deletePatientSession(from);
    await replyToPatient(from, getIntentResponse("closing"));
    return;
  }

  if (from === config.doctorWhatsappNumber && /^(?:agenda|mi agenda|ver agenda)$/.test(lower)) {
    await replyToPatient(from, "📅 Por ahora te aviso cada cita nueva por aqui. El resumen diario lo agregamos en la siguiente version.");
    return;
  }

  const existing = await getPatientSession(from);
  const dateLikeRequest = looksLikeDateRequest(normalized);
  if (!existing && !dateLikeRequest) {
    const menuHandled = await handleMenuOption(from, normalized, detectedIntent.intent);
    if (menuHandled) return;
  }

  const faqAnswer = getIntentResponse(detectedIntent.intent) ?? answerFaq(normalized);
  if (faqAnswer && !existing && !dateLikeRequest) {
    await replyToPatient(from, faqAnswer);
    return;
  }

  if (!existing) {
    const learnedAnswer = await answerFromApprovedKnowledge(normalized);
    if (learnedAnswer) {
      await replyToPatient(from, learnedAnswer);
      return;
    }
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
    offeredSlots: existing?.offeredSlots,
    rescheduleFromCitaId: existing?.rescheduleFromCitaId,
    rescheduleFromGoogleEventId: existing?.rescheduleFromGoogleEventId,
    availabilityOnly: existing?.availabilityOnly ?? (!existing && parsed.intent === "check_availability")
  };

  if (session.step === "choosingSlot" && parsed.selectedSlotIndex) {
    const slot = session.offeredSlots?.[parsed.selectedSlotIndex - 1];
    const name = session.name ?? "Paciente";
    const slotValidation = validateSlotSelection({ slot, session, selectedSlotIndex: parsed.selectedSlotIndex });

    if (!slotValidation.ok) {
      await resetSlotSelection(from, session);
      await replyToPatient(from, "Ese horario ya no es valido. Dime que dia quieres revisar y te paso nuevos horarios disponibles.");
      return;
    }

    let lock;
    let event;
    try {
      lock = await lockAppointmentSlot(from, slot);
      if (lock === false) {
        await resetSlotSelection(from, session);
        await replyToPatient(
          from,
          "😕 Ese horario se acaba de apartar. Dime que dia te gustaria revisar y te paso nuevos horarios disponibles."
        );
        return;
      }

      const stillAvailable = await isSlotAvailable(slot);
      if (!stillAvailable) {
        await resetSlotSelection(from, session);
        await replyToPatient(
          from,
          "😕 Ese horario se acaba de ocupar. Dime que dia te gustaria revisar y te paso nuevos horarios disponibles."
        );
        return;
      }

      event = await createAppointment(slot, {
        name,
        phone: from,
        email: session.email,
        firstVisit: session.firstVisit,
        paymentType: session.paymentType,
        reason: config.includeSensitiveAppointmentNotes ? session.reason : undefined
      });

      const cita = await saveConfirmedCita(from, session, slot, event);
      await scheduleAppointmentReminder(from, session, slot, cita);
      await cancelPreviousRescheduledAppointment(session);
      await deletePatientSession(from);

      await replyToPatient(from, buildPatientConfirmationMessage({ name, slot, email: session.email }));
      await sendWhatsAppText(
        config.doctorWhatsappNumber,
        buildAdminAppointmentNotification({ name, from, slot, session })
      );
      return;
    } catch (error) {
      if (event?.id) {
        try {
          await cancelAppointment(event.id);
        } catch (cancelError) {
          logSafeError("Could not rollback Google Calendar event after appointment failure", cancelError);
        }
      }
      const failureType = classifyAppointmentError(error);
      logSafeError(`Could not confirm appointment for ${maskPhone(from)} [${failureType}]`, error);
      await resetSlotSelection(from, session);
      await replyToPatient(from, buildManualReviewMessage());
      await safeSendWhatsAppText(
        config.doctorWhatsappNumber,
        `⚠️ Error al confirmar cita por WhatsApp (${failureType}). Telefono: ${maskPhone(from)}. Revisa Calendar/Supabase antes de confirmar manualmente.`
      );
      return;
    } finally {
      if (lock && typeof lock === "object") await releaseAppointmentLock(lock.token);
    }
  }

  if (session.availabilityOnly && session.preferredDateText) {
    await offerAvailableSlots(from, session, { allowSelection: false });
    return;
  }

  if (!session.name) {
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

  if (!session.paymentType) {
    await setPatientSession(from, { ...session, step: "collectingPaymentType" });
    await replyToPatient(from, "💳 ¿Tu consulta es particular o por parte de alguna red medica/aseguradora?");
    return;
  }

  if (parsed.intent === "check_availability" && !session.preferredDateText) {
    await offerAvailableSlots(from, {
      ...session,
      preferredDateText: "hoy",
      preferredDateISO: todayISO()
    });
    return;
  }

  if (!session.preferredDateText) {
    await setPatientSession(from, session);
    await replyToPatient(from, `📅 Gracias, ${session.name}. ¿Que dia te gustaria la cita?`);
    return;
  }

  await offerAvailableSlots(from, session);
}

async function offerAvailableSlots(from, session, options = {}) {
  const allowSelection = options.allowSelection !== false;
  let slots;
  try {
    slots = await findAvailableSlots(session.preferredDateText, session.preferredDateISO);
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
    await setPatientSession(from, { ...session, preferredDateText: undefined });
    await replyToPatient(from, "😕 No encontre horarios disponibles en esos dias. ¿Quieres que revise otra fecha?");
    return;
  }

  await setPatientSession(from, allowSelection ? {
    ...session,
    step: "choosingSlot",
    offeredSlots: slots
  } : {
    ...session,
    step: "collectingDateOnly",
    offeredSlots: undefined
  });

  await replyToPatient(
    from,
    `🕒 Tengo estos horarios disponibles:\n${slots
      .map((slot, index) => `${index + 1}. ${slot.label}`)
      .join("\n")}\n\n${allowSelection ? "Responde con el numero del horario que prefieras para confirmar. Si ninguno te acomoda, dime otra fecha." : "Si alguno te acomoda, escribe \"quiero agendar\" y te ayudo a apartarlo. Si no, dime otra fecha."}`
  );
}

async function resetSlotSelection(from, session) {
  await setPatientSession(from, {
    ...session,
    step: "collecting",
    preferredDateText: undefined,
    preferredDateISO: undefined,
    offeredSlots: undefined
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
  if (/^1$/.test(text) || intent === "schedule_appointment" || intent === "new_patient") {
    await setPatientSession(from, { from, step: "collecting" });
    await replyToPatient(from, getIntentResponse("schedule_appointment"));
    return true;
  }

  if (/^2$/.test(text) || intent === "check_availability") {
    await setPatientSession(from, { from, step: "collectingDateOnly", availabilityOnly: true });
    await replyToPatient(from, getIntentResponse("check_availability"));
    return true;
  }

  if (/^3$/.test(text) || intent === "location") {
    await replyToPatient(from, getIntentResponse("location"));
    return true;
  }

  if (/^4$/.test(text) || intent === "cost" || intent === "promotion") {
    await replyToPatient(from, `${getIntentResponse("cost")}\n\n${getIntentResponse("promotion")}`);
    return true;
  }

  if (/^5$/.test(text) || intent === "payment_methods") {
    await replyToPatient(from, getIntentResponse("payment_methods"));
    return true;
  }

  return false;
}

async function replyToPatient(to, body) {
  await sendWhatsAppText(to, body);
  await recordConversationMessage(to, "bot", body);
  await notifyBotReply(to, body);
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

  if (!isDatabaseEnabled()) return;
  try {
    await setSession(phoneNumber, session);
  } catch (error) {
    logSafeError("Could not save session to Supabase", error);
  }
}

async function deletePatientSession(phoneNumber) {
  sessions.delete(phoneNumber);

  if (!isDatabaseEnabled()) return;
  try {
    await deleteSession(phoneNumber);
  } catch (error) {
    logSafeError("Could not delete session from Supabase", error);
  }
}

async function saveConfirmedCita(phoneNumber, session, slot, event) {
  const fallback = {
    id: undefined,
    phoneNumber,
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
    return saved;
  } catch (error) {
    logSafeError("Could not save cita to Supabase", error);
    throw new Error("Could not persist confirmed appointment");
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

  try {
    await cancelAppointment(cita.googleEventId);
    await cancelCita(cita.id);
    await deletePatientSession(from);
    await replyToPatient(from, `✅ Listo, cancele tu cita del ${formatAppointmentFull(cita.slotStart)}.`);
    await safeSendWhatsAppText(
      config.doctorWhatsappNumber,
      `🛑 Cita cancelada por WhatsApp:\nPaciente: ${cita.patientName ?? "Paciente"}\nFecha: ${formatAppointmentFull(cita.slotStart)}\nTelefono: ${from}`
    );
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
    step: "collecting",
    name: cita.patientName,
    email: cita.patientEmail,
    rescheduleFromCitaId: cita.id,
    rescheduleFromGoogleEventId: cita.googleEventId
  });
  await replyToPatient(from, "Claro 😊 Te ayudo a revisar disponibilidad para reagendar.\n\n¿Me indicas que dia te gustaria revisar?");
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
    `✅ Tu cita queda confirmada para el dia ${formatAppointmentFull(cita.slotStart)}.\n\nTe esperamos en Plaza de la Paz #20, 2o. Piso, Consultorio 14, Guanajuato, Gto.`
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
  const remindAt = new Date(new Date(slot.start).getTime() - 24 * 60 * 60 * 1000);
  if (remindAt <= new Date()) return;

  try {
    await scheduleReminder({
      citaId: cita?.id,
      phoneNumber: config.doctorWhatsappNumber,
      reminderType: "admin_24h",
      remindAt: remindAt.toISOString(),
      payload: {
        patientPhone: phoneNumber,
        patientName: session.name,
        slotLabel: slot.label,
        slotStart: slot.start
      }
    });
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
  }
}

function answerFaq(text) {
  return getIntentResponse(detectIntent(text).intent);
}

function getIntentResponse(intent) {
  const responses = {
    greeting: [
      "Hola 😊 ¿En que te puedo ayudar?",
      "",
      "Puedo apoyarte con:",
      "1. 📅 Agendar una cita",
      "2. 🕒 Ver horarios disponibles",
      "3. 📍 Ubicacion",
      "4. 💰 Costos y promocion",
      "5. 💵 Formas de pago",
      "",
      "Puedes escribirme, por ejemplo: \"quiero agendar\" o \"que citas tienes disponibles\"."
    ].join("\n"),
    location: "📍 Estamos ubicados en Plaza de la Paz #20, 2o. Piso, Consultorio 14, Guanajuato, Gto.",
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
      "Puedo ayudarte a revisar la informacion del paquete o de la consulta 😊\n\nPara darte la informacion correcta, por favor contacta directamente al consultorio o indica que estudio necesitas revisar.",
    medical_urgent:
      "Lamento que estes pasando por eso.\n\nSi presentas dolor fuerte, sangrado abundante, fiebre, desmayo, dificultad para respirar o una urgencia medica, por favor acude de inmediato a urgencias o llama a los servicios de emergencia de tu localidad.\n\nPor este medio puedo ayudarte con informacion general o con agendar una cita, pero no sustituye una valoracion medica urgente.",
    medication_question:
      "Por seguridad, no puedo indicar medicamentos ni tratamientos por este medio.\n\nLo mejor es que la doctora pueda valorarte en consulta para darte la indicacion adecuada.\n\nSi gustas, puedo ayudarte a revisar horarios disponibles para agendar una cita.",
    direct_contact:
      "Claro 😊 Puedes dejarme tu mensaje por aqui y el consultorio te apoyara lo antes posible.\n\nSi es algo urgente, por favor acude a urgencias o llama a los servicios de emergencia de tu localidad.",
    appointment_requirements:
      "Para tu cita, te recomendamos llevar identificacion y, si tienes, estudios o recetas anteriores relacionados con tu consulta.",
    late_arrival:
      "Gracias por avisar 😊\n\nPor favor contacta directamente al consultorio para confirmar si aun es posible atenderte en tu horario o si es necesario reagendar.",
    invoice: "Para temas de factura, por favor consulta directamente con el consultorio para confirmar disponibilidad y requisitos.",
    fallback: [
      "Perdon 😊 No logre entender bien tu mensaje.",
      "",
      "Puedo ayudarte con:",
      "1. 📅 Agendar una cita",
      "2. 🕒 Ver horarios disponibles",
      "3. 📍 Ubicacion",
      "4. 💰 Costos y promocion",
      "5. 💵 Formas de pago",
      "",
      "Puedes escribirme, por ejemplo: \"quiero agendar\", \"cuanto cuesta\" o \"ubicacion\"."
    ].join("\n")
  };

  return responses[intent];
}

function detectIntent(text) {
  const normalized = normalizeText(text);
  const checks = [
    ["medical_urgent", () => hasAny(normalized, ["urgente", "emergencia", "dolor fuerte", "mucho dolor", "sangrado", "fiebre", "desmayo", "desmaye", "embarazo", "me siento mal", "me duele mucho"])],
    ["cancel_appointment", () => isCancellationRequest(normalized)],
    ["reschedule_appointment", () => hasAny(normalized, ["reagendar", "cambiar cita", "mover cita", "cambiar horario", "otro horario", "otro dia", "no puedo ese dia", "cambiar mi cita"])],
    ["late_arrival", () => hasAny(normalized, ["voy tarde", "llegare tarde", "llego tarde", "se me hizo tarde", "retraso", "atrasada", "atrasado", "demorada", "demorado", "no alcanzo a llegar"])],
    ["confirm_appointment", () => hasAny(normalized, ["confirmada", "confirmar cita", "ya quedo", "quedo confirmada", "me confirmas", "tengo cita", "mi cita esta confirmada"])],
    ["schedule_appointment", () => hasAny(normalized, ["agendar", "hacer cita", "sacar cita", "reservar", "quiero una cita", "necesito una cita", "ocupo cita", "quiero cita", "agendar consulta", "necesito consulta", "quiero consultar", "apartar cita"])],
    ["check_availability", () => isAvailabilityIntent(normalized)],
    ["cost", () => isPriceQuestion(normalized)],
    ["promotion", () => isPromotionQuestion(normalized)],
    ["payment_methods", () => isCardQuestion(normalized)],
    ["location", () => isLocationQuestion(normalized)],
    ["morning_hours", () => isMorningQuestion(normalized)],
    ["saturday", () => isSaturdayQuestion(normalized)],
    ["appointment_duration", () => hasAny(normalized, ["duracion", "cuanto dura", "cuanto tiempo dura", "cuanto tiempo es", "cuanto tardan", "tardan", "40 minutos"])],
    ["new_patient", () => hasAny(normalized, ["primera vez", "paciente nueva", "primera consulta", "nunca he ido", "nuevo paciente", "nueva paciente"])],
    ["medication_question", () => hasAny(normalized, ["medicamento", "que medicamento tomo", "me puedo tomar algo", "que me recomienda tomar", "me receta algo", "tengo infeccion", "dolor que tomo", "que pastilla tomo", "me puede recetar", "ocupo medicina"])],
    ["medical_services", () => hasAny(normalized, ["ultrasonido", "papanicolaou", "papanicolau", "colposcopia", "estudio", "estudios", "servicios", "que incluye"])],
    ["appointment_requirements", () => hasAny(normalized, ["que necesito llevar", "tengo que llevar", "documentos", "identificacion", "estudios anteriores", "receta", "requisitos", "que debo llevar", "que llevo"])],
    ["invoice", () => hasAny(normalized, ["factura", "facturan", "facturar", "recibo", "comprobante"])],
    ["direct_contact", () => hasAny(normalized, ["hablar con alguien", "hablar con la doctora", "persona", "recepcion", "telefono", "tel", "contacto", "llamar", "me llamen", "me pueden llamar"])],
    ["greeting", () => isGreetingQuestion(normalized) || isGeneralMenuQuestion(normalized)],
    ["closing", () => isConversationClosing(normalized)]
  ];

  for (const [intent, matches] of checks) {
    if (matches()) return { intent, confidence: 0.9 };
  }

  return { intent: "fallback", confidence: 0.2 };
}

function hasAny(text, needles) {
  return needles.some((needle) => (needle instanceof RegExp ? needle.test(text) : text.includes(needle)));
}

function isAvailabilityIntent(text) {
  return (
    hasAny(text, [
      "horarios",
      "disponibilidad",
      "disponible",
      "citas disponibles",
      "que dias",
      "que horarios",
      "hay cita",
      "tienes lugar",
      "hay espacio",
      "tienen citas"
    ]) ||
    /\b(?:hay|tienes|tienen)\s+(?:lugar|espacio|cita|horario|disponible)\b/.test(text) ||
    looksLikeDateRequest(text)
  );
}

function formatMoney(value) {
  const raw = String(value).replace(/[^\d.]/g, "");
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return String(value).startsWith("$") ? value : `$${value}`;
  return `$${new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 }).format(amount)}`;
}

async function answerFromApprovedKnowledge(normalizedText) {
  if (!normalizedText || isAppointmentLikeQuestion(normalizedText)) return undefined;

  try {
    const suggestions = await loadKnowledgeSuggestions("approved", 50);
    const match = suggestions.find((suggestion) => knowledgeMatches(normalizedText, suggestion.question));
    return match?.answer;
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

function meaningfulWords(text) {
  const stopWords = new Set(["hola", "buenas", "que", "como", "para", "con", "una", "uno", "los", "las", "del", "por", "favor", "tengo", "quiero"]);
  return [...new Set(text.split(" ").filter((word) => word.length >= 4 && !stopWords.has(word)))].slice(0, 8);
}

function isAppointmentLikeQuestion(text) {
  return /\b(?:cita|agendar|agenda|horario|disponible|disponibilidad|cancelar|reagendar)\b/.test(text) || looksLikeDateRequest(text);
}

function looksLikeDateRequest(text) {
  return (
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(text) ||
    /\b\d{1,2}(?:\s+de)?\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de\s+)?\d{2,4})?\b/.test(text)
  );
}

function isLocationQuestion(text) {
  return (
    /\b(?:ubicacion|ubi|ubicados|direccion|donde estan|donde se ubican|como llego|como llegar|plaza de la paz|consultorio)\b/.test(text) ||
    /\b(?:mandame|manda|pasame|pasa|me pasas)\s+(?:la\s+)?(?:ubi|ubicacion|direccion)\b/.test(text)
  );
}

function isGreetingQuestion(text) {
  return /^(?:hola|ola|hoola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|hello|hi|que tal|que onda|hola buenas|disculpa|informes)$/.test(text);
}

function isResetCommand(text) {
  return /^(?:menu|menú|reiniciar|empezar de nuevo|volver al menu|volver al menú)$/.test(text);
}

function isConversationClosing(text) {
  return /^(?:gracias|muchas gracias|ok gracias|okay gracias|listo gracias|perfecto gracias|esta bien gracias|sale gracias|va gracias|ya gracias|no gracias|por ahora no|seria todo|eso es todo|listo|ok|okay|va|sale|perfecto)$/.test(text);
}

function isCancellationRequest(text) {
  return (
    /^(?:cancelar|cancela|cancelacion)$/.test(text) ||
    /\b(?:cancelar mi cita|quiero cancelar|necesito cancelar|cancelar consulta|no podre ir|no puedo ir|ya no podre ir|ya no puedo ir)\b/.test(text) ||
    (/\b(?:cancelar|cancela|cancelacion|anular|eliminar)\b/.test(text) &&
      /\b(?:cita|consulta|agenda|reservacion)\b/.test(text))
  );
}

function isMorningQuestion(text) {
  return (
    /\b(?:temprano|matutino|citas temprano|horario en la manana|consulta en la manana)\b/.test(text) ||
    (/\bmanana\b/.test(text) && /\b(?:por la manana|en la manana|consulta|atienden|abren|horario matutino|temprano)\b/.test(text))
  );
}

function isSaturdayQuestion(text) {
  return /\b(?:sabado|sabados|fin de semana|domingo|domingos)\b/.test(text);
}

function isPriceQuestion(text) {
  return /\b(?:cuanto cuesta|costo|precio|costos|precios|cuanto cobran|cuanto sale|cuanto vale|en cuanto esta|cuanto es|presio)\b/.test(text);
}

function isPromotionQuestion(text) {
  return /\b(?:promocion|promosion|paquete|promo|oferta|sigue la promo|todavia tienen promo)\b/.test(text);
}

function isCardQuestion(text) {
  return /\b(?:tarjeta|tarjerta|credito|debito|transferencia|trasferencia|efectivo|pago|formas de pago|forma de pago|metodos de pago|pagar con tarjeta)\b/.test(text);
}

function isGeneralMenuQuestion(text) {
  return /\b(?:info|informacion|informes|dudas|preguntas|opciones|jotas)\b/.test(text);
}

function normalizeText(value) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!,.;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function safeSendWhatsAppText(to, body) {
  try {
    await sendWhatsAppText(to, body);
  } catch (error) {
    logSafeError(`Failed sending fallback WhatsApp message to ${maskPhone(to)}`, error);
  }
}

function todayISO() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.clinicTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
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

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxRequestBytes) {
      throw new Error(`Request body too large: ${size} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

async function readForm(req) {
  const rawBody = await readRawBody(req);
  return new URLSearchParams(rawBody.toString("utf8"));
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
