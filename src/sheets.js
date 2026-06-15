import crypto from "node:crypto";
import { config } from "./config.js";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let faqsCache = null;
let faqsCachedAt = 0;
let promosCache = null;
let promosCachedAt = 0;
let accessToken = null;
let accessTokenExpiresAt = 0;

export function isSheetsEnabled() {
  return config.sheetsEnabled && Boolean(config.googleSheetsId) && Boolean(config.googleServiceAccountJson);
}

function pemToBuffer(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  return buffer.buffer;
}

function b64url(str) {
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlFromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function createServiceAccountJWT(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  }));

  const signingInput = `${header}.${payload}`;
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToBuffer(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64urlFromBuffer(signature)}`;
}

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiresAt - 60_000) {
    return accessToken;
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(config.googleServiceAccountJson);
  } catch {
    throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT_JSON: must be valid JSON");
  }

  const jwt = await createServiceAccountJWT(serviceAccount);

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    }).toString()
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to get access token: ${response.status} ${body}`);
  }

  const data = await response.json();
  accessToken = data.access_token;
  accessTokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  return accessToken;
}

async function sheetsGet(range) {
  if (!isSheetsEnabled()) return null;

  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetsId)}/values/${encodeURIComponent(range)}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Sheets GET failed: ${response.status} ${body}`);
  }

  return response.json();
}

async function sheetsAppend(range, values) {
  if (!isSheetsEnabled()) return null;

  const token = await getAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.googleSheetsId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ values })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Sheets APPEND failed: ${response.status} ${body}`);
  }

  return response.json();
}

/**
 * Load FAQs from the Google Sheet.
 * Expects columns: question, answer, variations (comma-separated), active (TRUE/FALSE)
 * Returns array of { question, answer, variations, active }
 */
export async function loadFaqsFromSheet() {
  if (!isSheetsEnabled()) return [];
  if (faqsCache && Date.now() - faqsCachedAt < CACHE_TTL_MS) return faqsCache;

  try {
    const data = await sheetsGet("FAQs!A2:D");
    const rows = data?.values ?? [];
    faqsCache = rows
      .filter((row) => row[0] && row[1])
      .map((row) => ({
        question: String(row[0] ?? "").trim(),
        answer: String(row[1] ?? "").trim(),
        variations: String(row[2] ?? "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
        active: String(row[3] ?? "TRUE").toUpperCase() !== "FALSE"
      }))
      .filter((faq) => faq.active);
    faqsCachedAt = Date.now();
    return faqsCache;
  } catch (error) {
    console.error("[sheets] Failed to load FAQs:", error?.message ?? error);
    return faqsCache ?? [];
  }
}

/**
 * Load promos from the Google Sheet.
 * Expects columns: title, price, description, active (TRUE/FALSE)
 * Returns array of { title, price, description, active }
 */
export async function loadPromosFromSheet() {
  if (!isSheetsEnabled()) return [];
  if (promosCache && Date.now() - promosCachedAt < CACHE_TTL_MS) return promosCache;

  try {
    const data = await sheetsGet("Promos!A2:D");
    const rows = data?.values ?? [];
    promosCache = rows
      .filter((row) => row[0])
      .map((row) => ({
        title: String(row[0] ?? "").trim(),
        price: String(row[1] ?? "").trim(),
        description: String(row[2] ?? "").trim(),
        active: String(row[3] ?? "TRUE").toUpperCase() !== "FALSE"
      }))
      .filter((promo) => promo.active);
    promosCachedAt = Date.now();
    return promosCache;
  } catch (error) {
    console.error("[sheets] Failed to load promos:", error?.message ?? error);
    return promosCache ?? [];
  }
}

/**
 * Append a lead row to the Leads sheet.
 * @param {{ phone: string, name?: string, intent?: string, tags?: string[], createdAt?: string }} lead
 */
export async function appendLeadToSheet(lead) {
  if (!isSheetsEnabled()) return false;

  try {
    const row = [
      lead.createdAt ?? new Date().toISOString(),
      String(lead.phone ?? ""),
      String(lead.name ?? ""),
      String(lead.intent ?? ""),
      Array.isArray(lead.tags) ? lead.tags.join(", ") : String(lead.tags ?? "")
    ];
    await sheetsAppend("Leads!A:E", [row]);
    return true;
  } catch (error) {
    console.error("[sheets] Failed to append lead:", error?.message ?? error);
    return false;
  }
}

/**
 * Append an appointment row to the Appointments sheet.
 * @param {{ phone: string, name?: string, slotLabel?: string, service?: string, status?: string, createdAt?: string }} appointment
 */
export async function appendAppointmentToSheet(appointment) {
  if (!isSheetsEnabled()) return false;

  try {
    const row = [
      appointment.createdAt ?? new Date().toISOString(),
      String(appointment.phone ?? ""),
      String(appointment.name ?? ""),
      String(appointment.slotLabel ?? ""),
      String(appointment.service ?? ""),
      String(appointment.status ?? "confirmed")
    ];
    await sheetsAppend("Appointments!A:F", [row]);
    return true;
  } catch (error) {
    console.error("[sheets] Failed to append appointment:", error?.message ?? error);
    return false;
  }
}

/**
 * Append an unknown/unrecognized question to the UnknownQuestions sheet for manual review.
 * @param {{ phone: string, question: string, category?: string, createdAt?: string }} item
 */
export async function appendUnknownQuestionToSheet(item) {
  if (!isSheetsEnabled()) return false;

  try {
    const row = [
      item.createdAt ?? new Date().toISOString(),
      String(item.phone ?? ""),
      String(item.question ?? ""),
      String(item.category ?? "desconocido")
    ];
    await sheetsAppend("UnknownQuestions!A:D", [row]);
    return true;
  } catch (error) {
    console.error("[sheets] Failed to append unknown question:", error?.message ?? error);
    return false;
  }
}

/**
 * Invalidate the FAQs cache so the next call re-fetches from Sheets.
 */
export function invalidateFaqsCache() {
  faqsCache = null;
  faqsCachedAt = 0;
}

/**
 * Invalidate the promos cache so the next call re-fetches from Sheets.
 */
export function invalidatePromosCache() {
  promosCache = null;
  promosCachedAt = 0;
}
