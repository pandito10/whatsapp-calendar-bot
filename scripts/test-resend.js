#!/usr/bin/env node

import { isValidPatientEmail, maskEmail } from "../src/results-email.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const help = args.includes("--help") || args.includes("-h");

if (help) {
  printHelp();
  process.exit(0);
}

const apiKey = String(process.env.RESEND_API_KEY ?? "").trim();
const from = String(process.env.RESEND_FROM_EMAIL ?? "").trim();
const to = String(getArgValue("--to") ?? process.env.RESEND_TEST_TO_EMAIL ?? "").trim();

const missing = [];
if (!apiKey) missing.push("RESEND_API_KEY");
if (!from) missing.push("RESEND_FROM_EMAIL");
if (!to) missing.push("RESEND_TEST_TO_EMAIL o --to correo@dominio.com");

if (missing.length) {
  console.error(`Faltan variables para probar Resend: ${missing.join(", ")}.`);
  console.error("No se envio ningun correo.");
  printHelp();
  process.exit(1);
}

if (!isValidPatientEmail(extractEmailAddress(from))) {
  console.error("RESEND_FROM_EMAIL no parece un correo valido.");
  console.error("Ejemplo valido: resultados@ginecologiaintegralgto.com");
  process.exit(1);
}

if (!isValidPatientEmail(to)) {
  console.error("RESEND_TEST_TO_EMAIL no parece un correo valido.");
  process.exit(1);
}

const payload = {
  from,
  to: [to],
  subject: "Prueba de correo del consultorio",
  html: `<!doctype html>
<html lang="es">
<body style="font-family:sans-serif;line-height:1.5">
  <h2>Prueba de correo del consultorio</h2>
  <p>Este correo confirma que Resend esta configurado para el inbox.</p>
  <p>No contiene datos de pacientes ni archivos medicos.</p>
</body>
</html>`
};

console.log("Verificando configuracion de Resend sin imprimir secretos.");
console.log(`Remitente: ${maskEmail(extractEmailAddress(from))}`);
console.log(`Destino de prueba: ${maskEmail(to)}`);
console.log(`Modo: ${dryRun ? "dry-run, no envia correo" : "envio real de prueba"}`);

if (dryRun) {
  console.log("Dry-run correcto. No se envio correo.");
  process.exit(0);
}

try {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw buildResendError(response.status, body);
  }

  console.log("Correo de prueba enviado correctamente por Resend.");
} catch (error) {
  console.error(classifyResendError(error));
  process.exit(1);
}

function getArgValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1] ?? "";
}

function extractEmailAddress(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/<([^<>@\s]+@[^<>\s]+)>/);
  return (match?.[1] ?? text).trim();
}

function buildResendError(status, body) {
  let details = {};
  try {
    details = JSON.parse(body);
  } catch {
    details = {};
  }
  const error = new Error(`Resend API error ${status}`);
  error.resendStatus = status;
  error.resendMessage = String(details.message ?? body).slice(0, 300);
  return error;
}

function classifyResendError(error) {
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

function printHelp() {
  console.log(`
Uso:
  RESEND_API_KEY=... RESEND_FROM_EMAIL=resultados@tudominio.com RESEND_TEST_TO_EMAIL=tu-correo@gmail.com npm run test:resend

Opciones:
  --dry-run           Valida variables sin enviar correo.
  --to correo@...     Usa un correo destino sin RESEND_TEST_TO_EMAIL.

Este script nunca imprime RESEND_API_KEY y no usa datos de pacientes.
`);
}
