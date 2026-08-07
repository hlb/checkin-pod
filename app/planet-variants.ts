export const PLANET_PALETTES = [
  ["#57E5E5", "#176E83", "#072A3B"],
  ["#FFD84A", "#D5762C", "#552817"],
  ["#A89BFF", "#6654C8", "#251F58"],
  ["#6EE7A1", "#2E956D", "#123D36"],
  ["#FF8F79", "#CB4F67", "#4D213C"],
] as const;

export const PLANET_TYPES = [
  "rocky",
  "ringed",
  "banded",
  "cratered",
  "molten",
  "crystal",
] as const;

export type PlanetType = (typeof PLANET_TYPES)[number];

export const PLANET_TYPE_LABELS: Record<PlanetType, string> = {
  rocky: "地貌星球",
  ringed: "光環星球",
  banded: "氣態條紋星球",
  cratered: "隕石坑星球",
  molten: "熔岩星球",
  crystal: "晶體星球",
};

export function hashText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function planetAppearanceFromHash(hash: number) {
  const normalizedHash = hash >>> 0;
  const combinationIndex = normalizedHash % (PLANET_PALETTES.length * PLANET_TYPES.length);
  const paletteIndex = combinationIndex % PLANET_PALETTES.length;
  const typeIndex = Math.floor(combinationIndex / PLANET_PALETTES.length);
  const type = PLANET_TYPES[typeIndex];
  return {
    combinationIndex,
    paletteIndex,
    typeIndex,
    type,
    typeLabel: PLANET_TYPE_LABELS[type],
    palette: PLANET_PALETTES[paletteIndex],
  };
}

export function planetAppearanceForId(attendeeId: string) {
  return planetAppearanceFromHash(hashText(attendeeId));
}
