export async function readRawBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`Request body too large: ${size} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readForm(req, { maxBytes }) {
  const rawBody = await readRawBody(req, maxBytes);
  const contentType = String(req.headers["content-type"] ?? "");

  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    return parseMultipartForm(rawBody, contentType);
  }

  return new URLSearchParams(rawBody.toString("utf8"));
}

export function parseMultipartForm(rawBody, contentType) {
  const boundary = extractBoundary(contentType);
  if (!boundary) throw new Error("Multipart form is missing boundary");

  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const fields = new Map();
  const files = new Map();
  let cursor = rawBody.indexOf(boundaryBuffer);

  while (cursor !== -1) {
    let partStart = cursor + boundaryBuffer.length;
    if (rawBody.slice(partStart, partStart + 2).toString("utf8") === "--") break;
    if (rawBody.slice(partStart, partStart + 2).toString("utf8") === "\r\n") partStart += 2;

    const nextBoundary = rawBody.indexOf(Buffer.from(`\r\n--${boundary}`), partStart);
    if (nextBoundary === -1) break;

    const part = rawBody.slice(partStart, nextBoundary);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) {
      cursor = nextBoundary + 2;
      continue;
    }

    const headerText = part.slice(0, headerEnd).toString("utf8");
    const content = part.slice(headerEnd + 4);
    const headers = parsePartHeaders(headerText);
    const disposition = headers.get("content-disposition") ?? "";
    const name = getDispositionValue(disposition, "name");
    const fileName = getDispositionValue(disposition, "filename");

    if (name) {
      if (fileName) {
        files.set(name, {
          filename: sanitizeFileName(fileName),
          contentType: headers.get("content-type") ?? "application/octet-stream",
          buffer: content,
          size: content.length
        });
      } else {
        fields.set(name, content.toString("utf8"));
      }
    }

    cursor = nextBoundary + 2;
  }

  return {
    get: (name) => fields.get(name),
    getFile: (name) => files.get(name),
    fields,
    files
  };
}

function extractBoundary(contentType) {
  const match = String(contentType).match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] ?? match?.[2]?.trim();
}

function parsePartHeaders(headerText) {
  const headers = new Map();
  for (const line of headerText.split("\r\n")) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  }
  return headers;
}

function getDispositionValue(disposition, key) {
  const match = String(disposition).match(new RegExp(`${key}="([^"]*)"`, "i"));
  return match?.[1];
}

function sanitizeFileName(value) {
  const clean = String(value ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[^\w.\- ()]/g, "_")
    .trim();
  return clean || "archivo";
}
