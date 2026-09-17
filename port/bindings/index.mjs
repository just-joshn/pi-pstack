// Combined bindings exports split by domain to satisfy file size and cohesion rules.
// Order matters. Preserve original array order: core rules, then benny rules,
// then skill reference-path rules.

import { bindingsA } from "./rules-a.mjs";
import { bindingsBenny } from "./rules-benny.mjs";
import { bindingsLinks } from "./rules-links.mjs";
import { overrides } from "./overrides.mjs";
import { leftoverTokens, extras } from "./leftovers.mjs";

export const bindings = [...bindingsA, ...bindingsBenny, ...bindingsLinks];
export { overrides, leftoverTokens, extras };
