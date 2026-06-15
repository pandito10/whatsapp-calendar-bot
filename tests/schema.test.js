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
