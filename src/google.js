import { config, requireEnv } from "./config.js";
import { resilientFetch, readResponseTextSafe, buildHttpError, redactSecrets } from "./http.js";
import { sendWhatsAppText } from "./whatsapp.js";

let cachedToken = null;
let lastGoogleAuthAlertAt = 0;
const googleAuthAlertIntervalMs = 30 * 60 * 1000;

export async function googleRequest(path, options = {}, settings = {}) {
  const token = await getAccessToken();
  const { ignoreNotFound, ...fetchOptions } = options;
  const response = await resilientFetch(`https://www.googleapis.com${path}`, {
    ...fetchOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  }, {
    label: "Google API",
    timeoutMs: config.externalRequestTimeoutMs,
    retries: settings.retry === true ? config.externalRequestRetries : 0,
    retryUnsafe: settings.retry === true
  });

  if (!response.ok) {
    if (ignoreNotFound && (response.status === 404 || response.status === 410)) return undefined;
    throw buildHttpError("Google API", response, await readResponseTextSafe(response));
  }

  if (response.status === 204) return undefined;
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function getAccessToken() {
  requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"], "Google Calendar");

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const response = await resilientFetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: config.googleRefreshToken,
      grant_type: "refresh_token"
    })
  }, {
    label: "Google OAuth",
    timeoutMs: config.externalRequestTimeoutMs,
    retries: config.externalRequestRetries,
    retryUnsafe: true
  });

  if (!response.ok) {
    const body = await readResponseTextSafe(response);
    if (response.status === 400 || response.status === 401) {
      await notifyGoogleAuthError();
    }
    throw buildHttpError("Google OAuth", response, body);
  }

  const data = await response.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000
  };

  return cachedToken.accessToken;
}

async function notifyGoogleAuthError() {
  const now = Date.now();
  if (now - lastGoogleAuthAlertAt < googleAuthAlertIntervalMs) return;
  lastGoogleAuthAlertAt = now;

  try {
    await sendWhatsAppText(
      config.doctorWhatsappNumber,
      "⚠️ El bot no puede conectarse a Google Calendar. El acceso fue revocado o expiró. Necesitas reconectar el calendario."
    );
  } catch (error) {
    console.error("Failed sending Google Calendar auth alert:", redactSecrets(error?.message ?? error));
  }
}
