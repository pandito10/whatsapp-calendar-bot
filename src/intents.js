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
      "mover mi cita", "quiero cambiar", "cambiar fecha", "cambiar la fecha",
      "otra hora", "otra fecha", "no puedo asistir", "no alcanzare"
    ])],
    ["late_arrival", () => hasAny(text, [
      "voy tarde", "llegare tarde", "llego tarde", "se me hizo tarde", "retraso",
      "atrasada", "atrasado", "demorada", "demorado", "no alcanzo a llegar"
    ])],
    ["confirm_appointment", () => hasAny(text, [
      "confirmada", "confirmar cita", "ya quedo", "quedo confirmada",
      "me confirmas", "tengo cita", "mi cita esta confirmada"
    ])],
    ["promo_validity", () => isPromoValidityQuestion(text)],
    ["promo_schedule", () => isPromoScheduleQuestion(text)],
    ["schedule_appointment", () => hasAny(text, [
      "agendar", "hacer cita", "sacar cita", "reservar", "quiero una cita",
      "necesito una cita", "necesito cita", "quiero cita", "agendar consulta",
      "necesito consulta", "quiero consultar", "apartar cita", "me urge una cita",
      "ocupo cita", "ocupo consulta", "me puedes agendar", "quiero apartar",
      "quiero reservar", "agenda para", "cita para", "sacar consulta",
      "reservar consulta"
    ]) || /^(?:una|un)?\s*(?:cita|consulta)\s*$/.test(text)],
    ["clinic_hours", () => isClinicHoursQuestion(text)],
    ["check_availability", () => isAvailabilityIntent(text)],
    ["patient_results", () => isPatientResultsRequest(text)],
    ["featured_promo", () => isFeaturedPromoQuestion(text)],
    ["cost", () => isPriceQuestion(text)],
    ["promotion", () => isPromotionQuestion(text)],
    ["payment_methods", () => isPaymentQuestion(text)],
    ["location", () => isLocationQuestion(text)],
    ["morning_hours", () => isMorningQuestion(text)],
    ["saturday", () => isWeekendQuestion(text)],
    ["appointment_preparation", () => isAppointmentPreparationQuestion(text)],
    ["appointment_duration", () => hasAny(text, [
      "duracion", "cuanto dura", "cuanto tiempo dura", "cuanto tiempo es",
      "cuanto tardan", "tardan", "40 minutos"
    ])],
    ["new_patient", () => hasAny(text, [
      "primera vez", "paciente nueva", "primera consulta", "nunca he ido",
      "nuevo paciente", "nueva paciente", "es mi primera vez", "soy nueva",
      "soy nuevo", "nunca fui", "voy por primera vez", "es primera vez"
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
      "atienden adolescentes", "revision de mamas", "chequeo de mamas",
      "mamas", "embarazo", "control de embarazo", "consulta ginecologica",
      "chequeo ginecologico", "paquete ginecologico"
    ])],
    ["insurance_network", () => isInsuranceQuestion(text)],
    ["appointment_requirements", () => hasAny(text, [
      "que necesito llevar", "tengo que llevar", "documentos", "identificacion",
      "estudios anteriores", "receta", "requisitos", "que debo llevar",
      "que llevo", "puedo ir acompanada", "puedo ir acompanado", "acompanada",
      "condiciones", "presentarse", "como presentarme", "preparacion",
      "indicaciones", "antes de la cita", "antes del estudio", "antes del papanicolaou",
      "puedo ir con regla", "estoy en mis dias", "menstruacion", "menstruando",
      "periodo menstrual", "regla", "puedo llevar acompanante", "puedo llevar a mi esposo",
      "puedo llevar a mi mama", "puedo ir con alguien"
    ])],
    ["invoice", () => hasAny(text, ["factura", "facturan", "facturar", "recibo", "comprobante"])],
    ["doctor_name", () => isDoctorNameQuestion(text)],
    ["contact_info", () => isContactInfoQuestion(text)],
    ["direct_contact", () => hasAny(text, [
      "hablar con alguien", "hablar con la doctora", "recepcion",
      "llamar", "me llamen", "me pueden llamar",
      "necesito hablar con alguien", "pasame con alguien", "humano",
      "pasa a una persona", "quiero hablar con una persona", "hablar con persona",
      "asesora", "secretaria", "no me entiendes", "me atiende alguien",
      "persona real", "atencion personalizada"
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
    xq: "porque",
    pq: "porque",
    kuanto: "cuanto",
    quanto: "cuanto",
    cuantoo: "cuanto",
    presio: "precio",
    presios: "precios",
    presioso: "precio",
    dondee: "donde",
    estan: "estan",
    stn: "estan",
    ubi: "ubicacion",
    ubicacionn: "ubicacion",
    tarjerta: "tarjeta",
    trasferencia: "transferencia",
    trasnferencia: "transferencia",
    tranferencia: "transferencia",
    depositar: "transferencia",
    ultrasonidoo: "ultrasonido",
    ultrasonidoos: "ultrasonido",
    ultrasonid: "ultrasonido",
    papanicolao: "papanicolaou",
    papanicolau: "papanicolaou",
    pap: "papanicolaou",
    papanicolauo: "papanicolaou",
    colposkopia: "colposcopia",
    kolposkopia: "colposcopia",
    colpo: "colposcopia",
    kanselar: "cancelar",
    canselar: "cancelar",
    cancelarrr: "cancelar",
    reagendr: "reagendar",
    camviar: "cambiar",
    nesesito: "necesito",
    ocupo: "necesito",
    urje: "urge",
    urgen: "urge",
    sangradoo: "sangrado",
    condisiones: "condiciones",
    condision: "condiciones",
    condicionez: "condiciones",
    condicion: "condiciones",
    presentarce: "presentarse",
    recomendasion: "recomendacion",
    informasion: "informacion",
    informasionn: "informacion",
    informacionn: "informacion",
    inf: "info",
    interesada: "interesa",
    interesado: "interesa",
    interezada: "interesa",
    interezado: "interesa",
    intereza: "interesa",
    interesaada: "interesa",
    prmocion: "promocion",
    promoicon: "promocion",
    promoion: "promocion",
    promcion: "promocion",
    promosion: "promocion",
    promosiones: "promocion",
    paqutte: "paquete",
    pquete: "paquete",
    pakete: "paquete",
    paqete: "paquete",
    paq: "paquete",
    chekeo: "chequeo",
    cheqeo: "chequeo",
    chequeoo: "chequeo",
    ginecologicoo: "ginecologico",
    ginecologicoa: "ginecologico",
    ginecologicaa: "ginecologica",
    completoo: "completo",
    docotra: "doctora",
    dctora: "doctora",
    dcotora: "doctora",
    secrtaria: "secretaria",
    asesora: "asesora",
    aseguranza: "aseguradora",
    aseguranzaa: "aseguradora",
    aseguranzaas: "aseguradora",
    seguroo: "seguro",
    orario: "horario",
    horaios: "horarios",
    orarios: "horarios",
    horaro: "horario",
    horaros: "horarios",
    habren: "abren",
    habre: "abre",
    oie: "oye",
    resuktados: "resultados",
    resutados: "resultados",
    resultdos: "resultados",
    examenes: "examenes",
    cooreo: "correo",
    correeo: "correo",
    coreo: "correo",
    gmail: "gmail",
    asta: "hasta"
  };
  return dictionary[word] ?? word;
}

function isAvailabilityIntent(text) {
  return (
    hasAny(text, [
      "horarios", "disponibilidad", "disponible", "citas disponibles", "que dias",
      "que horarios", "hay cita", "tienes lugar", "hay espacio", "tienen citas",
      "citas hoy", "citas manana", "que citas tienes", "cupos", "espacios",
      "lugar hoy", "lugar manana", "hay para hoy", "hay para manana",
      "fechas disponibles", "dias disponibles", "que fechas tienes",
      "que lugares tienes", "que tienes disponible", "que tienes libre",
      "a ver horarios", "a ver fechas", "a ver disponibilidad", "a ver"
    ]) ||
    /\b(?:hay|tienes|tienen)\s+(?:lugar|espacio|cita|horario|disponible)\b/.test(text) ||
    looksLikeDateRequest(text)
  );
}

function isLocationQuestion(text) {
  return (
    /\b(?:ubicacion|ubicados|direccion|donde estan|donde se ubican|como llego|como llegar|plaza de la paz|consultorio)\b/.test(text) ||
    /\b(?:maps|google maps|mapa|referencia|referencias|estacionamiento|plaza mayor)\b/.test(text) ||
    /\b(?:mandame|manda|pasame|pasa|me pasas)\s+(?:la\s+)?(?:ubicacion|direccion|mapa)\b/.test(text)
  );
}

function isClinicHoursQuestion(text) {
  return (
    /\b(?:horario de atencion|horarios de atencion|dias de atencion|dias atienden|dias trabajan|que dias atienden|que dias trabajan)\b/.test(text) ||
    /\b(?:a que hora|que hora|cuando)\s+(?:atienden|abren|cierran|trabajan)\b/.test(text) ||
    /\b(?:atienden|abren|cierran|trabajan)\s+(?:hoy|manana|por la tarde|en la tarde|entre semana|lunes|martes|miercoles|jueves|viernes)\b/.test(text) ||
    /\b(?:lunes a viernes|entre semana|horario del consultorio|horario consultorio)\b/.test(text)
  );
}

function isGreetingQuestion(text) {
  return /^(?:hola|ola|hoola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|hello|hi|que tal|que onda|hola buenas|disculpa)$/.test(text);
}

function isConversationClosing(text) {
  return /^(?:gracias|muchas gracias|ok gracias|okay gracias|listo gracias|perfecto gracias|esta bien gracias|sale gracias|va gracias|ya gracias|no gracias|por ahora no|seria todo|eso es todo|listo|ok|okay|va|sale|perfecto|todo bien|esta bien|si esta bien|si esta correcto|todo esta bien|ok esta bien|okay esta bien|de acuerdo|entendido|quedo bien|queda bien|asi esta bien|muchas gracias eso es todo|gracias eso seria todo)$/.test(text) ||
    /\b(?:ya tengo|ya quedo|ya esta)\s+(?:mi\s+)?cita\b.*\b(?:gracias|listo|perfecto|ok|sale)\b/.test(text);
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

function isAppointmentPreparationQuestion(text) {
  return (
    hasAny(text, [
      "condiciones", "presentarse", "como presentarme", "prepararme",
      "preparacion", "indicaciones", "recomendacion", "recomendaciones",
      "antes de la cita", "antes del estudio", "antes del papanicolaou",
      "antes del pap", "que tengo que hacer antes", "como voy preparada",
      "como debo presentarme", "como tengo que ir", "que condiciones hay",
      "en que condiciones tengo que ir", "en que condiciones hay que presentarse",
      "como debo ir", "como me presento", "en que condiciones",
      "puedo ir con regla", "estoy en mis dias", "ando en mis dias",
      "estoy menstruando", "menstruacion", "periodo menstrual",
      "puedo llevar acompanante", "puedo ir acompanada", "puedo ir con alguien"
    ]) ||
    (
      hasAny(text, ["cuanto tardan", "cuanto se tardan", "cuanto dura", "duracion", "40 minutos"]) &&
      hasAny(text, ["requisitos", "condiciones", "presentarse", "preparacion", "indicaciones"])
    )
  );
}

function isPriceQuestion(text) {
  return /\b(?:cuanto cuesta|costo|precio|costos|precios|cuanto cobran|cuanto sale|cuanto vale|en cuanto esta|cuanto es|cuanto seria|cuanto cobra|cuanto vale la consulta|valor|tarifa)\b/.test(text);
}

function isPromotionQuestion(text) {
  if (/\b(?:promocion|promosion|promo|oferta)\b/.test(text)) return true;
  if (/\b(?:paquete(?:\s+promocional)?)\b/.test(text)) return true;
  if (/\b(?:sigue la promo|siguen con la promo|todavia tienen promo|aun tienen promo|tienen promo|tiene promo)\b/.test(text)) return true;
  return false;
}

function isPaymentQuestion(text) {
  return /\b(?:tarjeta|credito|debito|transferencia|efectivo|pago|formas de pago|forma de pago|metodos de pago|pagar con tarjeta|pagar con transferencia|pagar efectivo|deposito|depositar|terminal|clip|mercado pago|cuenta bancaria)\b/.test(text);
}

function isInsuranceQuestion(text) {
  return /\b(?:seguro|aseguradora|aseguradoras|red medica|redes medicas|particular|convenio|convenios|gastos medicos|medica|medico)\b/.test(text) &&
    /\b(?:aceptan|manejan|trabajan|tienen|puedo|consulta|pagar|voy|ir|es por|soy|red|seguro|aseguradora|particular)\b/.test(text);
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
  return /\b(?:menu general|info general|dudas|preguntas|opciones|ayuda)\b/.test(text);
}

function isFeaturedPromoQuestion(text) {
  // Specific promo campaign triggers
  if (hasAny(text, [
    "vi el anuncio", "vi la promo", "vi la publicacion", "vi el post",
    "vi su anuncio", "vi su publicacion", "vi una publicacion",
    "me salio el anuncio", "me salio su anuncio", "vengo del anuncio",
    "facebook", "instagram", "meta ads", "meta ad",
    "me interesa la promo", "me interesa el paquete", "me interesa informacion",
    "me podria brindar informacion", "me podrias brindar informacion",
    "me das informacion", "me puedes dar informacion", "me puedes dar mas informacion",
    "me mandas informacion", "me puedes mandar informacion",
    "me envias informacion", "me puedes enviar informacion", "quiero mas informacion",
    "quiero saber mas", "quisiera informacion", "ocupo informacion",
    "chequeo ginecologico", "chequeo completo", "paquete ginecologico",
    "chequeo ginecologico completo", "chequeo integral", "revision completa",
    "consulta completa", "paquete completo", "paquete integral",
    "consulta con ultrasonido", "papanicolaou precio", "ultrasonido precio",
    "el de 1200", "los 1200", "cuanto incluye", "que incluye el paquete",
    "informacion de la promo", "info de la promo",
    "promocion del anuncio", "paquete del anuncio", "chequeo de 1200",
    "promo 1200", "promocion 1200", "paquete 1200", "consulta de 1200",
    "chequeo completo 1200", "que incluye la promo", "que trae la promo",
    "que contiene la promo", "que tiene la promo", "que incluye promocion",
    "que incluye el chequeo", "que trae el chequeo", "que contiene el paquete"
  ])) return true;

  if (/^(?:me interesa|interesa|quiero informacion|quiero info|mas informacion|mas info|informacion|info|informes|precio|costo)$/.test(text)) return true;

  if (
    /\b(?:me|nos)\s+(?:podria|podrias|puede|puedes|pasa|pasas|da|das|dar|manda|mandas|mandar|envia|envias|enviar|brinda|brindas)\s+(?:mas\s+)?(?:info|informacion|informes)\b/.test(text)
  ) return true;

  // "que incluye / que trae / de que se trata" without a specific non-promo service = asking about promo
  if (
    /\b(?:que incluye|que trae|que tiene|de que trata|de que se trata|en que consiste|que contiene|que viene incluido|que lleva)\b/.test(text) &&
    !/\b(?:ultrasonido|papanicolaou|colposcopia|prenatal|consulta general)\b/.test(text)
  ) return true;

  // Price anchors for the promo
  if (/\b1200\b/.test(text)) return true;

  // Short ad lead replies often arrive like this.
  if (/^(?:informes|info|mas info|informacion)$/.test(text)) return true;

  return false;
}

function isPromoValidityQuestion(text) {
  const asksUntilWhen = /\b(?:hasta cuando|hasta que fecha|cuando termina|cuando acaba|cuando se acaba|cuando vence|fecha limite|fecha de vencimiento|cuando deja de estar|cuando ya no|vigencia)\b/.test(text);
  if (!asksUntilWhen) return false;
  return /\b(?:promocion|promosion|promo|paquete|oferta)\b/.test(text) || hasAny(text, ["1200", "chequeo"]);
}

function isPromoScheduleQuestion(text) {
  return (
    /\b(?:agendar|agenda|cita|apartar|reservar)\b/.test(text) &&
    /\b(?:promo|promocion|paquete|1200|chequeo ginecologico|chequeo completo|papanicolaou|ultrasonido pelvico)\b/.test(text)
  );
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

function isDoctorNameQuestion(text) {
  return (
    /\b(?:como se llama|cual es el nombre|quien es)\b.*\b(?:doctor|doctora|medico|medica|ginecologo|ginecologa)\b/.test(text) ||
    /\b(?:nombre)\b.*\b(?:doctor|doctora|medico|medica)\b/.test(text) ||
    /^(?:como se llama la doctora|como se llama el doctor|quien es la doctora|quien es el doctor)$/.test(text)
  );
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
