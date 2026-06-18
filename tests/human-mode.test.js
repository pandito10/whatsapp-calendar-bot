import test from "node:test";
import assert from "node:assert/strict";

import { isHumanPauseExpiredState } from "../src/human-mode.js";

test("modo humano pausado expira despues del timeout configurado", () => {
  const now = Date.parse("2030-06-17T18:00:00.000Z");
  const state = {
    botPaused: true,
    botPausedAt: "2030-06-17T15:59:00.000Z"
  };

  assert.equal(isHumanPauseExpiredState(state, 120, now), true);
});

test("modo humano no expira antes del timeout ni si falta fecha valida", () => {
  const now = Date.parse("2030-06-17T18:00:00.000Z");

  assert.equal(isHumanPauseExpiredState({ botPaused: true, botPausedAt: "2030-06-17T16:30:00.000Z" }, 120, now), false);
  assert.equal(isHumanPauseExpiredState({ botPaused: true, botPausedAt: "fecha-mala" }, 120, now), false);
  assert.equal(isHumanPauseExpiredState({ botPaused: false, botPausedAt: "2030-06-17T15:00:00.000Z" }, 120, now), false);
});
