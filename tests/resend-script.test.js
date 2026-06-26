import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("script de Resend valida dry-run sin imprimir secretos", () => {
  const result = spawnSync(process.execPath, ["scripts/test-resend.js", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      RESEND_API_KEY: "re_test_secret_value",
      RESEND_FROM_EMAIL: "resultados@ginecologiaintegralgto.com",
      RESEND_TEST_TO_EMAIL: "recepcion@example.com"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry-run correcto/);
  assert.match(result.stdout, /r\*\*\*@ginecologiaintegralgto\.com/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /re_test_secret_value/);
});

test("script de Resend falla claro si faltan variables", () => {
  const result = spawnSync(process.execPath, ["scripts/test-resend.js", "--dry-run"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      RESEND_API_KEY: "",
      RESEND_FROM_EMAIL: "",
      RESEND_TEST_TO_EMAIL: ""
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Faltan variables para probar Resend/);
});
