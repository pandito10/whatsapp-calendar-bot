export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!,.;:()[\]{}"']/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(normalizeWhatsAppWord)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function detectIntent(value) {
  const text = normalizeText(value);
  const checks = [
    ["medical_urgent", () => hasAny(text, [
      "urgente", "emergencia", "dolor fuerte", "mucho dolor", "sangrado abundante",
      "tengo sangrado", "estoy sangrando", "fiebre", "desmayo", "desmaye",
      "embarazada y me siento mal", "embarazo con dolor", "me siento muy mal",
      "me siento mal", "me duele mucho", "dolor intenso"
    ])],
    ["cancel_appointment", () => isCancellationRequest(text)],
    ["reschedule_appointment", () => hasAny(text, [
      "reagendar", "cambiar cita", "mover cita", "cambiar horario", "otro horario",
      "otro dia", "no puedo ese dia", "cambiar mi cita", "cambiar consulta",
      "mover mi cita", "quiero cambiar"
    ])],
    ["late_arrival", () => hasAny(text, [
      "voy tarde", "llegare tarde", "llego tarde", "se me hizo tarde", "retraso",
      "atrasada", "atrasado", "demorada", "demorado", "no alcanzo a llegar"
    ])],
    ["confirm_appointment", () => hasAny(text, [
      "confirmada", "confirmar cita", "ya quedo", "quedo confirmada",
      "me confirmas", "tengo cita", "mi cita esta confirmada"
    ])],
    ["appointment_link", () => isAppointmentLinkQuestion(text)],
    ["schedule_appointment", () => hasAny(text, [
      "agendar", "hacer cita", "sacar cita", "reservar", "quiero una cita",
      "necesito una cita", "ocupo cita", "quiero cita", "agendar consulta",
      "necesito consulta", "quiero consultar", "apartar cita", "me urge una cita"
    ])],
    ["check_availability", () => isAvailabilityIntent(text)],
    ["cost", () => isPriceQuestion(text)],
    ["promotion", () => isPromotionQuestion(text)],
    ["payment_methods", () => isPaymentQuestion(text)],
    ["location", () => isLocationQuestion(text)],
    ["morning_hours", () => isMorningQuestion(text)],
    ["saturday", () => isWeekendQuestion(text)],
    ["appointment_duration", () => hasAny(text, [
      "duracion", "cuanto dura", "cuanto tiempo dura", "cuanto tiempo es",
      "cuanto tardan", "tardan", "40 minutos"
    ])],
    ["new_patient", () => hasAny(text, [
      "primera vez", "paciente nueva", "primera consulta", "nunca he ido",
      "nuevo paciente", "nueva paciente", "es mi primera vez"
    ])],
    ["medication_question", () => hasAny(text, [
      "medicamento", "que medicamento tomo", "me puedo tomar algo",
      "que me recomienda tomar", "me receta algo", "tengo infeccion",
      "dolor que tomo", "que pastilla tomo", "me puede recetar", "ocupo medicina",
      "tratamiento"
    ])],
    ["medical_services", () => hasAny(text, [
      "ultrasonido", "papanicolaou", "papanicolau", "papanicolao",
      "colposcopia", "estudio", "estudios", "servicios", "que incluye",
      "control prenatal", "embarazadas", "atienden embarazadas", "adolescentes",
      "atienden adolescentes"
    ])],
    ["appointment_requirements", () => hasAny(text, [
      "que necesito llevar", "tengo que llevar", "documentos", "identificacion",
      "estudios anteriores", "receta", "requisitos", "que debo llevar",
      "que llevo", "puedo ir acompanada", "puedo ir acompanado", "acompanada"
    ])],
    ["invoice", () => hasAny(text, ["factura", "facturan", "facturar", "recibo", "comprobante"])],
    ["direct_contact", () => hasAny(text, [
      "hablar con alguien", "hablar con la doctora", "persona", "recepcion",
      "telefono", "contacto", "llamar", "me llamen", "me pueden llamar",
      "ocupo hablar con alguien", "pasame con alguien", "humano"
    ])],
    ["greeting", () => isGreetingQuestion(text) || isGeneralMenuQuestion(text)],
    ["closing", () => isConversationClosing(text)]
  ];

  for (const [intent, matches] of checks) {
    if (matches()) return { intent, confidence: 0.9, normalizedText: text, category: intent };
  }

  return { intent: "fallback", confidence: 0.2, normalizedText: text, category: guessCategory(text) };
}

export function hasAny(text, needles) {
  return needles.some((needle) => (needle instanceof RegExp ? needle.test(text) : text.includes(needle)));
}

export function isAppointmentLikeQuestion(text) {
  const normalized = normalizeText(text);
  return /\b(?:cita|agendar|agenda|horario|disponible|disponibilidad|cancelar|reagendar)\b/.test(normalized) || looksLikeDateRequest(normalized);
}

export function looksLikeDateRequest(text) {
  const normalized = normalizeText(text);
  return (
    /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/.test(normalized) ||
    /\b\d{1,2}(?:\s+de)?\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de\s+)?\d{2,4})?\b/.test(normalized) ||
    /\b(?:hoy|manana|pasado manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(normalized)
  );
}

export function meaningfulWords(text) {
  const stopWords = new Set(["hola", "buenas", "que", "como", "para", "con", "una", "uno", "los", "las", "del", "por", "favor", "tengo", "quiero", "puedo"]);
  return [...new Set(normalizeText(text).split(" ").filter((word) => word.length >= 4 && !stopWords.has(word)))].slice(0, 8);
}

function normalizeWhatsAppWord(word) {
  const dictionary = {
    kiero: "quiero",
    qiero: "quiero",
    q: "que",
    ke: "que",
    k: "que",
    kuanto: "cuanto",
    quanto: "cuanto",
    cuantoo: "cuanto",
    presio: "precio",
    presios: "precios",
    dondee: "donde",
    estan: "estan",
    stn: "estan",
    ubi: "ubicacion",
    ubicacionn: "ubicacion",
    tarjerta: "tarjeta",
    trasferencia: "transferencia",
    ultrasonidoo: "ultrasonido",
    papanicolao: "papanicolaou",
    papanicolau: "papanicolaou",
    colposkopia: "colposcopia",
    kolposkopia: "colposcopia",
    kanselar: "cancelar",
    canselar: "cancelar",
    cancelarrr: "cancelar",
    reagendr: "reagendar",
    camviar: "cambiar",
    nesesito: "necesito",
    ocupo: "necesito",
    urje: "urge",
    urgen: "urge",
    sangradoo: "sangrado"
  };
  return dictionary[word] ?? word;
}

function isAvailabilityIntent(text) {
  return (
    hasAny(text, [
      "horarios", "disponibilidad", "disponible", "citas disponibles", "que dias",
      "que horarios", "hay cita", "tienes lugar", "hay espacio", "tienen citas",
      "citas hoy", "citas manana", "que citas tienes"
    ]) ||
    /\b(?:hay|tienes|tienen)\s+(?:lugar|espacio|cita|horario|disponible)\b/.test(text) ||
    looksLikeDateRequest(text)
  );
}

function isLocationQuestion(text) {
  return (
    /\b(?:ubicacion|ubicados|direccion|donde estan|donde se ubican|como llego|como llegar|plaza de la paz|consultorio)\b/.test(text) ||
    /\b(?:mandame|manda|pasame|pasa|me pasas)\s+(?:la\s+)?(?:ubicacion|direccion)\b/.test(text)
  );
}

function isGreetingQuestion(text) {
  return /^(?:hola|ola|hoola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|hello|hi|que tal|que onda|hola buenas|disculpa|informes)$/.test(text);
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

function isWeekendQuestion(text) {
  return /\b(?:sabado|sabados|fin de semana|domingo|domingos)\b/.test(text);
}

function isPriceQuestion(text) {
  return /\b(?:cuanto cuesta|costo|precio|costos|precios|cuanto cobran|cuanto sale|cuanto vale|en cuanto esta|cuanto es)\b/.test(text);
}

function isPromotionQuestion(text) {
  return /\b(?:promocion|promosion|paquete|promo|oferta|sigue la promo|todavia tienen promo)\b/.test(text);
}

function isPaymentQuestion(text) {
  return /\b(?:tarjeta|credito|debito|transferencia|efectivo|pago|formas de pago|forma de pago|metodos de pago|pagar con tarjeta|pagar con transferencia|pagar efectivo)\b/.test(text);
}

function isAppointmentLinkQuestion(text) {
  return (
    /\b(?:link|liga|enlace)\b/.test(text) &&
      /\b(?:reserva|reservar|cita|agenda|horario|google|calendar|calendario)\b/.test(text)
  ) ||
    /\b(?:agenda online|agenda en linea|reserva online|reserva en linea|reservar directo|reservar yo|reservar por google|google calendar|calendario de google)\b/.test(text);
}

function isGeneralMenuQuestion(text) {
  return /\b(?:menu|info|informacion|informes|dudas|preguntas|opciones|ayuda)\b/.test(text);
}

function guessCategory(text) {
  if (hasAny(text, ["dolor", "sangrado", "embarazo", "fiebre"])) return "posible_urgencia";
  if (hasAny(text, ["servicio", "estudio", "ultra", "papan", "colpo"])) return "servicios";
  if (hasAny(text, ["pago", "tarjeta", "transferencia", "efectivo"])) return "formas_pago";
  if (hasAny(text, ["cita", "agenda", "horario"])) return "agenda";
  return "desconocido";
}
