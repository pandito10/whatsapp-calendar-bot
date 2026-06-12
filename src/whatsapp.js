import { config } from "./config.js";

export async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/v25.0/${config.whatsappPhoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappAccessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    })
  });

  if (!response.ok) {
    throw new Error(`WhatsApp send failed to ${to}: ${response.status} ${await response.text()}`);
  }

  console.log(`WhatsApp sent to ${to}`);
}
