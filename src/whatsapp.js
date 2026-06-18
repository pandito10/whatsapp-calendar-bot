import { config } from "./config.js";
import { resilientFetch, readResponseTextSafe, buildHttpError } from "./http.js";

let lastWhatsAppSendDiagnostic = null;

export function getLastWhatsAppSendDiagnostic() {
  return lastWhatsAppSendDiagnostic;
}

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

export async function sendInteractiveButtons(to, body, buttons) {
  return sendWhatsAppButtons(to, { body, buttons });
}

export async function sendInteractiveList(to, body, sections) {
  return sendWhatsAppList(to, {
    body,
    buttonText: "Ver opciones",
    sections
  });
}

export async function sendMessageWithOptions(to, body, options = []) {
  const normalizedOptions = normalizeOptions(options);
  if (normalizedOptions.length === 0) {
    return sendWhatsAppText(to, body);
  }

  const fallbackText = buildOptionsFallbackText(body, normalizedOptions);

  if (normalizedOptions.length === 1) {
    return sendWhatsAppText(
      to,
      `${body}\n\nPuedes responder: ${normalizedOptions[0].title}`
    );
  }

  if (normalizedOptions.length <= 3) {
    try {
      return await sendInteractiveButtons(to, body, normalizedOptions);
    } catch (error) {
      console.warn(`WhatsApp buttons failed for ${maskPhone(to)}; falling back to text.`);
      return sendWhatsAppText(to, fallbackText);
    }
  }

  if (normalizedOptions.length <= 10) {
    try {
      return await sendInteractiveList(to, body, [{
        title: "Opciones",
        rows: normalizedOptions
      }]);
    } catch (error) {
      console.warn(`WhatsApp list failed for ${maskPhone(to)}; falling back to text.`);
      return sendWhatsAppText(to, fallbackText);
    }
  }

  return sendWhatsAppText(to, fallbackText);
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
  const authHeaders = { Authorization: `Bearer ${config.whatsappAccessToken}` };

  // Step 1: resolve the download URL
  const metaRes = await resilientFetch(
    `https://graph.facebook.com/v25.0/${mediaId}`,
    { headers: authHeaders },
    { label: "WhatsApp media meta", timeoutMs: 10_000, retries: 1 }
  );
  if (!metaRes.ok) {
    throw buildHttpError("WhatsApp media meta", metaRes, await readResponseTextSafe(metaRes));
  }
  const meta = JSON.parse(await readResponseTextSafe(metaRes));
  if (!meta.url) throw new Error("WhatsApp media meta did not return url");

  // Step 2: download binary
  const audioRes = await resilientFetch(
    meta.url,
    { headers: authHeaders },
    { label: "WhatsApp audio download", timeoutMs: 30_000, retries: 0 }
  );
  if (!audioRes.ok) {
    throw buildHttpError("WhatsApp audio download", audioRes, await readResponseTextSafe(audioRes));
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
  if (config.whatsappSendDryRun) {
    console.log(`WhatsApp dry-run send to ${maskPhone(to)} using ${config.whatsappTokenSource}`);
    lastWhatsAppSendDiagnostic = {
      at: new Date().toISOString(),
      ok: true,
      dryRun: true,
      to: maskPhone(to),
      phoneNumberId: maskIdentifier(config.whatsappPhoneNumberId),
      tokenSource: config.whatsappTokenSource,
      messageType: payload?.type ?? "unknown"
    };
    return;
  }

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
    const responseText = await readResponseTextSafe(response);
    const diagnostic = buildWhatsAppSendDiagnostic({
      to,
      status: response.status,
      responseText,
      messageType: payload?.type
    });
    lastWhatsAppSendDiagnostic = diagnostic;
    console.warn(
      `WhatsApp send rejected. to=${diagnostic.to} status=${diagnostic.status} code=${diagnostic.code ?? "unknown"} subcode=${diagnostic.subcode ?? "none"} phone_number_id=${diagnostic.phoneNumberId} token_source=${diagnostic.tokenSource}`
    );
    const error = buildHttpError(`WhatsApp send to ${maskPhone(to)}`, response, responseText);
    error.whatsappDiagnostic = diagnostic;
    throw error;
  }

  lastWhatsAppSendDiagnostic = {
    at: new Date().toISOString(),
    ok: true,
    to: maskPhone(to),
    phoneNumberId: maskIdentifier(config.whatsappPhoneNumberId),
    tokenSource: config.whatsappTokenSource,
    messageType: payload?.type ?? "unknown"
  };
  console.log(`WhatsApp sent to ${maskPhone(to)}`);
}

function buildWhatsAppSendDiagnostic({ to, status, responseText, messageType }) {
  const parsed = parseJsonSafe(responseText);
  const error = parsed?.error ?? {};
  const code = error.code ?? parsed?.code;
  const subcode = error.error_subcode ?? error.subcode ?? parsed?.error_subcode;
  return {
    at: new Date().toISOString(),
    ok: false,
    to: maskPhone(to),
    status,
    code,
    subcode,
    type: error.type,
    phoneNumberId: maskIdentifier(config.whatsappPhoneNumberId),
    tokenSource: config.whatsappTokenSource,
    messageType: messageType ?? "unknown",
    category: classifyWhatsAppSendError(status, code, subcode)
  };
}

function classifyWhatsAppSendError(status, code, subcode) {
  if (status === 401 || code === 190) return "token_invalid_or_expired";
  if (status === 403) return "permission_or_phone_number_access";
  if (code === 131030 || code === 131031 || subcode === 131030 || subcode === 131031) {
    return "phone_number_or_recipient_not_allowed";
  }
  return "whatsapp_send_failed";
}

function parseJsonSafe(text) {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

function getMediaMessageType(file) {
  const contentType = String(file?.contentType ?? "").toLowerCase();
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  return "document";
}

function normalizeOptions(options) {
  return options
    .filter(Boolean)
    .map((option, index) => ({
      id: String(option.id ?? `option_${index + 1}`),
      title: String(option.title ?? option.label ?? `Opcion ${index + 1}`),
      ...(option.description ? { description: String(option.description) } : {})
    }));
}

function buildOptionsFallbackText(body, options) {
  return `${body}\n\n${options
    .map((option, index) => `${index + 1}. ${option.title}`)
    .join("\n")}`;
}

function maskPhone(value) {
  const phone = String(value ?? "").replace(/\D/g, "");
  if (phone.length <= 6) return phone ? "***" : "";
  return `${phone.slice(0, 5)}****${phone.slice(-3)}`;
}

function maskIdentifier(value) {
  const id = String(value ?? "").trim();
  if (!id) return "";
  if (id.length <= 8) return "***";
  return `${id.slice(0, 4)}...${id.slice(-4)}`;
}
