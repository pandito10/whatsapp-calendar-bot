export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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
    ["recent_sex_before_exam", () => isRecentSexBeforeExamQuestion(text)],
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
    ["schedule_appointment", () => hasAny(text, [
      "agendar", "hacer cita", "sacar cita", "reservar", "quiero una cita",
      "necesito una cita", "necesito cita", "quiero cita", "agendar consulta",
      "necesito consulta", "quiero consultar", "apartar cita", "me urge una cita"
    ])],
    ["check_availability", () => isAvailabilityIntent(text)],
    ["patient_results", () => isPatientResultsRequest(text)],
    ["featured_promo", () => isFeaturedPromoQuestion(text)],
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
      "dolor que tomo", "que pastilla tomo", "me puede recetar", "necesito medicina",
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
    ["contact_info", () => isContactInfoQuestion(text)],
    ["direct_contact", () => hasAny(text, [
      "hablar con alguien", "hablar con la doctora", "recepcion",
      "llamar", "me llamen", "me pueden llamar",
      "necesito hablar con alguien", "pasame con alguien", "humano",
      "pasa a una persona", "quiero hablar con una persona", "hablar con persona"
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
  return /^(?:hola|ola|hoola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|hello|hi|que tal|que onda|hola buenas|disculpa)$/.test(text);
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
    /\b(?:temprano|matutino|citas temprano)\b/.test(text) ||
    /\b(?:horario en la manana|consulta en la manana|atienden en la manana|abren en la manana|en la manana|por la manana)\b/.test(text) ||
    (/\bmanana\b/.test(text) && /\b(?:atienden|abren|horario matutino|temprano|por la manana|en la manana)\b/.test(text))
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

function isPatientResultsRequest(text) {
  if (/\b(?:que|cuales)\s+(?:estudios|servicios)\b/.test(text)) return false;
  if (/\b(?:hacen|tienen|ofrecen|realizan)\s+(?:ultrasonido|papanicolaou|papanicolau|papanicolao|colposcopia|estudios|servicios)\b/.test(text)) {
    return false;
  }

  const mentionsDocument = /\b(?:resultado|resultados|estudio|estudios|examen|examenes|analisis|diagnostico|diagnosticos|reporte|reportes|archivo|archivos|documento|documentos)\b/.test(text);
  if (!mentionsDocument) return false;

  return (
    /\b(?:mi|mis|mio|mia|mandame|mandar|manda|mandan|manden|enviar|envia|envian|entregar|entregan|pasame|pasa|subir|subieron|listo|listos|salio|salieron|recoger|consultar|ver)\b/.test(text) ||
    /\b(?:resultado|resultados|diagnostico|diagnosticos|examen|examenes|analisis)\b/.test(text)
  );
}

function isGeneralMenuQuestion(text) {
  return /\b(?:menu|informacion|dudas|preguntas|opciones|ayuda)\b/.test(text);
}

function isFeaturedPromoQuestion(text) {
  // Specific promo campaign triggers
  if (hasAny(text, [
    "vi el anuncio", "vi la promo", "vi la publicacion", "vi el post",
    "facebook", "instagram", "meta ads", "meta ad",
    "me interesa la promo", "me interesa el paquete",
    "chequeo ginecologico", "chequeo completo", "paquete ginecologico",
    "consulta con ultrasonido", "papanicolaou precio", "ultrasonido precio",
    "el de 1200", "los 1200", "cuanto incluye", "que incluye el paquete"
  ])) return true;

  // Price anchors for the promo
  if (/\b1200\b/.test(text)) return true;

  // Only "informes" alone should trigger this (not as part of other phrases)
  if (/^informes$/.test(text)) return true;

  return false;
}

function isRecentSexBeforeExamQuestion(text) {
  const mentionsSex = hasAny(text, [
    "tuve relaciones", "tuve sexo", "relaciones hoy", "relaciones ayer",
    "sexo hoy", "sexo anoche", "relaciones anoche", "relaciones antes",
    "puedo hacerme el papanicolaou si tuve relaciones",
    "afecta si tuve relaciones", "relaciones antes del papanicolaou",
    "relaciones con condon", "relaciones sin proteccion",
    "tuve relaciones con", "si tuve relaciones"
  ]);
  return mentionsSex;
}

function isContactInfoQuestion(text) {
  // Questions asking for phone/contact info but NOT asking to speak to a human
  const wantsContact = hasAny(text, [
    "me pasas el telefono", "me pasas el numero", "me das el numero",
    "cual es el telefono", "cual es el numero", "numero de telefono",
    "me das un numero", "contacto del consultorio", "como los contacto"
  ]);
  const wantsPhone = /^(?:telefono|numero|contacto|contactame)$/.test(text);
  return wantsContact || wantsPhone;
}

function guessCategory(text) {
  if (hasAny(text, ["dolor", "sangrado", "embarazo", "fiebre"])) return "posible_urgencia";
  if (hasAny(text, ["resultado", "resultados", "diagnostico", "diagnosticos", "examen", "examenes", "analisis"])) return "resultados";
  if (hasAny(text, ["servicio", "estudio", "ultra", "papan", "colpo"])) return "servicios";
  if (hasAny(text, ["pago", "tarjeta", "transferencia", "efectivo"])) return "formas_pago";
  if (hasAny(text, ["cita", "agenda", "horario"])) return "agenda";
  return "desconocido";
}
