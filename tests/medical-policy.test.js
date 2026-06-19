import test from "node:test";
import assert from "node:assert/strict";

import {
  INBOX_ATTACHMENT_EMAIL_ONLY_ERROR,
  MEDICAL_ATTACHMENT_BLOCK_ERROR,
  MEDICAL_FAQ_BLOCK_ERROR,
  RESULTS_PRIVACY_TEXT,
  buildMedicalPolicyWarnings,
  buildPatientResultsHumanNote,
  containsSensitiveMedicalTopic,
  isMedicalFaqAutoReplyBlocked,
  shouldBlockMedicalWhatsAppAttachment
} from "../src/medical-policy.js";

function file(overrides = {}) {
  return {
    filename: "resultado.pdf",
    contentType: "application/pdf",
    size: 1000,
    ...overrides
  };
}

test("resultados no prometen entrega de archivos por WhatsApp", () => {
  assert.match(RESULTS_PRIVACY_TEXT, /correo confirmado/);
  assert.match(RESULTS_PRIVACY_TEXT, /forma presencial/);
  assert.match(RESULTS_PRIVACY_TEXT, /Por WhatsApp solo podemos registrar tu solicitud/);

  const internalNote = buildPatientResultsHumanNote();
  assert.match(internalNote, /correo confirmado/);
  assert.match(internalNote, /No enviar resultados/);
  assert.match(MEDICAL_ATTACHMENT_BLOCK_ERROR, /no por WhatsApp/);
  assert.match(INBOX_ATTACHMENT_EMAIL_ONLY_ERROR, /ya no se envian por WhatsApp/);
  assert.match(INBOX_ATTACHMENT_EMAIL_ONLY_ERROR, /correo confirmado/);
});

test("detecta temas medicos sensibles aunque lleguen sin acentos", () => {
  assert.equal(containsSensitiveMedicalTopic("quiero mi diagnóstico"), true);
  assert.equal(containsSensitiveMedicalTopic("me das medicamento para infeccion"), true);
  assert.equal(containsSensitiveMedicalTopic("tengo dolor fuerte y sangrado"), true);
  assert.equal(containsSensitiveMedicalTopic("cuanto cuesta la consulta"), false);
});

test("bloquea adjuntos medicos por WhatsApp si hay tags de resultados o texto sensible", () => {
  assert.equal(
    shouldBlockMedicalWhatsAppAttachment({
      message: "te mando archivo",
      tags: ["Resultados"],
      file: file()
    }),
    true
  );

  assert.equal(
    shouldBlockMedicalWhatsAppAttachment({
      message: "aqui va el ultrasonido",
      tags: [],
      file: file({ filename: "foto.png", contentType: "image/png" })
    }),
    true
  );

  assert.equal(
    shouldBlockMedicalWhatsAppAttachment({
      message: "comprobante de transferencia",
      tags: [],
      file: file({ filename: "comprobante.txt", contentType: "text/plain" })
    }),
    false
  );
});

test("bloquea FAQ medica automatica y permite handoff humano", () => {
  assert.equal(
    isMedicalFaqAutoReplyBlocked({
      question: "que tratamiento uso para infeccion",
      answer: "usa medicamento",
      action: "answer"
    }),
    true
  );

  assert.equal(
    isMedicalFaqAutoReplyBlocked({
      question: "que tratamiento uso para infeccion",
      answer: "",
      action: "human_handoff"
    }),
    false
  );

  assert.match(MEDICAL_FAQ_BLOCK_ERROR, /debe pasar a humano/);
});

test("warnings de politica medica marcan config insegura en produccion", () => {
  const warnings = buildMedicalPolicyWarnings({
    nodeEnv: "production",
    whatsappAppSecret: "",
    requireWebhookSignature: false,
    allowUnsignedWebhooks: true,
    inboxAllowLegacyTokenAccess: true,
    forwardConversationBodies: true,
    includeSensitiveAppointmentNotes: true,
    maskPatientPhoneInCalendar: false,
    includePatientContactInCalendar: true
  });

  assert.ok(warnings.some((warning) => warning.includes("WHATSAPP_APP_SECRET")));
  assert.ok(warnings.some((warning) => warning.includes("REQUIRE_WEBHOOK_SIGNATURE")));
  assert.ok(warnings.some((warning) => warning.includes("ALLOW_UNSIGNED_WEBHOOKS")));
  assert.ok(warnings.some((warning) => warning.includes("FORWARD_CONVERSATION_BODIES")));
  assert.ok(warnings.some((warning) => warning.includes("INCLUDE_SENSITIVE_APPOINTMENT_NOTES")));
  assert.ok(warnings.some((warning) => warning.includes("MASK_PATIENT_PHONE_IN_CALENDAR")));
  assert.ok(warnings.some((warning) => warning.includes("INCLUDE_PATIENT_CONTACT_IN_CALENDAR")));
});
