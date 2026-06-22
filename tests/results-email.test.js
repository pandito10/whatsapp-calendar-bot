import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResultSentWhatsAppNotice,
  buildResultsEmailAuditText,
  buildResultsEmailMessageMetadata,
  extractLatestPatientEmailFromMessages,
  maskEmail,
  resolveResultsEmailRecipient,
  validateResultsEmailRequest
} from "../src/results-email.js";

function file(overrides = {}) {
  return {
    filename: "resultado.pdf",
    contentType: "application/pdf",
    buffer: Buffer.from("%PDF-test"),
    size: 9,
    ...overrides
  };
}

test("rechaza envio de resultados sin correo confirmado", () => {
  const error = validateResultsEmailRequest({
    patientEmail: "",
    file: file(),
    confirmed: true,
    maxBytes: 10_000_000
  });

  assert.equal(error, "Esta paciente no tiene correo confirmado.");
});

test("detecta el ultimo correo valido escrito por la paciente", () => {
  const email = extractLatestPatientEmailFromMessages([
    { sender: "patient", body: "hola" },
    { sender: "patient", body: "mi correo es correo-viejo@example.com" },
    { sender: "patient", body: "perdon, es paciente.nueva@gmail.com" }
  ]);

  assert.equal(email, "paciente.nueva@gmail.com");
});

test("prefiere correo de cita y usa conversacion como respaldo", () => {
  const fromAppointment = resolveResultsEmailRecipient({
    appointment: { patientEmail: "cita@example.com" },
    conversation: {
      messages: [{ sender: "patient", body: "mi correo es chat@example.com" }]
    }
  });
  const fromConversation = resolveResultsEmailRecipient({
    appointment: {},
    conversation: {
      messages: [{ sender: "patient", body: "mi correo es chat@example.com" }]
    }
  });

  assert.deepEqual(fromAppointment, { email: "cita@example.com", source: "appointment" });
  assert.deepEqual(fromConversation, { email: "chat@example.com", source: "conversation" });
});

test("rechaza correo confirmado invalido", () => {
  const error = validateResultsEmailRequest({
    patientEmail: "correo-malo",
    file: file(),
    confirmed: true,
    maxBytes: 10_000_000
  });

  assert.equal(error, "El correo confirmado de la paciente no es valido.");
});

test("rechaza archivo no permitido para resultados medicos", () => {
  const error = validateResultsEmailRequest({
    patientEmail: "paciente@example.com",
    file: file({ filename: "resultado.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    confirmed: true,
    maxBytes: 10_000_000
  });

  assert.equal(error, "Archivo no permitido. Solo se aceptan PDF, JPG, PNG o WEBP.");
});

test("exige confirmacion humana antes de enviar resultados", () => {
  const error = validateResultsEmailRequest({
    patientEmail: "paciente@example.com",
    file: file(),
    confirmed: false,
    maxBytes: 10_000_000
  });

  assert.equal(error, "Confirma que este archivo corresponde a esta paciente y que el correo fue confirmado.");
});

test("sendMedicalResultEmail envia adjunto por Resend", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  process.env.NODE_ENV = "test";
  process.env.WHATSAPP_VERIFY_TOKEN = "verify-token-test";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "123456789";
  process.env.WHATSAPP_ACCESS_TOKEN = "whatsapp-token-test";
  process.env.DOCTOR_WHATSAPP_NUMBER = "5210000000000";
  process.env.RESEND_API_KEY = "resend-test-key";
  process.env.RESEND_FROM_EMAIL = "consultorio@example.com";

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ id: "email-test-id" }), { status: 200 });
  };

  try {
    const { sendMedicalResultEmail } = await import(`../src/email.js?results=${Date.now()}`);
    await sendMedicalResultEmail({
      to: "paciente@example.com",
      name: "Ana Lopez",
      clinicName: "Consultorio Test",
      file: file(),
      note: "Favor de revisar con la doctora."
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].options.headers.Authorization, "Bearer resend-test-key");
    const payload = JSON.parse(calls[0].options.body);
    assert.equal(payload.to[0], "paciente@example.com");
    assert.equal(payload.subject, "Resultados disponibles — Consultorio Test");
    assert.equal(payload.attachments[0].filename, "resultado.pdf");
    assert.equal(payload.attachments[0].content, Buffer.from("%PDF-test").toString("base64"));
    assert.match(payload.html, /diagnostico, interpretacion o tratamiento debe revisarse directamente con la doctora/);
    assert.equal(calls.some((call) => call.url.includes("graph.facebook.com")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clasifica dominio no verificado de Resend con mensaje accionable", async () => {
  const { classifyEmailDeliveryError } = await import(`../src/email.js?classify=${Date.now()}`);
  const error = new Error("Resend API error 403");
  error.resendStatus = 403;
  error.resendMessage = "The ginecologiaintegralgto.com domain is not verified. Please, add and verify your domain on https://resend.com/domains";

  const message = classifyEmailDeliveryError(error);

  assert.match(message, /ginecologiaintegralgto\.com/);
  assert.match(message, /Resend > Domains/);
  assert.match(message, /Hostinger/);
});

test("auditoria de resultados usa correo enmascarado y no contenido del archivo", () => {
  const text = buildResultsEmailAuditText({
    email: "correopaciente@example.com",
    filename: "resultado.pdf"
  });
  const metadata = buildResultsEmailMessageMetadata({
    email: "correopaciente@example.com",
    filename: "resultado.pdf"
  });

  assert.equal(maskEmail("correopaciente@example.com"), "c***@example.com");
  assert.equal(text, "Resultado enviado por correo a c***@example.com. Archivo: resultado.pdf");
  assert.deepEqual(metadata, {
    source: "inbox_results_email",
    emailMasked: "c***@example.com",
    filename: "resultado.pdf"
  });
  assert.doesNotMatch(text, /%PDF|contenido|base64/i);
  assert.equal("content" in metadata, false);
});

test("aviso WhatsApp de resultados no adjunta ni menciona archivo", () => {
  const notice = buildResultSentWhatsAppNotice();

  assert.match(notice, /correo confirmado/);
  assert.doesNotMatch(notice, /pdf|jpg|png|webp|archivo|adjunto|resultado\.pdf/i);
});
