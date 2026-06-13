import { config } from "./config.js";
import { resilientFetch, readResponseTextSafe, buildHttpError } from "./http.js";

export async function sendWhatsAppText(to, body) {
  return sendWhatsAppMessage(to, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  });
}

export async function sendWhatsAppTemplate(to, templateName, languageCode, bodyParameters = []) {
  const components = bodyParameters.length > 0
    ? [{
        type: "body",
        parameters: bodyParameters.map((value) => ({
          type: "text",
          text: String(value ?? "").slice(0, 1024)
        }))
      }]
    : undefined;

  return sendWhatsAppMessage(to, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components ? { components } : {})
    }
  });
}

async function sendWhatsAppMessage(to, payload) {
  const url = `https://graph.facebook.com/v25.0/${config.whatsappPhoneNumberId}/messages`;
  const response = await resilientFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappAccessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }, {
    label: "WhatsApp send",
    timeoutMs: config.externalRequestTimeoutMs,
    retries: 0
  });

  if (!response.ok) {
    throw buildHttpError(`WhatsApp send to ${maskPhone(to)}`, response, await readResponseTextSafe(response));
  }

  console.log(`WhatsApp sent to ${maskPhone(to)}`);
}

function maskPhone(value) {
  const phone = String(value ?? "").replace(/\D/g, "");
  if (phone.length <= 6) return phone ? "***" : "";
  return `${phone.slice(0, 5)}****${phone.slice(-3)}`;
}
