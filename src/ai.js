import { config, requireEnv } from "./config.js";

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

  if (config.aiProvider === "gemini") {
    return understandWithGemini(systemPrompt, message, session);
  }

  return understandWithOpenAI(systemPrompt, message, session);
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

function parseJson(value) {
  const trimmed = value.trim();
  const json = trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") : trimmed;
  return JSON.parse(json || "{}");
}

function understandLocally(message, session, today) {
  const text = normalize(message);
  const selectedSlotIndex = parseSlotSelection(text);
  const preferredDateISO = parseDate(text, today);
  const name = parseName(message, text, session);
  const email = parseEmail(message);
  const wantsAvailability = isAvailabilityQuestion(text);

  return {
    intent: selectedSlotIndex ? "select_slot" : wantsAvailability ? "check_availability" : "book_appointment",
    name,
    email,
    firstVisit: parseFirstVisit(text, session),
    paymentType: parsePaymentType(text, session),
    reason: parseReason(message, text, session),
    preferredDateText: preferredDateISO ? message : undefined,
    preferredDateISO,
    selectedSlotIndex
  };
}

function isAvailabilityQuestion(text) {
  return (
    /\b(?:disponible|disponibles|disponibilidad|horarios|dias tienes|que dias|cuando tienes|cuando hay)\b/.test(text) ||
    /\b(?:que|cuales)\s+(?:dias|horarios)\b/.test(text)
  );
}

function parseSlotSelection(text) {
  const exact = text.match(/^\s*([1-9])\s*$/);
  if (exact) return Number(exact[1]);

  const option = text.match(/\b(?:opcion|numero|horario)\s*([1-9])\b/);
  return option ? Number(option[1]) : undefined;
}

function parseName(original, normalized, session) {
  if (session?.name && !looksLikeNameOnly(original)) return undefined;

  const nameMatch = normalized.match(/\b(?:soy|me llamo|mi nombre es|nombre es)\s+([a-záéíóúñ ]{2,60})/i);
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

function parseReason(original, normalized, session) {
  if (session?.reason) return undefined;

  const reasonMatch = normalized.match(/\b(?:por|para|motivo)\s+([a-záéíóúñ ]{3,80})/i);
  if (!reasonMatch) return undefined;

  const reason = reasonMatch[1]
    .replace(/\b(?:mañana|hoy|pasado mañana|el lunes|el martes|el miercoles|el miércoles|el jueves|el viernes|el sabado|el sábado|el domingo)\b.*$/i, "")
    .trim();
  return reason ? cleanSentence(reason) : undefined;
}

function parseDate(text, todayISO) {
  const today = parseISODate(todayISO);

  if (/\bhoy\b/.test(text)) return formatISODate(today);
  if (/\bmanana\b|\bmañana\b/.test(text)) return formatISODate(addDays(today, 1));
  if (/\bpasado manana\b|\bpasado mañana\b/.test(text)) return formatISODate(addDays(today, 2));

  const slash = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]);
    const year = slash[3] ? normalizeYear(Number(slash[3])) : today.getFullYear();
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
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!,.;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function validDate(year, month, day, today) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
  if (date < addDays(today, -1)) date.setFullYear(date.getFullYear() + 1);
  return formatISODate(date);
}
