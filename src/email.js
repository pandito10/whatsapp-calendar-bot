import { config } from "./config.js";

export function isEmailEnabled() {
  return Boolean(config.resendApiKey && config.resendFromEmail);
}

export async function sendAppointmentConfirmationEmail({ to, name, slotLabel, clinicName, clinicAddress }) {
  if (!isEmailEnabled() || !to) return;

  const body = JSON.stringify({
    from: config.resendFromEmail,
    to: [to],
    subject: `Confirmacion de cita — ${clinicName}`,
    html: buildConfirmationHtml({ name, slotLabel, clinicName, clinicAddress })
  });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.resendApiKey}`
    },
    body,
    signal: AbortSignal.timeout(10_000)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend API error ${res.status}: ${text.slice(0, 200)}`);
  }
}

export async function sendCancellationEmail({ to, name, slotLabel, clinicName }) {
  if (!isEmailEnabled() || !to) return;

  const body = JSON.stringify({
    from: config.resendFromEmail,
    to: [to],
    subject: `Cita cancelada — ${clinicName}`,
    html: buildCancellationHtml({ name, slotLabel, clinicName })
  });

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.resendApiKey}`
    },
    body,
    signal: AbortSignal.timeout(10_000)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Resend API error ${res.status}: ${text.slice(0, 200)}`);
  }
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
