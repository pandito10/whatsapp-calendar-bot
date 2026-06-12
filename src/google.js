import { config, requireEnv } from "./config.js";
import { sendWhatsAppText } from "./whatsapp.js";

let cachedToken = null;
let lastGoogleAuthAlertAt = 0;
const googleAuthAlertIntervalMs = 30 * 60 * 1000;

export async function googleRequest(path, options = {}) {
  const token = await getAccessToken();
  const response = await fetch(`https://www.googleapis.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });

  if (!response.ok) {
    throw new Error(`Google API failed: ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function getAccessToken() {
  requireEnv(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"], "Google Calendar");

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: config.googleRefreshToken,
      grant_type: "refresh_token"
    })
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 400 || response.status === 401) {
      await notifyGoogleAuthError();
    }
    throw new Error(`Google OAuth failed: ${response.status} ${body}`);
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
    console.error("Failed sending Google Calendar auth alert:", error);
  }
}
