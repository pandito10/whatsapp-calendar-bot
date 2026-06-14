import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const baseEnv = {
  ...process.env,
  NODE_ENV: "production",
  WHATSAPP_VERIFY_TOKEN: "verify-token-test",
  WHATSAPP_PHONE_NUMBER_ID: "123456789",
  WHATSAPP_ACCESS_TOKEN: "whatsapp-token-test",
  DOCTOR_WHATSAPP_NUMBER: "5210000000000",
  REQUIRE_WEBHOOK_SIGNATURE: "true",
  ALLOW_UNSIGNED_WEBHOOKS: "false",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  GOOGLE_REFRESH_TOKEN: "google-refresh",
  GOOGLE_CALENDAR_ID: "b96c51c36ae4dc56e6618c6da02e4002a1810aacabf241a63380d58821f4c620@group.calendar.google.com"
};

test("produccion exige WHATSAPP_APP_SECRET si la firma es obligatoria", () => {
  const result = importConfigWith({
    ...baseEnv,
    WHATSAPP_APP_SECRET: "",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WHATSAPP_APP_SECRET is required/);
});

test("produccion exige Supabase cuando las citas requieren base de datos", () => {
  const result = importConfigWith({
    ...baseEnv,
    WHATSAPP_APP_SECRET: "app-secret",
    REQUIRE_DB_FOR_APPOINTMENTS: "true",
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: ""
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
});

test("produccion acepta alias REQUIRE_SUPABASE_FOR_APPOINTMENTS para exigir Supabase", () => {
  const result = importConfigWith({
    ...baseEnv,
    WHATSAPP_APP_SECRET: "app-secret",
    REQUIRE_DB_FOR_APPOINTMENTS: "false",
    REQUIRE_SUPABASE_FOR_APPOINTMENTS: "true",
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: ""
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
});

test("si falta GOOGLE_CALENDAR_ID usa calendario azul y lo advierte en readiness", () => {
  const { GOOGLE_CALENDAR_ID: _googleCalendarId, ...envWithoutCalendarId } = baseEnv;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const { config } = await import('./src/config.js'); const { assessProductionReadiness } = await import('./src/readiness.js'); const readiness = assessProductionReadiness({ dbOk: true }); if (config.googleCalendarId !== 'b96c51c36ae4dc56e6618c6da02e4002a1810aacabf241a63380d58821f4c620@group.calendar.google.com') throw new Error(config.googleCalendarId); if (config.googleCalendarLabel !== 'calendario azul GINECOLOGIA INTEGRAL') throw new Error(config.googleCalendarLabel); if (config.googleCalendarIdConfigured !== false) throw new Error('expected default calendar'); if (config.googleBusyCalendarIds.length !== 2 || !config.googleBusyCalendarIds.includes(config.googleCalendarId) || !config.googleBusyCalendarIds.includes('ginecologiaintegralgto@gmail.com')) throw new Error('expected blue and legacy busy calendars'); if (!readiness.warnings.some((warning) => warning.includes('calendario azul'))) throw new Error('missing warning');"
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...envWithoutCalendarId,
        GOOGLE_CALENDAR_ID: "",
        WHATSAPP_APP_SECRET: "app-secret",
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test"
      },
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("AI_PROVIDER vacio o apagado usa parser local", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "globalThis.fetch = async () => { throw new Error('external fetch should not run'); }; const { config } = await import('./src/config.js'); const { understandMessage } = await import('./src/ai.js'); const parsed = await understandMessage('kiero cita', undefined); if (config.aiProvider !== 'local') throw new Error(config.aiProvider); if (parsed.intent !== 'schedule_appointment') throw new Error(parsed.intent);"
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...baseEnv,
        NODE_ENV: "test",
        AI_PROVIDER: "",
        OPENAI_API_KEY: "should-not-be-used",
        GEMINI_API_KEY: "should-not-be-used"
      },
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("rechaza GOOGLE_APPOINTMENT_SCHEDULE_URL invalida", () => {
  const result = importConfigWith({
    ...baseEnv,
    NODE_ENV: "test",
    GOOGLE_APPOINTMENT_SCHEDULE_URL: "no-es-url"
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GOOGLE_APPOINTMENT_SCHEDULE_URL/);
});

function importConfigWith(env) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./src/config.js')"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    encoding: "utf8"
  });
}
