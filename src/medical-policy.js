export const RESULTS_PRIVACY_TEXT =
  "Por privacidad, los resultados o estudios se entregan únicamente por el correo confirmado de la paciente o de forma presencial. Por WhatsApp solo podemos registrar tu solicitud y pasarla a revisión humana.";

export const MEDICAL_CHAT_SAFE_TEXT =
  "Por seguridad, este chat no da diagnóstico, receta ni interpretación de resultados. Una persona del consultorio puede revisar tu mensaje o puedes agendar cita con la doctora.";

export const MEDICAL_URGENCY_TEXT =
  "Si presentas dolor intenso, sangrado abundante, fiebre, desmayo o emergencia, acude a urgencias.";

export const MEDICAL_ATTACHMENT_BLOCK_ERROR =
  "Para proteger la privacidad, los estudios/resultados deben enviarse por correo confirmado o entregarse presencialmente, no por WhatsApp.";

export const INBOX_ATTACHMENT_EMAIL_ONLY_ERROR =
  "Los archivos, fotos y documentos ya no se envian por WhatsApp. Usa la seccion \"Enviar archivo por correo confirmado\" en la ficha de la paciente.";

export const MEDICAL_FAQ_BLOCK_ERROR =
  "Esta FAQ toca un tema médico sensible y debe pasar a humano.";

export const PRIVACY_CONSENT_TEXT =
  "Al continuar, aceptas que usemos tus datos de contacto para gestionar tu cita conforme al aviso de privacidad del consultorio.";

const SENSITIVE_MEDICAL_PATTERNS = [
  "diagnostico",
  "diagnosticos",
  "receta",
  "recetar",
  "medicamento",
  "medicamentos",
  "tratamiento",
  "tratamientos",
  "infeccion",
  "embarazo",
  "embarazada",
  "sangrado",
  "dolor fuerte",
  "dolor intenso",
  "resultados",
  "resultado",
  "estudios",
  "estudio",
  "relaciones sexuales",
  "papanicolaou",
  "papanicolau",
  "colposcopia",
  "ultrasonido",
  "analisis",
  "analisis clinico",
  "examen",
  "examenes"
];

const RESULT_ATTACHMENT_PATTERNS = [
  "resultado",
  "resultados",
  "estudio",
  "estudios",
  "examen",
  "examenes",
  "papanicolaou",
  "papanicolau",
  "ultrasonido",
  "colposcopia",
  "diagnostico",
  "analisis"
];

const MEDICAL_ATTACHMENT_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);

const MEDICAL_ATTACHMENT_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp", ".doc", ".docx"]);

export function normalizePolicyText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@._-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsSensitiveMedicalTopic(value) {
  const text = normalizePolicyText(value);
  if (!text) return false;
  return SENSITIVE_MEDICAL_PATTERNS.some((pattern) => text.includes(pattern));
}

export function isMedicalFaqAutoReplyBlocked({ question, answer, action }) {
  if (action === "human_handoff") return false;
  return containsSensitiveMedicalTopic(`${question ?? ""} ${answer ?? ""}`);
}

export function isMedicalAttachment(file) {
  if (!file) return false;
  const contentType = String(file.contentType ?? "").toLowerCase();
  const filename = String(file.filename ?? "").toLowerCase();
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  return MEDICAL_ATTACHMENT_TYPES.has(contentType) || MEDICAL_ATTACHMENT_EXTENSIONS.has(extension);
}

export function shouldBlockMedicalWhatsAppAttachment({ message, tags = [], file }) {
  if (!isMedicalAttachment(file)) return false;

  const normalizedTags = new Set(
    (Array.isArray(tags) ? tags : [])
      .map((tag) => normalizePolicyText(tag))
      .filter(Boolean)
  );
  if (normalizedTags.has("resultados") || normalizedTags.has("estudios") || normalizedTags.has("humano requerido")) {
    return true;
  }

  const text = normalizePolicyText(message);
  return RESULT_ATTACHMENT_PATTERNS.some((pattern) => text.includes(pattern));
}

export function buildPatientResultsHumanNote() {
  return [
    "Solicitud de resultados/estudios.",
    "Verificar identidad de la paciente, correo confirmado y archivo aprobado por el consultorio.",
    "No enviar resultados, estudios, diagnosticos ni interpretaciones por WhatsApp."
  ].join(" ");
}

export function buildMedicalPolicyWarnings(config) {
  const warnings = [];
  if (config.nodeEnv !== "production") return warnings;

  if (!config.whatsappAppSecret) warnings.push("WHATSAPP_APP_SECRET falta en produccion.");
  if (!config.requireWebhookSignature) warnings.push("REQUIRE_WEBHOOK_SIGNATURE debe ser true en produccion.");
  if (config.allowUnsignedWebhooks) warnings.push("ALLOW_UNSIGNED_WEBHOOKS debe ser false en produccion.");
  if (config.inboxAllowLegacyTokenAccess) warnings.push("INBOX_ALLOW_LEGACY_TOKEN_ACCESS debe ser false en produccion.");
  if (config.forwardConversationBodies) warnings.push("FORWARD_CONVERSATION_BODIES debe ser false en produccion.");
  if (config.includeSensitiveAppointmentNotes) warnings.push("INCLUDE_SENSITIVE_APPOINTMENT_NOTES debe ser false en produccion.");
  if (!config.maskPatientPhoneInCalendar) warnings.push("MASK_PATIENT_PHONE_IN_CALENDAR debe ser true en produccion.");
  if (config.includePatientContactInCalendar) warnings.push("INCLUDE_PATIENT_CONTACT_IN_CALENDAR debe ser false en produccion.");

  return warnings;
}
