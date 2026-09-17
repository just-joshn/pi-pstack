import { expect, test } from "vitest";
import {
  MARKETING_SLUG_MAP,
  MARKETING_SLUG_TIERS,
  MARKETING_TIERS,
  SKILL_DEFAULT_JUDGMENT,
  TIER_PROVIDER_MAP,
  marketingTierRank,
  normalizeModelSelector,
  type MarketingTier,
} from "../../../extensions/models/config.ts";

const SLUGS = Object.keys(MARKETING_SLUG_MAP);

function idRank(id: string): number | undefined {
  const tier = Object.entries(TIER_PROVIDER_MAP).find(([, mapped]) => mapped === id)?.[0];
  return tier ? marketingTierRank(tier as MarketingTier) : undefined;
}

test("models-tier-01 every slug carries a tier and derives its provider/id from it", () => {
  expect([...MARKETING_TIERS]).toEqual(["fast", "medium", "high", "max"]);
  expect(Object.keys(TIER_PROVIDER_MAP)).toEqual([...MARKETING_TIERS]);
  expect(Object.keys(MARKETING_SLUG_TIERS), "no slug may exist without a tier").toEqual(SLUGS);

  for (const slug of SLUGS) {
    const tier = MARKETING_SLUG_TIERS[slug];
    expect(tier, `${slug} needs a tier`).toBeTruthy();
    expect(MARKETING_SLUG_MAP[slug], `${slug} must derive its id from its tier`).toBe(TIER_PROVIDER_MAP[tier]);
  }
});

test("models-tier-02 the whole table is monotone in tier, so no pair can invert", () => {
  const ranks = MARKETING_TIERS.map((tier) => idRank(TIER_PROVIDER_MAP[tier]));
  expect(ranks, "each tier maps to a distinct, ordered real model").toEqual([0, 1, 2, 3]);

  for (const a of SLUGS) {
    for (const b of SLUGS) {
      const tierA = marketingTierRank(MARKETING_SLUG_TIERS[a]);
      const tierB = marketingTierRank(MARKETING_SLUG_TIERS[b]);
      const rankA = idRank(MARKETING_SLUG_MAP[a]) ?? -1;
      const rankB = idRank(MARKETING_SLUG_MAP[b]) ?? -1;
      expect(tierA >= tierB, `${a} vs ${b}: a higher tier must resolve to a model at least as capable`).toBe(rankA >= rankB);
    }
  }
});

test("models-tier-03 the judgment default is the strongest slug in the map", () => {
  const tier = MARKETING_SLUG_TIERS[SKILL_DEFAULT_JUDGMENT];
  expect(tier, "the judgment slug must carry a tier").toBeTruthy();
  const top = MARKETING_TIERS.at(-1);
  expect(tier, "the judgment slug must sit at the top tier").toBe(top);
  expect(MARKETING_SLUG_MAP[SKILL_DEFAULT_JUDGMENT]).toBe("anthropic/claude-opus-4-5");

  for (const slug of SLUGS) {
    expect(marketingTierRank(MARKETING_SLUG_TIERS[slug]) <= marketingTierRank(top as MarketingTier), `${slug} must not outrank the judgment default`).toBeTruthy();
  }
});

test("models-tier-04 unmapped bare slugs stay refused while every mapped slug resolves", () => {
  const refused = normalizeModelSelector("totally-unknown-model");
  expect(refused.ok).toBe(false);
  expect(refused.ok ? "" : refused.error).toMatch(/Refused bare model slug 'totally-unknown-model'/);

  for (const slug of SLUGS) {
    const resolved = normalizeModelSelector(slug);
    expect(resolved.ok, `${slug} must resolve`).toBe(true);
    expect(resolved.ok ? resolved.model : "").toBe(MARKETING_SLUG_MAP[slug]);
  }
});
