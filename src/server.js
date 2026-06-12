import http from "node:http";
import crypto from "node:crypto";
import { URL } from "node:url";
import { understandMessage } from "./ai.js";
import { createAppointment, findAvailableSlots } from "./calendar.js";
import { config } from "./config.js";
import { sendWhatsAppText } from "./whatsapp.js";

const sessions = new Map();
const processedMessages = new Map();
const processedMessageTtlMs = 24 * 60 * 60 * 1000;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/webhook") {
      handleWebhookVerification(url, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      const body = await readJson(req);
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
  if (url.searchParams.get("token") !== config.whatsappVerifyToken) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("forbidden");
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
        workStart: config.workStart,
        workEnd: config.workEnd,
        whatsappTokenLength: config.whatsappAccessToken?.length ?? 0,
        whatsappTokenSha12: hashShort(config.whatsappAccessToken ?? ""),
        whatsappPhoneNumberId: config.whatsappPhoneNumberId,
        whatsappBusinessAccountId: config.whatsappBusinessAccountId,
        doctorWhatsappNumber: config.doctorWhatsappNumber
      })
    );
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
        "Perdon, tuve un problema revisando la agenda. Por favor intenta de nuevo en un momento o escribe directamente al consultorio."
      );
    }
  }
}

async function handleIncomingText(from, text) {
  console.log(`Incoming WhatsApp from ${from}: ${text}`);
  const lower = text.trim().toLowerCase();

  if (from === config.doctorWhatsappNumber && /^(?:agenda|mi agenda|ver agenda)$/.test(lower)) {
    await sendWhatsAppText(from, "Por ahora te aviso cada cita nueva por aqui. El resumen diario lo agregamos en la siguiente version.");
    return;
  }

  const existing = sessions.get(from);
  let parsed;
  try {
    parsed = await understandMessage(text, existing);
  } catch (error) {
    if (error.message?.includes("Missing OpenAI") || error.message?.includes("Missing Gemini")) {
      await sendWhatsAppText(
        from,
        "Ya estoy conectado al WhatsApp del consultorio. Falta activar la IA y Google Calendar para poder agendar citas automaticamente."
      );
      return;
    }
    if (error.message?.includes("insufficient_quota")) {
      await sendWhatsAppText(
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
    await createAppointment(slot, {
      name,
      phone: from,
      email: session.email,
      firstVisit: session.firstVisit,
      paymentType: session.paymentType,
      reason: session.reason
    });
    sessions.delete(from);

    await sendWhatsAppText(
      from,
      `Listo, ${name}. Tu cita quedo agendada para ${slot.label}.\n\nUbicacion: ${config.clinicAddress}${session.email ? "\n\nGoogle Calendar tambien enviara la confirmacion a tu correo." : ""}\n\nSi tienes dolor intenso, sangrado abundante o una urgencia, por favor acude a urgencias o contacta directamente al consultorio.`
    );
    await sendWhatsAppText(
      config.doctorWhatsappNumber,
      `Nueva cita por WhatsApp:\nPaciente: ${name}\nFecha: ${slot.label}\nTelefono: ${from}${session.email ? `\nCorreo: ${session.email}` : ""}${session.firstVisit ? `\nPrimera vez: ${session.firstVisit}` : ""}${session.paymentType ? `\nTipo: ${session.paymentType}` : ""}${session.reason ? `\nMotivo: ${session.reason}` : ""}`
    );
    return;
  }

  if (!session.name) {
    sessions.set(from, session);
    await sendWhatsAppText(from, "Claro, te ayudo a agendar. ¿Me compartes tu nombre completo?");
    return;
  }

  if (!session.email) {
    sessions.set(from, { ...session, step: "collectingEmail" });
    await sendWhatsAppText(from, `Gracias, ${session.name}. ¿Me compartes tu correo electronico para enviarte la confirmacion de Google Calendar?`);
    return;
  }

  if (!session.firstVisit) {
    sessions.set(from, { ...session, step: "collectingFirstVisit" });
    await sendWhatsAppText(from, "¿Es tu primera vez con nosotros? Responde si o no.");
    return;
  }

  if (!session.paymentType) {
    sessions.set(from, { ...session, step: "collectingPaymentType" });
    await sendWhatsAppText(from, "¿Tu consulta es particular o por parte de alguna red medica/aseguradora?");
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
    sessions.set(from, session);
    await sendWhatsAppText(from, `Gracias, ${session.name}. ¿Que dia te gustaria la cita?`);
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
      await sendWhatsAppText(
        from,
        "Ya entendi tu solicitud, pero falta conectar Google Calendar para revisar horarios y agendar la cita."
      );
      return;
    }
    throw error;
  }
  if (slots.length === 0) {
    sessions.set(from, { ...session, preferredDateText: undefined });
    await sendWhatsAppText(from, "No encontre horarios disponibles en esos dias. ¿Quieres que revise otra fecha?");
    return;
  }

  sessions.set(from, {
    ...session,
    step: "choosingSlot",
    offeredSlots: slots
  });

  await sendWhatsAppText(
    from,
    `Tengo estos horarios disponibles:\n${slots
      .map((slot, index) => `${index + 1}. ${slot.label}`)
      .join("\n")}\n\nResponde con 1, 2 o 3 para confirmar.`
  );
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

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
