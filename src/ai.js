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
  const wantsAvailability = isAvailabilityQuestion(text) || Boolean(preferredDateISO);
  const detectedIntent = detectLocalIntent(text);

  return {
    intent: selectedSlotIndex ? "select_slot" : detectedIntent !== "fallback" ? detectedIntent : wantsAvailability ? "check_availability" : detectedIntent,
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

function detectLocalIntent(text) {
  const checks = [
    ["medical_urgent", () => hasAny(text, ["urgente", "emergencia", "dolor fuerte", "mucho dolor", "sangrado", "fiebre", "desmayo", "desmaye", "embarazo", "me siento mal", "me duele mucho"])],
    ["cancel_appointment", () => hasAny(text, ["cancelar", "cancelar cita", "quiero cancelar", "necesito cancelar", "no podre ir", "no puedo ir", "cancelar consulta"])],
    ["reschedule_appointment", () => hasAny(text, ["reagendar", "cambiar cita", "cambiar mi cita", "mover cita", "cambiar horario", "otro horario", "otro dia", "no puedo ese dia"])],
    ["late_arrival", () => hasAny(text, ["voy tarde", "llegare tarde", "llego tarde", "retraso", "atrasada", "atrasado", "demorada", "demorado"])],
    ["confirm_appointment", () => hasAny(text, ["confirmada", "confirmar cita", "ya quedo", "tengo cita", "me confirmas"])],
    ["book_appointment", () => hasAny(text, ["agendar", "hacer cita", "sacar cita", "reservar", "quiero una cita", "necesito una cita", "ocupo cita", "quiero cita", "agendar consulta", "necesito consulta", "quiero consultar"])],
    ["check_availability", () => isAvailabilityQuestion(text)],
    ["cost", () => hasAny(text, ["costo", "precio", "cuanto cuesta", "cuanto cobran", "cuanto sale", "cuanto vale", "en cuanto esta", "presio"])],
    ["promotion", () => hasAny(text, ["promo", "promocion", "promosion", "paquete", "oferta"])],
    ["payment_methods", () => hasAny(text, ["tarjeta", "tarjerta", "credito", "debito", "transferencia", "trasferencia", "efectivo", "formas de pago", "metodos de pago"])],
    ["location", () => hasAny(text, ["ubicacion", "ubi", "direccion", "donde estan", "como llego", "plaza de la paz", "consultorio"])],
    ["morning_hours", () => isMorningIntent(text)],
    ["saturday", () => hasAny(text, ["sabado", "sabados", "fin de semana", "domingo"])],
    ["appointment_duration", () => hasAny(text, ["duracion", "cuanto dura", "cuanto tiempo", "tardan", "40 minutos"])],
    ["new_patient", () => hasAny(text, ["primera vez", "paciente nueva", "primera consulta", "nunca he ido", "nuevo paciente", "nueva paciente"])],
    ["medical_services", () => hasAny(text, ["ultrasonido", "papanicolaou", "papanicolau", "colposcopia", "estudio", "estudios", "servicios", "que incluye"])],
    ["medication_question", () => hasAny(text, ["medicamento", "que tomo", "receta", "tratamiento", "infeccion", "pastilla", "medicina", "me puede recetar"])],
    ["appointment_requirements", () => hasAny(text, ["llevar", "documentos", "identificacion", "estudios anteriores", "receta", "requisitos", "que llevo"])],
    ["invoice", () => hasAny(text, ["factura", "facturan", "facturar", "recibo", "comprobante"])],
    ["direct_contact", () => hasAny(text, ["persona", "doctora", "recepcion", "telefono", "contacto", "hablar con alguien", "llamar", "me llamen"])],
    ["greeting", () => /^(?:hola|ola|hoola|buenas|buenos dias|buen dia|buenas tardes|que tal|informes|disculpa|hola buenas)$/.test(text)],
    ["closing", () => /^(?:gracias|muchas gracias|ok gracias|listo|perfecto|no gracias|eso es todo|sale gracias|va gracias|esta bien)$/.test(text)]
  ];

  for (const [intent, matches] of checks) {
    if (matches()) return intent;
  }

  return "fallback";
}

function isAvailabilityQuestion(text) {
  return (
    /\b(?:disponible|disponibles|disponibilidad|horarios|dias tienes|que dias|que horarios|cuando tienes|cuando hay|hay cita|tienes lugar|hay espacio|citas disponibles)\b/.test(text) ||
    /\b(?:que|cuales)\s+(?:dias|horarios)\b/.test(text)
  );
}

function isMorningIntent(text) {
  return (
    /\b(?:temprano|matutino|citas temprano|horario en la manana|consulta en la manana)\b/.test(text) ||
    (/\bmanana\b/.test(text) && /\b(?:por la manana|en la manana|consulta|atienden|abren|horario matutino|temprano)\b/.test(text))
  );
}

function hasAny(text, needles) {
  return needles.some((needle) => text.includes(needle));
}

function parseSlotSelection(text) {
  const exact = text.match(/^\s*([1-9])\s*$/);
  if (exact) return Number(exact[1]);

  const option = text.match(/\b(?:opcion|numero|horario)\s*([1-9])\b/);
  return option ? Number(option[1]) : undefined;
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
