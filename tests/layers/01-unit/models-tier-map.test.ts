import { test } from "node:test";
import assert from "node:assert/strict";
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
  assert.deepEqual([...MARKETING_TIERS], ["fast", "medium", "high", "max"]);
  assert.deepEqual(Object.keys(TIER_PROVIDER_MAP), [...MARKETING_TIERS]);
  assert.deepEqual(Object.keys(MARKETING_SLUG_TIERS), SLUGS, "no slug may exist without a tier");

  for (const slug of SLUGS) {
    const tier = MARKETING_SLUG_TIERS[slug];
    assert.ok(tier, `${slug} needs a tier`);
    assert.equal(MARKETING_SLUG_MAP[slug], TIER_PROVIDER_MAP[tier], `${slug} must derive its id from its tier`);
  }
});

test("models-tier-02 the whole table is monotone in tier, so no pair can invert", () => {
  const ranks = MARKETING_TIERS.map((tier) => idRank(TIER_PROVIDER_MAP[tier]));
  assert.deepEqual(ranks, [0, 1, 2, 3], "each tier maps to a distinct, ordered real model");

  for (const a of SLUGS) {
    for (const b of SLUGS) {
      const tierA = marketingTierRank(MARKETING_SLUG_TIERS[a]);
      const tierB = marketingTierRank(MARKETING_SLUG_TIERS[b]);
      const rankA = idRank(MARKETING_SLUG_MAP[a]) ?? -1;
      const rankB = idRank(MARKETING_SLUG_MAP[b]) ?? -1;
      assert.equal(
        tierA >= tierB,
        rankA >= rankB,
        `${a} vs ${b}: a higher tier must resolve to a model at least as capable`,
      );
    }
  }
});

test("models-tier-03 the judgment default is the strongest slug in the map", () => {
  const tier = MARKETING_SLUG_TIERS[SKILL_DEFAULT_JUDGMENT];
  assert.ok(tier, "the judgment slug must carry a tier");
  const top = MARKETING_TIERS.at(-1);
  assert.equal(tier, top, "the judgment slug must sit at the top tier");
  assert.equal(MARKETING_SLUG_MAP[SKILL_DEFAULT_JUDGMENT], "anthropic/claude-opus-4-5");

  for (const slug of SLUGS) {
    assert.ok(
      marketingTierRank(MARKETING_SLUG_TIERS[slug]) <= marketingTierRank(top as MarketingTier),
      `${slug} must not outrank the judgment default`,
    );
  }
});

test("models-tier-04 unmapped bare slugs stay refused while every mapped slug resolves", () => {
  const refused = normalizeModelSelector("totally-unknown-model");
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.error, /Refused bare model slug 'totally-unknown-model'/);

  for (const slug of SLUGS) {
    const resolved = normalizeModelSelector(slug);
    assert.equal(resolved.ok, true, `${slug} must resolve`);
    assert.equal(resolved.ok ? resolved.model : "", MARKETING_SLUG_MAP[slug]);
  }
});
