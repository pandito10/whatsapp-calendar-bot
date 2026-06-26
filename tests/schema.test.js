import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("indice unico de citas confirmadas solo bloquea slots con google_event_id", () => {
  const schema = readFileSync(`${repoRoot}/supabase/schema.sql`, "utf8");
  const migration = readFileSync(`${repoRoot}/supabase/migration-existing.sql`, "utf8");

  for (const sql of [schema, migration]) {
    assert.match(sql, /drop index if exists citas_confirmed_slot_start_unique_idx/i);
    assert.match(sql, /citas_confirmed_slot_start_with_event_unique_idx/i);
    assert.match(sql, /where status = 'confirmed' and nullif\(google_event_id, ''\) is not null/i);
  }
});

test("render y README documentan plantillas Meta operativas", () => {
  const renderYaml = readFileSync(`${repoRoot}/render.yaml`, "utf8");
  const readme = readFileSync(`${repoRoot}/README.md`, "utf8");
  const templateScript = readFileSync(`${repoRoot}/scripts/create-whatsapp-templates.js`, "utf8");

  for (const key of [
    "WHATSAPP_REENGAGEMENT_TEMPLATE",
    "WHATSAPP_RESULTS_EMAIL_TEMPLATE",
    "WHATSAPP_REMINDER_TEMPLATE_24H",
    "WHATSAPP_REMINDER_TEMPLATE_2H",
    "WHATSAPP_CANCELLATION_TEMPLATE",
    "WHATSAPP_RESCHEDULE_TEMPLATE",
    "WHATSAPP_TEMPLATE_LANGUAGE"
  ]) {
    assert.match(renderYaml, new RegExp(key));
    assert.match(readme, new RegExp(key));
  }

  assert.match(readme, /scripts\/create-whatsapp-templates\.js/);
  assert.match(readme, /WHATSAPP_TOKEN=tu_token_con_management/);
  assert.match(readme, /--dry-run/);
  assert.match(readme, /Variables que usa cada plantilla/);
  assert.match(readme, /cancelacion_cita/);
  assert.match(readme, /reagenda_cita/);

  assert.match(templateScript, /WHATSAPP_TOKEN/);
  assert.match(templateScript, /WHATSAPP_ACCESS_TOKEN/);
  assert.match(templateScript, /--dry-run/);
  assert.match(templateScript, /printRenderEnvChecklist/);
});

test("schema incluye CRM persistente de pacientes", () => {
  const sqlFiles = [
    readFileSync(`${repoRoot}/supabase/schema.sql`, "utf8"),
    readFileSync(`${repoRoot}/supabase/migration-existing.sql`, "utf8")
  ];

  for (const sql of sqlFiles) {
    assert.match(sql, /create table if not exists public\.patients/i);
    assert.match(sql, /phone_number text primary key/i);
    assert.match(sql, /next_appointment_at timestamptz/i);
    assert.match(sql, /appointment_count integer not null default 0/i);
    assert.match(sql, /patients_status_check/i);
    assert.match(sql, /public\.patients/i);
  }
});
