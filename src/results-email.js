const RESULT_ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

const RESULT_ALLOWED_EXTENSIONS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);

export function isValidPatientEmail(value) {
  const email = String(value ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function maskEmail(value) {
  const email = String(value ?? "").trim();
  const at = email.indexOf("@");
  if (at <= 0) return "";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return "";
  return `${local[0]}***@${domain}`;
}

export function extractLatestPatientEmailFromMessages(messages = []) {
  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const list = Array.isArray(messages) ? messages : [];

  for (const message of [...list].reverse()) {
    const body = String(message?.body ?? message?.text ?? "");
    const matches = body.match(emailRegex) ?? [];
    const validEmail = matches.map((match) => match.trim().toLowerCase()).find(isValidPatientEmail);
    if (validEmail) return validEmail;
  }

  return "";
}

export function resolveResultsEmailRecipient({ appointment, conversation } = {}) {
  const appointmentEmail = String(appointment?.patientEmail ?? conversation?.appointment?.patientEmail ?? "")
    .trim()
    .toLowerCase();
  if (appointmentEmail) {
    return { email: appointmentEmail, source: "appointment" };
  }

  const sessionEmail = String(conversation?.session?.email ?? conversation?.patientEmail ?? "")
    .trim()
    .toLowerCase();
  if (sessionEmail) {
    return { email: sessionEmail, source: "conversation" };
  }

  const messageEmail = extractLatestPatientEmailFromMessages(conversation?.messages ?? []);
  if (messageEmail) {
    return { email: messageEmail, source: "conversation" };
  }

  return { email: "", source: "missing" };
}

export function sanitizeResultNote(value, maxLength = 600) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

export function validateResultsEmailAttachment(file, maxBytes) {
  if (!file || !file.size) {
    return "Adjunta un archivo PDF, JPG, PNG o WEBP.";
  }

  if (file.size > maxBytes) {
    return `El archivo supera el limite de ${formatBytes(maxBytes)}.`;
  }

  const contentType = String(file.contentType ?? "").toLowerCase();
  const filename = String(file.filename ?? "").toLowerCase();
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  const typeAllowed = RESULT_ALLOWED_TYPES.has(contentType);
  const extensionAllowed = RESULT_ALLOWED_EXTENSIONS.has(extension);

  if (!typeAllowed && !(contentType === "application/octet-stream" && extensionAllowed)) {
    return "Archivo no permitido. Solo se aceptan PDF, JPG, PNG o WEBP.";
  }

  if (!extensionAllowed && contentType === "application/octet-stream") {
    return "Archivo no permitido. Solo se aceptan PDF, JPG, PNG o WEBP.";
  }

  return undefined;
}

export function validateResultsEmailRequest({ patientEmail, file, confirmed, maxBytes }) {
  if (!patientEmail) {
    return "Esta paciente no tiene correo confirmado.";
  }

  if (!isValidPatientEmail(patientEmail)) {
    return "El correo confirmado de la paciente no es valido.";
  }

  const fileError = validateResultsEmailAttachment(file, maxBytes);
  if (fileError) return fileError;

  if (!confirmed) {
    return "Confirma que este archivo corresponde a esta paciente y que el correo fue confirmado.";
  }

  return undefined;
}

export function buildResultsEmailAuditText({ email, filename }) {
  return `Resultado enviado por correo a ${maskEmail(email)}. Archivo: ${String(filename ?? "archivo").slice(0, 160)}`;
}

export function buildResultsEmailMessageMetadata({ email, filename }) {
  return {
    source: "inbox_results_email",
    emailMasked: maskEmail(email),
    filename: String(filename ?? "archivo").slice(0, 160)
  };
}

export function buildResultSentWhatsAppNotice() {
  return "Tus resultados fueron enviados al correo confirmado. Por favor revisa bandeja de entrada y spam.";
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${Math.round((value / 1024 / 1024) * 10) / 10} MB`;
}
