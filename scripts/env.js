import fs from "node:fs";
import path from "node:path";

export const envPath = path.join(process.cwd(), ".env");

export function loadEnv() {
  const values = {};
  if (!fs.existsSync(envPath)) return values;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    const key = trimmed.slice(0, equals).trim();
    values[key] = trimmed.slice(equals + 1).trim();
  }

  return values;
}

export function requireValues(keys) {
  const env = loadEnv();
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing .env values: ${missing.join(", ")}`);
  }
  return env;
}

export function setEnvValue(key, value) {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, "m");
  const updated = pattern.test(existing)
    ? existing.replace(pattern, line)
    : `${existing.replace(/\s*$/, "")}\n${line}\n`;

  fs.writeFileSync(envPath, updated);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
