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

export async function sendWhatsAppList(to, { body, buttonText = "Ver opciones", sections }) {
  return sendWhatsAppMessage(to, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: String(body ?? "").slice(0, 1024) },
      action: {
        button: String(buttonText ?? "Ver opciones").slice(0, 20),
        sections: sections.map((section) => ({
          title: String(section.title ?? "Opciones").slice(0, 24),
          rows: section.rows.slice(0, 10).map((row) => ({
            id: String(row.id).slice(0, 200),
            title: String(row.title).slice(0, 24),
            ...(row.description ? { description: String(row.description).slice(0, 72) } : {})
          }))
        }))
      }
    }
  });
}

export async function sendWhatsAppButtons(to, { body, buttons }) {
  return sendWhatsAppMessage(to, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: String(body ?? "").slice(0, 1024) },
      action: {
        buttons: buttons.slice(0, 3).map((button) => ({
          type: "reply",
          reply: {
            id: String(button.id).slice(0, 200),
            title: String(button.title).slice(0, 20)
          }
        }))
      }
    }
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

export async function sendWhatsAppMedia(to, file, options = {}) {
  const mediaType = getMediaMessageType(file);
  const mediaId = await uploadWhatsAppMedia(file);
  const mediaPayload = {
    id: mediaId,
    ...(options.caption ? { caption: String(options.caption).slice(0, 1024) } : {}),
    ...(mediaType === "document" ? { filename: file.filename } : {})
  };

  await sendWhatsAppMessage(to, {
    messaging_product: "whatsapp",
    to,
    type: mediaType,
    [mediaType]: mediaPayload
  });

  return { mediaId, mediaType };
}

export async function downloadWhatsAppAudio(mediaId) {
  // Step 1: resolve the download URL
  const metaUrl = `https://graph.facebook.com/v25.0/${mediaId}`;
  const metaRes = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${config.whatsappAccessToken}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!metaRes.ok) {
    throw new Error(`WhatsApp media meta fetch failed: ${metaRes.status}`);
  }
  const meta = await metaRes.json();
  const downloadUrl = meta.url;
  if (!downloadUrl) throw new Error("WhatsApp media meta did not return url");

  // Step 2: download binary
  const audioRes = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${config.whatsappAccessToken}` },
    signal: AbortSignal.timeout(30_000)
  });
  if (!audioRes.ok) {
    throw new Error(`WhatsApp audio download failed: ${audioRes.status}`);
  }

  const buffer = Buffer.from(await audioRes.arrayBuffer());
  const mimeType = meta.mime_type ?? audioRes.headers.get("content-type") ?? "audio/ogg";
  return { buffer, mimeType };
}

export async function uploadWhatsAppMedia(file) {
  const url = `https://graph.facebook.com/v25.0/${config.whatsappPhoneNumberId}/media`;
  const form = new FormData();
  const blob = new Blob([file.buffer], { type: file.contentType || "application/octet-stream" });
  form.set("messaging_product", "whatsapp");
  form.set("file", blob, file.filename || "archivo");

  const response = await resilientFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsappAccessToken}`
    },
    body: form
  }, {
    label: "WhatsApp media upload",
    timeoutMs: config.externalRequestTimeoutMs,
    retries: 0
  });

  const responseText = await readResponseTextSafe(response);
  if (!response.ok) {
    throw buildHttpError("WhatsApp media upload", response, responseText);
  }

  const payload = responseText ? JSON.parse(responseText) : {};
  if (!payload.id) {
    throw new Error("WhatsApp media upload did not return a media id");
  }
  return payload.id;
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

function getMediaMessageType(file) {
  const contentType = String(file?.contentType ?? "").toLowerCase();
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return "document";
}

function maskPhone(value) {
  const phone = String(value ?? "").replace(/\D/g, "");
  if (phone.length <= 6) return phone ? "***" : "";
  return `${phone.slice(0, 5)}****${phone.slice(-3)}`;
}
