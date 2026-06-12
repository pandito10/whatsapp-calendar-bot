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
        maxOfferedSlots: config.maxOfferedSlots,
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
        "🙏 Perdon, tuve un problema revisando la agenda. Por favor intenta de nuevo en un momento o escribe directamente al consultorio."
      );
    }
  }
}

async function handleIncomingText(from, text) {
  console.log(`Incoming WhatsApp from ${from}: ${text}`);
  const lower = text.trim().toLowerCase();
  const normalized = normalizeText(text);

  if (isResetCommand(normalized)) {
    sessions.delete(from);
    await sendWhatsAppText(from, answerFaq("hola"));
    return;
  }

  if (from === config.doctorWhatsappNumber && /^(?:agenda|mi agenda|ver agenda)$/.test(lower)) {
    await sendWhatsAppText(from, "📅 Por ahora te aviso cada cita nueva por aqui. El resumen diario lo agregamos en la siguiente version.");
    return;
  }

  const existing = sessions.get(from);
  if (!existing) {
    const menuHandled = await handleMenuOption(from, normalized);
    if (menuHandled) return;
  }

  const faqAnswer = answerFaq(normalized);
  if (faqAnswer && !existing) {
    await sendWhatsAppText(from, faqAnswer);
    return;
  }

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
      `✅ Listo, ${name}. Tu cita quedo agendada para ${slot.label}.\n\n📍 Ubicacion: ${config.clinicAddress}${session.email ? "\n\n📩 Google Calendar tambien enviara la confirmacion a tu correo." : ""}\n\n⚠️ Si tienes dolor intenso, sangrado abundante o una urgencia, por favor acude a urgencias o contacta directamente al consultorio.`
    );
    await sendWhatsAppText(
      config.doctorWhatsappNumber,
      `📅 Nueva cita por WhatsApp:\nPaciente: ${name}\nFecha: ${slot.label}\nTelefono: ${from}${session.email ? `\nCorreo: ${session.email}` : ""}${session.firstVisit ? `\nPrimera vez: ${session.firstVisit}` : ""}${session.paymentType ? `\nTipo: ${session.paymentType}` : ""}${session.reason ? `\nMotivo: ${session.reason}` : ""}`
    );
    return;
  }

  if (!session.name) {
    sessions.set(from, session);
    await sendWhatsAppText(from, "😊 Claro, te ayudo a agendar. ¿Me compartes tu nombre completo?");
    return;
  }

  if (!session.email) {
    sessions.set(from, { ...session, step: "collectingEmail" });
    await sendWhatsAppText(from, `📩 Gracias, ${session.name}. ¿Me compartes tu correo electronico para enviarte la confirmacion de Google Calendar?`);
    return;
  }

  if (!session.firstVisit) {
    sessions.set(from, { ...session, step: "collectingFirstVisit" });
    await sendWhatsAppText(from, "📝 ¿Es tu primera vez con nosotros? Responde si o no.");
    return;
  }

  if (!session.paymentType) {
    sessions.set(from, { ...session, step: "collectingPaymentType" });
    await sendWhatsAppText(from, "💳 ¿Tu consulta es particular o por parte de alguna red medica/aseguradora?");
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
    await sendWhatsAppText(from, `📅 Gracias, ${session.name}. ¿Que dia te gustaria la cita?`);
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
        "📅 Ya entendi tu solicitud, pero falta conectar Google Calendar para revisar horarios y agendar la cita."
      );
      return;
    }
    throw error;
  }
  if (slots.length === 0) {
    sessions.set(from, { ...session, preferredDateText: undefined });
    await sendWhatsAppText(from, "😕 No encontre horarios disponibles en esos dias. ¿Quieres que revise otra fecha?");
    return;
  }

  sessions.set(from, {
    ...session,
    step: "choosingSlot",
    offeredSlots: slots
  });

  await sendWhatsAppText(
    from,
    `🕒 Tengo estos horarios disponibles:\n${slots
      .map((slot, index) => `${index + 1}. ${slot.label}`)
      .join("\n")}\n\nResponde con el numero del horario que prefieras para confirmar. Si ninguno te acomoda, dime otra fecha.`
  );
}

async function handleMenuOption(from, text) {
  if (/^(?:1|agendar|agendar cita|quiero agendar|hacer cita|quiero hacer una cita|cita)$/.test(text)) {
    sessions.set(from, { from, step: "collecting" });
    await sendWhatsAppText(from, "😊 Claro, te ayudo a agendar. ¿Me compartes tu nombre completo?");
    return true;
  }

  if (/^(?:2|horarios|ver horarios|horarios disponibles|que citas tienes|que citas tienes disponibles|citas disponibles)$/.test(text)) {
    await sendWhatsAppText(from, "🕒 Claro. ¿Para que dia te gustaria revisar disponibilidad? Puedes decirme, por ejemplo: hoy, mañana, viernes o una fecha.");
    return true;
  }

  if (/^(?:3|ubicacion)$/.test(text)) {
    await sendWhatsAppText(from, answerFaq("ubicacion"));
    return true;
  }

  if (/^(?:4|costos|costo|precios|promocion|promocion)$/.test(text)) {
    await sendWhatsAppText(from, `${answerFaq("cuanto cuesta")}\n${answerFaq("promocion")}`);
    return true;
  }

  if (/^(?:5|formas de pago|forma de pago|pago)$/.test(text)) {
    await sendWhatsAppText(from, answerFaq("tarjeta"));
    return true;
  }

  return false;
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
    return "🌙 No, solo atendemos por la tarde de 5:00 a 9:00 pm.";
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
