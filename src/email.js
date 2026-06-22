import { config } from "./config.js";
import { isValidPatientEmail, sanitizeResultNote } from "./results-email.js";

export function isEmailEnabled() {
  return Boolean(config.resendApiKey && config.resendFromEmail);
}

export async function sendAppointmentConfirmationEmail({ to, name, slotLabel, clinicName, clinicAddress }) {
  if (!isEmailEnabled() || !to) return;
  await sendResendEmail({
    to,
    subject: `Confirmacion de cita — ${clinicName}`,
    html: buildConfirmationHtml({ name, slotLabel, clinicName, clinicAddress })
  });
}

export async function sendCancellationEmail({ to, name, slotLabel, clinicName }) {
  if (!isEmailEnabled() || !to) return;
  await sendResendEmail({
    to,
    subject: `Cita cancelada — ${clinicName}`,
    html: buildCancellationHtml({ name, slotLabel, clinicName })
  });
}

export async function sendMedicalResultEmail({ to, name, clinicName, file, note }) {
  if (!isEmailEnabled()) {
    throw new Error("Resend email is not configured");
  }
  if (!isValidPatientEmail(to)) {
    throw new Error("Invalid patient email");
  }
  if (!file?.buffer?.length || !file.filename) {
    throw new Error("Missing result attachment");
  }

  await sendResendEmail({
    to,
    subject: `Resultados disponibles — ${clinicName}`,
    html: buildMedicalResultHtml({ name, clinicName, note }),
    attachments: [
      {
        filename: file.filename,
        content: file.buffer.toString("base64")
      }
    ]
  });
}

export function classifyEmailDeliveryError(error) {
  const status = Number(error?.resendStatus ?? error?.status ?? 0);
  const message = String(error?.resendMessage ?? error?.message ?? "");

  if (status === 401 || /invalid api key|api key/i.test(message)) {
    return "No se pudo enviar el correo. RESEND_API_KEY no es valida o ya no esta activa en Resend.";
  }

  const unverifiedDomain = message.match(/The\s+([^\s]+)\s+domain is not verified/i)?.[1];
  if (status === 403 && unverifiedDomain) {
    return `No se pudo enviar el correo. Resend bloqueo el envio porque el dominio ${unverifiedDomain} no esta verificado. Entra a Resend > Domains, agrega los DNS en Hostinger y presiona Verify.`;
  }

  if (status === 403 || /domain is not verified|verify your domain|sender|from/i.test(message)) {
    return "No se pudo enviar el correo. Resend rechazo el remitente; revisa que RESEND_FROM_EMAIL use un dominio verificado en Resend.";
  }

  if (status >= 500) {
    return "No se pudo enviar el correo por un problema temporal de Resend. Intenta de nuevo en unos minutos.";
  }

  return "No se pudo enviar el correo. Revisa RESEND_API_KEY, RESEND_FROM_EMAIL y que el dominio este verificado en Resend.";
}

async function sendResendEmail({ to, subject, html, attachments }) {
  const payload = { from: config.resendFromEmail, to: [to], subject, html };
  if (attachments?.length) payload.attachments = attachments;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.resendApiKey}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let details = {};
    try {
      details = JSON.parse(text);
    } catch {
      details = {};
    }
    const error = new Error(`Resend API error ${res.status}`);
    error.resendStatus = res.status;
    error.resendMessage = String(details.message ?? text).slice(0, 300);
    error.resendName = details.name;
    throw error;
  }
}

function buildMedicalResultHtml({ name, clinicName, note }) {
  const safeNote = sanitizeResultNote(note);
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Resultados disponibles</title></head>
<body style="font-family:sans-serif;background:#f9f9f9;padding:24px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.08);">
    <h2 style="color:#1a5fa8;margin-top:0;">Resultados disponibles</h2>
    <p>Hola <strong>${esc(name || "paciente")}</strong>,</p>
    <p>Te compartimos el archivo de resultados enviado por <strong>${esc(clinicName)}</strong>.</p>
    ${safeNote ? `<div style="background:#f0f7ff;border-left:4px solid #1a5fa8;padding:12px 16px;border-radius:4px;margin:16px 0;"><strong>Nota del consultorio:</strong><br>${esc(safeNote)}</div>` : ""}
    <p style="color:#555;font-size:14px;">Este correo solo entrega el archivo. Cualquier diagnostico, interpretacion o tratamiento debe revisarse directamente con la doctora.</p>
    <p style="color:#555;font-size:14px;">Si tienes dolor fuerte, sangrado abundante o una urgencia, acude a urgencias o contacta directamente al consultorio.</p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <p style="color:#999;font-size:12px;text-align:center;">${esc(clinicName)}</p>
  </div>
</body>
</html>`;
}

function buildConfirmationHtml({ name, slotLabel, clinicName, clinicAddress }) {
  const addr = clinicAddress ? `<p style="color:#555;font-size:14px;">📍 ${esc(clinicAddress)}</p>` : "";
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Confirmacion de cita</title></head>
<body style="font-family:sans-serif;background:#f9f9f9;padding:24px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.08);">
    <h2 style="color:#1a7a4a;margin-top:0;">✅ Cita confirmada</h2>
    <p>Hola <strong>${esc(name)}</strong>,</p>
    <p>Tu cita en <strong>${esc(clinicName)}</strong> ha sido confirmada.</p>
    <div style="background:#f0faf4;border-left:4px solid #1a7a4a;padding:12px 16px;border-radius:4px;margin:16px 0;">
      <strong>📅 ${esc(slotLabel)}</strong>
    </div>
    ${addr}
    <p style="color:#555;font-size:14px;">Si necesitas cancelar o reagendar, escríbenos por WhatsApp.</p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <p style="color:#999;font-size:12px;text-align:center;">${esc(clinicName)}</p>
  </div>
</body>
</html>`;
}

function buildCancellationHtml({ name, slotLabel, clinicName }) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Cita cancelada</title></head>
<body style="font-family:sans-serif;background:#f9f9f9;padding:24px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,.08);">
    <h2 style="color:#b00020;margin-top:0;">❌ Cita cancelada</h2>
    <p>Hola <strong>${esc(name)}</strong>,</p>
    <p>Tu cita en <strong>${esc(clinicName)}</strong> ha sido cancelada.</p>
    <div style="background:#fff5f5;border-left:4px solid #b00020;padding:12px 16px;border-radius:4px;margin:16px 0;">
      <strong>📅 ${esc(slotLabel)}</strong>
    </div>
    <p style="color:#555;font-size:14px;">Si deseas agendar una nueva cita, escríbenos por WhatsApp.</p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
    <p style="color:#999;font-size:12px;text-align:center;">${esc(clinicName)}</p>
  </div>
</body>
</html>`;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
