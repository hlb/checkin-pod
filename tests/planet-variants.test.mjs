import assert from "node:assert/strict";
import test from "node:test";

import {
  PLANET_PALETTES,
  PLANET_TYPES,
  planetAppearanceForId,
  planetAppearanceFromHash,
} from "../app/planet-variants.ts";

test("defines five palettes and six visually distinct planet types", () => {
  assert.equal(PLANET_PALETTES.length, 5);
  assert.deepEqual(PLANET_TYPES, [
    "rocky",
    "ringed",
    "banded",
    "cube",
    "molten",
    "crystal",
  ]);
});

test("maps one full cycle to exactly 30 palette and type combinations", () => {
  const appearances = Array.from({ length: 30 }, (_, hash) => planetAppearanceFromHash(hash));
  const combinations = new Set(
    appearances.map((appearance) => `${appearance.paletteIndex}:${appearance.type}`),
  );
  assert.equal(combinations.size, 30);

  for (let paletteIndex = 0; paletteIndex < PLANET_PALETTES.length; paletteIndex += 1) {
    assert.equal(appearances.filter((appearance) => appearance.paletteIndex === paletteIndex).length, 6);
  }
  for (const type of PLANET_TYPES) {
    assert.equal(appearances.filter((appearance) => appearance.type === type).length, 5);
  }
});

test("keeps the same attendee on the same planet appearance", () => {
  const first = planetAppearanceForId("guest-a-stable-id");
  const second = planetAppearanceForId("guest-a-stable-id");
  assert.deepEqual(second, first);
  assert.ok(first.combinationIndex >= 0 && first.combinationIndex < 30);
});

test("the first 100 generated sample attendees visibly exercise all 30 combinations", () => {
  const appearances = Array.from({ length: 100 }, (_, index) => {
    const number = String(index + 1).padStart(3, "0");
    return planetAppearanceForId(`gst-sample-${number}-${index}`);
  });
  assert.equal(new Set(appearances.map((appearance) => appearance.combinationIndex)).size, 30);
  for (const type of PLANET_TYPES) {
    assert.ok(appearances.filter((appearance) => appearance.type === type).length >= 10);
  }
});
