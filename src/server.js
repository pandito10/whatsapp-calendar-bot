import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { understandMessage } from "./ai.js";
import { createAppointment, findAvailableSlots } from "./calendar.js";
import { config } from "./config.js";
import {
  deleteSession,
  getSession,
  isDatabaseEnabled,
  loadConversations,
  saveCita,
  saveConversationMessage,
  setSession
} from "./db.js";
import { sendWhatsAppText } from "./whatsapp.js";

const sessions = new Map();
const processedMessages = new Map();
const processedMessageTtlMs = 24 * 60 * 60 * 1000;
const conversations = new Map();
const maxMessagesPerConversation = 100;
let appSecretWarningShown = false;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/webhook") {
      handleWebhookVerification(url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      const rawBody = await readRawBody(req);
      if (!isValidWebhookSignature(req, rawBody)) {
        res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
        return;
      }

      const body = JSON.parse(rawBody.toString("utf8"));
      res.writeHead(200).end("ok");
      await handleWhatsAppWebhook(body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200).end("ok");
      return;
    }

    if (req.method === "GET" && url.pathname === "/debug/config") {
      handleDebugConfig(url, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/inbox") {
      await handleInbox(url, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/oauth/google/callback") {
      handleGoogleOAuthCallback(url, res);
      return;
    }

    res.writeHead(404).end("not found");
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500).end("server error");
  }
});

server.listen(config.port, () => {
  console.log(`WhatsApp calendar bot listening on port ${config.port}`);
});

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

function handleDebugConfig(url, res) {
  if (!hasInboxAccess(url, res)) {
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
        whatsappTokenLength: config.whatsappAccessToken?.length ?? 0,
        whatsappTokenSha12: hashShort(config.whatsappAccessToken ?? ""),
        whatsappPhoneNumberId: config.whatsappPhoneNumberId,
        whatsappBusinessAccountId: config.whatsappBusinessAccountId,
        doctorWhatsappNumber: config.doctorWhatsappNumber,
        databaseEnabled: isDatabaseEnabled()
      })
    );
}

async function handleInbox(url, res) {
  if (!hasInboxAccess(url, res)) {
    return;
  }

  const selectedPhone = url.searchParams.get("phone");
  const list = await getInboxConversations();
  const selected = selectedPhone ? conversations.get(selectedPhone) : list[0];

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(renderInboxPage(list, selected, url.searchParams.get("token")));
}

function hasInboxAccess(url, res) {
  if (!config.inboxPassword) {
    res
      .writeHead(403, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Configura INBOX_PASSWORD en las variables de entorno para acceder al inbox");
    return false;
  }

  if (url.searchParams.get("token") !== config.inboxPassword) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
    return false;
  }

  return true;
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
      console.warn("Could not load conversations from Supabase; using memory fallback:", error.message);
    }
  }

  return [...conversations.values()].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function renderInboxPage(list, selected, token) {
  const conversationLinks =
    list.length === 0
      ? `<div class="empty-state">Todavia no hay conversaciones.</div>`
      : list
          .map((conversation) => {
            const last = conversation.messages.at(-1);
            const active = selected?.phoneNumber === conversation.phoneNumber ? " active" : "";
            return `<a class="thread${active}" href="/inbox?token=${encodeURIComponent(token)}&phone=${encodeURIComponent(
              conversation.phoneNumber
            )}">
              <div class="avatar">${escapeHtml(conversation.phoneNumber.slice(-2))}</div>
              <div class="thread-copy">
                <div class="thread-top">
                  <strong>${escapeHtml(formatPhoneForInbox(conversation.phoneNumber))}</strong>
                  <span>${formatInboxDate(conversation.updatedAt)}</span>
                </div>
                <p>${escapeHtml(last?.body ?? "")}</p>
              </div>
            </a>`;
          })
          .join("");

  const messages = selected
    ? selected.messages
        .map((message) => {
          const side = message.sender === "bot" ? "bot" : "patient";
          const label = message.sender === "bot" ? "Bot" : "Paciente";
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
      color: var(--brand-dark);
      background: #dff4ef;
      border: 1px solid #bce4dc;
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 650;
    }
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
    .meta {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
    }
    .body { font-size: 14px; }
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
      .messages { padding: 16px; }
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
    <div class="status">${list.length} conversaciones · actualiza cada 20s</div>
  </header>
  <main>
    <aside>
      <div class="sidebar-head">
        <strong>Pacientes</strong>
        <span>Ultimos mensajes recibidos</span>
      </div>
      ${conversationLinks}
    </aside>
    <section class="chat">
      <div class="chat-title">
        <div>
          <strong>${selected ? escapeHtml(formatPhoneForInbox(selected.phoneNumber)) : "Sin conversacion seleccionada"}</strong>
          <span>${selected ? `Ultima actividad: ${formatInboxDate(selected.updatedAt)}` : "Cuando llegue un mensaje aparecera aqui."}</span>
        </div>
        ${selected ? `<div class="chip">${selected.messages.length} mensajes</div>` : ""}
      </div>
      <div class="messages">${messages}</div>
    </section>
  </main>
</body>
</html>`;
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

function hashShort(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

async function handleWhatsAppWebhook(body) {
  const messages = body?.entry?.[0]?.changes?.[0]?.value?.messages ?? [];
  for (const message of messages) {
    if (message.type !== "text") continue;
    if (alreadyProcessed(message.id)) continue;

    try {
      await handleIncomingText(message.from, message.text.body);
    } catch (error) {
      console.error(`Failed handling WhatsApp message ${message.id ?? "without-id"} from ${message.from}:`, error);
      await safeSendWhatsAppText(
        message.from,
        "🙏 Perdon, tuve un problema revisando la agenda. Por favor intenta de nuevo en un momento o escribe directamente al consultorio."
      );
    }
  }
}

async function handleIncomingText(from, text) {
  console.log(`Incoming WhatsApp from ${from}: ${text}`);
  const lower = text.trim().toLowerCase();
  const normalized = normalizeText(text);
  await recordConversationMessage(from, "patient", text);
  await notifyIncomingPatientMessage(from, text);

  if (isResetCommand(normalized)) {
    await deletePatientSession(from);
    await replyToPatient(from, answerFaq("hola"));
    return;
  }

  if (from === config.doctorWhatsappNumber && /^(?:agenda|mi agenda|ver agenda)$/.test(lower)) {
    await replyToPatient(from, "📅 Por ahora te aviso cada cita nueva por aqui. El resumen diario lo agregamos en la siguiente version.");
    return;
  }

  const existing = await getPatientSession(from);
  if (!existing) {
    const menuHandled = await handleMenuOption(from, normalized);
    if (menuHandled) return;
  }

  const faqAnswer = answerFaq(normalized);
  if (faqAnswer && !existing) {
    await replyToPatient(from, faqAnswer);
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
    offeredSlots: existing?.offeredSlots
  };

  if (session.step === "choosingSlot" && parsed.selectedSlotIndex && session.offeredSlots?.[parsed.selectedSlotIndex - 1]) {
    const slot = session.offeredSlots[parsed.selectedSlotIndex - 1];
    const name = session.name ?? "Paciente";
    const event = await createAppointment(slot, {
      name,
      phone: from,
      email: session.email,
      firstVisit: session.firstVisit,
      paymentType: session.paymentType,
      reason: session.reason
    });
    await saveConfirmedCita(from, session, slot, event);
    await deletePatientSession(from);

    await replyToPatient(
      from,
      `✅ Listo, ${name}. Tu cita quedo agendada para ${slot.label}.\n\n📍 Ubicacion: ${config.clinicAddress}${session.email ? "\n\n📩 Google Calendar tambien enviara la confirmacion a tu correo." : ""}\n\n⚠️ Si tienes dolor intenso, sangrado abundante o una urgencia, por favor acude a urgencias o contacta directamente al consultorio.`
    );
    await sendWhatsAppText(
      config.doctorWhatsappNumber,
      `📅 Nueva cita por WhatsApp:\nPaciente: ${name}\nFecha: ${slot.label}\nTelefono: ${from}${session.email ? `\nCorreo: ${session.email}` : ""}${session.firstVisit ? `\nPrimera vez: ${session.firstVisit}` : ""}${session.paymentType ? `\nTipo: ${session.paymentType}` : ""}${session.reason ? `\nMotivo: ${session.reason}` : ""}`
    );
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

async function offerAvailableSlots(from, session) {
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

  await setPatientSession(from, {
    ...session,
    step: "choosingSlot",
    offeredSlots: slots
  });

  await replyToPatient(
    from,
    `🕒 Tengo estos horarios disponibles:\n${slots
      .map((slot, index) => `${index + 1}. ${slot.label}`)
      .join("\n")}\n\nResponde con el numero del horario que prefieras para confirmar. Si ninguno te acomoda, dime otra fecha.`
  );
}

async function handleMenuOption(from, text) {
  if (/^(?:1|agendar|agendar cita|quiero agendar|hacer cita|quiero hacer una cita|cita)$/.test(text)) {
    await setPatientSession(from, { from, step: "collecting" });
    await replyToPatient(from, "😊 Claro, te ayudo a agendar. ¿Me compartes tu nombre completo?");
    return true;
  }

  if (/^(?:2|horarios|ver horarios|horarios disponibles|que citas tienes|que citas tienes disponibles|citas disponibles)$/.test(text)) {
    await replyToPatient(from, "🕒 Claro. ¿Para que dia te gustaria revisar disponibilidad? Puedes decirme, por ejemplo: hoy, mañana, viernes o una fecha.");
    return true;
  }

  if (/^(?:3|ubicacion)$/.test(text)) {
    await replyToPatient(from, answerFaq("ubicacion"));
    return true;
  }

  if (/^(?:4|costos|costo|precios|promocion|promocion)$/.test(text)) {
    await replyToPatient(from, `${answerFaq("cuanto cuesta")}\n${answerFaq("promocion")}`);
    return true;
  }

  if (/^(?:5|formas de pago|forma de pago|pago)$/.test(text)) {
    await replyToPatient(from, answerFaq("tarjeta"));
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
    `💬 Mensaje de paciente\nTelefono: ${from}\n\n${body}`
  );
}

async function notifyBotReply(to, body) {
  if (!shouldForwardConversation(to)) return;
  await safeSendWhatsAppText(
    config.doctorWhatsappNumber,
    `🤖 Bot respondio a ${to}\n\n${body}`
  );
}

function shouldForwardConversation(phoneNumber) {
  return config.forwardConversationCopies && phoneNumber !== config.doctorWhatsappNumber;
}

async function recordConversationMessage(phoneNumber, sender, body) {
  const existing = conversations.get(phoneNumber) ?? {
    phoneNumber,
    updatedAt: undefined,
    messages: []
  };

  const message = {
    sender,
    body,
    timestamp: new Date().toISOString()
  };

  existing.messages.push(message);
  existing.messages = existing.messages.slice(-maxMessagesPerConversation);
  existing.updatedAt = message.timestamp;
  conversations.set(phoneNumber, existing);

  if (!isDatabaseEnabled()) return;
  try {
    await saveConversationMessage(phoneNumber, sender, body);
  } catch (error) {
    console.warn("Could not save conversation to Supabase:", error.message);
  }
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
    console.warn("Could not load session from Supabase; using memory fallback:", error.message);
  }

  return undefined;
}

async function setPatientSession(phoneNumber, session) {
  sessions.set(phoneNumber, session);

  if (!isDatabaseEnabled()) return;
  try {
    await setSession(phoneNumber, session);
  } catch (error) {
    console.warn("Could not save session to Supabase:", error.message);
  }
}

async function deletePatientSession(phoneNumber) {
  sessions.delete(phoneNumber);

  if (!isDatabaseEnabled()) return;
  try {
    await deleteSession(phoneNumber);
  } catch (error) {
    console.warn("Could not delete session from Supabase:", error.message);
  }
}

async function saveConfirmedCita(phoneNumber, session, slot, event) {
  if (!isDatabaseEnabled()) return;

  try {
    await saveCita({
      phoneNumber,
      patientName: session.name,
      patientEmail: session.email,
      googleEventId: event?.id,
      slotStart: slot.start,
      slotEnd: slot.end,
      firstVisit: session.firstVisit,
      paymentType: session.paymentType,
      reason: session.reason
    });
  } catch (error) {
    console.warn("Could not save cita to Supabase:", error.message);
  }
}

function answerFaq(text) {
  if (isGreetingQuestion(text)) {
    return [
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
    ].join("\n");
  }

  if (isLocationQuestion(text)) {
    return "📍 Estamos ubicados en Plaza de la Paz #20, 2o. Piso, Consultorio 14, Guanajuato, Gto.";
  }

  if (isMorningQuestion(text)) {
    return "🌙 No, solo atendemos por la tarde de 4:40 p.m. a 8:00 p.m.";
  }

  if (isSaturdayQuestion(text)) {
    return "📅 No, solo atendemos de lunes a viernes.";
  }

  if (isPriceQuestion(text)) {
    return `💰 Consulta ${config.consultationPrice}\n🎁 Paquete de promocion ${config.promotionPrice}`;
  }

  if (isPromotionQuestion(text)) {
    return "🎁 Si, aun contamos con la promocion.";
  }

  if (isCardQuestion(text)) {
    return "💵 Por el momento no, solo efectivo o transferencia bancaria.";
  }

  if (isGeneralMenuQuestion(text)) {
    return [
      "😊 Te puedo ayudar con:",
      "1. 📍 Ubicacion",
      "2. 📅 Agendar una cita",
      "3. 🕒 Horarios de atencion",
      "4. 📆 Sabados",
      "5. 💰 Costo de consulta",
      "6. 🎁 Promocion",
      "7. 💵 Formas de pago"
    ].join("\n");
  }

  return undefined;
}

function isLocationQuestion(text) {
  return /\b(?:ubicacion|ubicados|direccion|donde estan|donde se ubican|como llegar)\b/.test(text);
}

function isGreetingQuestion(text) {
  return /^(?:hola|ola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|hello|hi|que tal|que onda)$/.test(text);
}

function isResetCommand(text) {
  return /^(?:menu|menú|cancelar|reiniciar|empezar de nuevo|volver al menu|volver al menú)$/.test(text);
}

function isMorningQuestion(text) {
  return /\b(?:manana|mañana|temprano|matutino)\b/.test(text) && /\b(?:consulta|atienden|horario|cita)\b/.test(text);
}

function isSaturdayQuestion(text) {
  return /\b(?:sabado|sabados|sábado|sábados|fin de semana)\b/.test(text);
}

function isPriceQuestion(text) {
  return /\b(?:cuanto cuesta|costo|precio|costos|precios|vale|cuanto es|cuanto cobran)\b/.test(text);
}

function isPromotionQuestion(text) {
  return /\b(?:promocion|paquete|promo)\b/.test(text);
}

function isCardQuestion(text) {
  return /\b(?:tarjeta|credito|crédito|debito|débito|pago con tarjeta)\b/.test(text);
}

function isGeneralMenuQuestion(text) {
  return /\b(?:info|informacion|información|dudas|preguntas|opciones|jotas)\b/.test(text);
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

function alreadyProcessed(messageId) {
  if (!messageId) return false;

  const now = Date.now();
  for (const [id, timestamp] of processedMessages) {
    if (now - timestamp > processedMessageTtlMs) processedMessages.delete(id);
  }

  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, now);
  return false;
}

async function safeSendWhatsAppText(to, body) {
  try {
    await sendWhatsAppText(to, body);
  } catch (error) {
    console.error(`Failed sending fallback WhatsApp message to ${to}:`, error);
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
    if (!appSecretWarningShown) {
      console.warn("WHATSAPP_APP_SECRET is not configured; skipping WhatsApp webhook signature validation.");
      appSecretWarningShown = true;
    }
    return true;
  }

  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !signature.startsWith("sha256=")) return false;

  const expected = crypto.createHmac("sha256", config.whatsappAppSecret).update(rawBody).digest("hex");
  const actual = signature.slice("sha256=".length);

  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (expectedBuffer.length !== actualBuffer.length) return false;

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
