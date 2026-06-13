const defaultRetryStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const safeMethods = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);

export async function resilientFetch(url, options = {}, settings = {}) {
  const method = String(options.method ?? "GET").toUpperCase();
  const timeoutMs = Number(settings.timeoutMs ?? 8000);
  const retries = Number(settings.retries ?? (safeMethods.has(method) ? 2 : 0));
  const retryUnsafe = Boolean(settings.retryUnsafe);
  const retryStatuses = new Set(settings.retryStatuses ?? defaultRetryStatuses);
  const label = settings.label ?? "external request";
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs)
      });

      const canRetry = attempt < retries && retryStatuses.has(response.status) && (safeMethods.has(method) || retryUnsafe);
      if (!canRetry) return response;

      await drainResponse(response);
      await sleep(backoffMs(attempt));
    } catch (error) {
      lastError = error;
      if (attempt >= retries || (!safeMethods.has(method) && !retryUnsafe)) {
        throw wrapNetworkError(label, error);
      }
      await sleep(backoffMs(attempt));
    }
  }

  throw wrapNetworkError(label, lastError);
}

export async function readResponseTextSafe(response) {
  try {
    return await response.text();
  } catch {
    return "[unreadable response body]";
  }
}

export function buildHttpError(label, response, body) {
  return new Error(`${label} failed: ${response.status} ${redactSecrets(body)}`);
}

export function redactSecrets(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "ya29.[redacted]")
    .replace(/(service_role|apikey|access_token|refresh_token|client_secret|app_secret)([^A-Za-z0-9]+)[A-Za-z0-9._~+/=-]+/gi, "$1$2[redacted]")
    .replace(/\b(52\d{3})\d{4,6}(\d{3})\b/g, "$1****$2")
    .slice(0, 1200);
}

async function drainResponse(response) {
  try {
    await response.arrayBuffer();
  } catch {
    // best effort only
  }
}

function wrapNetworkError(label, error) {
  const wrapped = new Error(`${label} network error: ${redactSecrets(error?.message ?? error)}`);
  wrapped.cause = error;
  return wrapped;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  return Math.min(1000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
}
