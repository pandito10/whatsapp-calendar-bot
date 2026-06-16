import { config, requireEnv } from "./config.js";
import { detectIntent, normalizeText } from "./intents.js";

export async function understandMessage(message, session) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.clinicTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());

  const systemPrompt =
    `Eres un extractor para agendar citas medicas por WhatsApp. Hoy es ${today} en zona ${config.clinicTimezone}. No diagnostiques. Devuelve SOLO JSON valido con intent, name, email, firstVisit, paymentType, reason, preferredDateText, preferredDateISO, selectedSlotIndex. preferredDateISO debe ser YYYY-MM-DD si el paciente da una fecha o dia relativo. selectedSlotIndex es el numero de opcion si el paciente elige un horario.`;

  if (config.aiProvider === "local") {
    return understandLocally(message, session, today);
  }

  try {
    if (config.aiProvider === "gemini") {
      return await understandWithGemini(systemPrompt, message, session);
    }

    return await understandWithOpenAI(systemPrompt, message, session);
  } catch (error) {
    console.warn(`AI provider ${config.aiProvider} failed; using local parser fallback:`, error.message);
    return understandLocally(message, session, today);
  }
}

async function understandWithOpenAI(systemPrompt, message, session) {
  requireEnv(["OPENAI_API_KEY"], "OpenAI");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.openaiModel,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: JSON.stringify({
            currentSession: session ?? null,
            message
          })
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return JSON.parse(data.choices?.[0]?.message?.content ?? "{}");
}

async function understandWithGemini(systemPrompt, message, session) {
  requireEnv(["GEMINI_API_KEY"], "Gemini");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: JSON.stringify({
                  currentSession: session ?? null,
                  message
                })
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return parseJson(data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
}

export async function transcribeAudio(buffer, mimeType) {
  if (config.aiProvider !== "gemini" || !config.geminiApiKey) return null;

  requireEnv(["GEMINI_API_KEY"], "Gemini");

  const base64 = buffer.toString("base64");
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${config.geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: normalizeMimeType(mimeType),
                  data: base64
                }
              },
              {
                text: "Transcribe this audio message to text in Spanish. Return only the transcribed text, nothing else. If you cannot understand it, return an empty string."
              }
            ]
          }
        ],
        generationConfig: { temperature: 0 }
      }),
      signal: AbortSignal.timeout(30_000)
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini transcription failed: ${response.status}`);
  }

  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
  return text || null;
}

function normalizeMimeType(mimeType) {
  const m = String(mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (m === "audio/ogg" || m === "audio/ogg; codecs=opus" || m.includes("ogg")) return "audio/ogg";
  if (m.includes("mp4") || m.includes("m4a")) return "audio/mp4";
  if (m.includes("mpeg") || m.includes("mp3")) return "audio/mpeg";
  if (m.includes("wav")) return "audio/wav";
  if (m.includes("webm")) return "audio/webm";
  return "audio/ogg";
}

function parseJson(value) {
  const trimmed = value.trim();
  const json = trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") : trimmed;
  return JSON.parse(json || "{}");
}

function understandLocally(message, session, today) {
  const text = normalize(message);
  const selectedSlotIndex = parseSlotSelection(text, session);
  const preferredDateISO = parseDate(text, today);
  const name = parseName(message, text, session);
  const email = parseEmail(message);
  const detectedIntent = detectIntent(text).intent;
  const wantsAvailability = detectedIntent === "check_availability" || Boolean(preferredDateISO);

  return {
    intent: selectedSlotIndex ? "select_slot" : detectedIntent !== "fallback" ? detectedIntent : wantsAvailability ? "check_availability" : detectedIntent,
    name,
    email,
    firstVisit: parseFirstVisit(text, session),
    paymentType: parsePaymentType(text, session),
    reason: parseReason(message, text, session),
    preferredDateText: preferredDateISO ? message : undefined,
    preferredDateISO,
    preferredTimeRange: parsePreferredTimeRange(text),
    selectedSlotIndex
  };
}

function parseSlotSelection(text, session) {
  const exact = text.match(/^\s*([1-9])\s*$/);
  if (exact) return Number(exact[1]);

  const option = text.match(/\b(?:opcion|numero|horario)\s*([1-9])\b/);
  if (option) return Number(option[1]);

  const words = {
    uno: 1,
    primera: 1,
    primer: 1,
    dos: 2,
    segunda: 2,
    tres: 3,
    tercera: 3,
    cuatro: 4,
    cuarta: 4,
    cinco: 5,
    quinta: 5,
    seis: 6,
    sexta: 6,
    ultima: session?.offeredSlots?.length
  };
  for (const [word, index] of Object.entries(words)) {
    if (index && new RegExp(`\\b(?:la\\s+)?${word}\\b`).test(text)) return index;
  }

  const timeMatch = text.match(/\b(?:la de las|a las|las)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (timeMatch && Array.isArray(session?.offeredSlots)) {
    const requestedHour = Number(timeMatch[1]);
    const requestedMinute = timeMatch[2] ? Number(timeMatch[2]) : 0;
    const requestedPeriod = timeMatch[3];
    const slotIndex = session.offeredSlots.findIndex((slot) => {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: config.clinicTimezone,
        hour: "numeric",
        minute: "2-digit",
        hour12: true
      }).formatToParts(new Date(slot.start));
      const hour = Number(parts.find((part) => part.type === "hour")?.value);
      const minute = Number(parts.find((part) => part.type === "minute")?.value);
      const period = parts.find((part) => part.type === "dayPeriod")?.value.toLowerCase();
      return hour === requestedHour && minute === requestedMinute && (!requestedPeriod || period === requestedPeriod);
    });
    if (slotIndex >= 0) return slotIndex + 1;
  }

  return undefined;
}

function parseName(original, normalized, session) {
  if (session?.name && !looksLikeNameOnly(original)) return undefined;

  const nameMatch = normalized.match(/\b(?:soy|me llamo|mi nombre es|nombre es|nombre correcto es|el nombre correcto es)\s+([a-záéíóúñ ]{2,60})/i);
  if (nameMatch) return cleanName(nameMatch[1]);

  if (session && !session.name && looksLikeNameOnly(original)) {
    return cleanName(original);
  }

  return undefined;
}

function parseEmail(value) {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : undefined;
}

function parseFirstVisit(text, session) {
  if (session?.firstVisit) return undefined;
  if (/\b(?:primera vez|nuevo|nueva|nunca he ido|no he ido)\b/.test(text)) return "Si";
  if (/\b(?:ya he ido|ya fui|subsecuente|seguimiento|no es primera)\b/.test(text)) return "No";
  if (session?.step === "collectingFirstVisit") {
    if (/\b(?:si|sí|primera)\b/.test(text)) return "Si";
    if (/\b(?:no|ya)\b/.test(text)) return "No";
  }
  return undefined;
}

function parsePaymentType(text, session) {
  if (session?.paymentType) return undefined;
  if (/\b(?:particular|privado|efectivo|tarjeta)\b/.test(text)) return "Particular";
  const network = text.match(/\b(?:seguro|aseguradora|red medica|red médica|gastos medicos|gastos médicos|axa|gnp|metlife|bupa|seguros monterrey|monterrey)\b/);
  if (network) return cleanSentence(network[0]);
  if (session?.step === "collectingPaymentType") return cleanSentence(text);
  return undefined;
}

function parsePreferredTimeRange(text) {
  if (/\b(?:despues de las|despues de|a partir de las)\s*(\d{1,2})\s*(am|pm)?\b/.test(text)) {
    const match = text.match(/\b(?:despues de las|despues de|a partir de las)\s*(\d{1,2})\s*(am|pm)?\b/);
    return { label: match[0], start: normalizeHourRange(Number(match[1]), match[2]), end: 24 * 60 };
  }
  if (/\b(?:en la manana|por la manana|temprano)\b/.test(text)) return { label: "manana", start: 9 * 60, end: 12 * 60 };
  if (/\b(?:medio dia|mediodia|antes de comer)\b/.test(text)) return { label: "medio dia", start: 12 * 60, end: 14 * 60 };
  if (/\b(?:en la tarde|por la tarde|tarde)\b/.test(text)) return { label: "tarde", start: 12 * 60, end: 18 * 60 };
  if (/\b(?:al rato)\b/.test(text)) return { label: "al rato", start: 0, end: 24 * 60 };
  return undefined;
}

function normalizeHourRange(hour, period) {
  if (period === "pm" && hour < 12) return (hour + 12) * 60;
  if (period === "am" && hour === 12) return 0;
  if (!period && hour <= 8) return (hour + 12) * 60;
  return hour * 60;
}

function parseReason(original, normalized, session) {
  if (session?.reason) return undefined;

  const knownService = normalizeKnownServiceReason(original, normalized);
  if (knownService) return knownService;

  if (session?.step === "collectingService") {
    return normalizeServiceReason(original, normalized);
  }

  const reasonMatch = normalized.match(/\b(?:por|para|motivo)\s+([a-záéíóúñ ]{3,80})/i);
  if (!reasonMatch) return undefined;

  const reason = reasonMatch[1]
    .replace(/\b(?:mañana|hoy|pasado mañana|el lunes|el martes|el miercoles|el miércoles|el jueves|el viernes|el sabado|el sábado|el domingo)\b.*$/i, "")
    .trim();
  return reason ? cleanSentence(reason) : undefined;
}

function normalizeKnownServiceReason(original, normalized) {
  const text = normalizeText(normalized);
  if (/\b(?:promo|promocion|paquete|paquete promocional|1200)\b/.test(text)) return "Promocion";
  if (/\b(?:ultrasonido|ultra)\b/.test(text)) return "Ultrasonido";
  if (/\b(?:papanicolaou|papanicolau|papanicolao|papanicol)\b/.test(text)) return "Papanicolaou";
  if (/\b(?:colposcopia|colposkopia|colpo)\b/.test(text)) return "Colposcopia";
  if (/\b(?:embarazo|control prenatal|prenatal)\b/.test(text)) return "Control prenatal";
  if (/^(?:consulta|revision|chequeo)$/.test(text)) return "Consulta";
  return undefined;
}

function normalizeServiceReason(original, normalized) {
  const text = normalizeText(normalized);
  if (
    /^(?:una|un)?\s*(?:cita|consulta|revision|chequeo)\s*$/.test(text) ||
    /\b(?:quiero|ocupo|necesito|agendar|hacer|sacar|reservar)\b.*\b(?:cita|consulta)\b/.test(text)
  ) {
    return "Consulta";
  }

  if (/\b(?:promo|promocion|paquete|paquete promocional|1200)\b/.test(text)) return "Promocion";
  if (/\b(?:ultrasonido|ultra)\b/.test(text)) return "Ultrasonido";
  if (/\b(?:papanicolaou|papanicolau|papanicolao|papanicol)\b/.test(text)) return "Papanicolaou";
  if (/\b(?:colposcopia|colposkopia|colpo)\b/.test(text)) return "Colposcopia";
  if (/\b(?:embarazo|control prenatal|prenatal)\b/.test(text)) return "Control prenatal";
  if (/\b(?:revision|chequeo|consulta)\b/.test(text)) return "Consulta";

  const cleaned = cleanSentence(original).slice(0, 80);
  return cleaned || "Consulta";
}

function parseDate(text, todayISO) {
  const today = parseISODate(todayISO);

  if (/\bhoy\b/.test(text)) return formatISODate(today);
  if (/\bpasado manana\b|\bpasado mañana\b/.test(text)) return formatISODate(addDays(today, 2));
  if (/\bmanana\b|\bmañana\b/.test(text)) return formatISODate(addDays(today, 1));

  const slash = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]);
    const year = slash[3] ? normalizeYear(Number(slash[3])) : today.getFullYear();
    return validDate(year, month, day, today);
  }

  const monthDate = text.match(
    /\b(\d{1,2})(?:\s+de)?\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de\s+)?(\d{2,4}))?\b/
  );
  if (monthDate) {
    const day = Number(monthDate[1]);
    const month = monthNumber(monthDate[2]);
    const year = monthDate[3] ? normalizeYear(Number(monthDate[3])) : today.getFullYear();
    return validDate(year, month, day, today);
  }

  const weekday = [
    ["domingo", 0],
    ["lunes", 1],
    ["martes", 2],
    ["miercoles", 3],
    ["miércoles", 3],
    ["jueves", 4],
    ["viernes", 5],
    ["sabado", 6],
    ["sábado", 6]
  ].find(([word]) => new RegExp(`\\b${word}\\b`).test(text));

  if (weekday) {
    const daysUntil = (weekday[1] - today.getDay() + 7) % 7 || 7;
    return formatISODate(addDays(today, daysUntil));
  }

  return undefined;
}

function looksLikeNameOnly(value) {
  const trimmed = value.trim();
  return /^[a-záéíóúñü' ]{4,80}$/i.test(trimmed) && trimmed.split(/\s+/).length >= 2;
}

function normalize(value) {
  return normalizeText(value);
}

function cleanName(value) {
  return cleanSentence(value)
    .replace(/\b(?:y|quiero|ocupo|necesito|una|cita|mañana|manana|hoy|el|para|por)\b.*$/i, "")
    .trim();
}

function cleanSentence(value) {
  return value
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function parseISODate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatISODate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeYear(year) {
  return year < 100 ? 2000 + year : year;
}

function monthNumber(month) {
  return {
    enero: 1,
    febrero: 2,
    marzo: 3,
    abril: 4,
    mayo: 5,
    junio: 6,
    julio: 7,
    agosto: 8,
    septiembre: 9,
    setiembre: 9,
    octubre: 10,
    noviembre: 11,
    diciembre: 12
  }[month];
}

function validDate(year, month, day, today) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  if (date < addDays(today, -1)) date.setFullYear(date.getFullYear() + 1);
  return formatISODate(date);
}
