/**
 * Runtime behavior inventory for the user-journey suite.
 *
 * Behavior units are derived from the loaded surface, never hand-listed, so a new command or a
 * new tool action cannot silently escape the coverage contract.
 *
 * - one unit per registered slash command: `command:/<name>`
 * - for a tool whose `action` schema names choices: one unit per choice, `tool:<name>#<choice>`
 * - otherwise: one unit, `tool:<name>`
 *
 * Action choices come from an `enum` array, an `anyOf`/`oneOf` array of `{ const }` or
 * `{ enum: [x] }` variants, or a string `description` of `a | b | c` tokens.
 */

function enumChoices(schema) {
  if (!Array.isArray(schema?.enum)) return [];
  return schema.enum.filter((value) => typeof value === "string");
}

function unionChoices(schema) {
  const variants = Array.isArray(schema?.anyOf) ? schema.anyOf : Array.isArray(schema?.oneOf) ? schema.oneOf : [];
  return variants.flatMap((variant) => {
    if (typeof variant?.const === "string") return [variant.const];
    return enumChoices(variant);
  });
}

function descriptionChoices(schema) {
  if (typeof schema?.description !== "string" || !schema.description.includes("|")) return [];
  return schema.description
    .split("|")
    .map((token) => token.trim())
    .filter((token) => /^[a-z][a-z-]*$/.test(token));
}

function actionChoices(definition) {
  const action = definition?.parameters?.properties?.action;
  if (action === undefined) return [];
  const direct = enumChoices(action);
  if (direct.length > 0) return direct;
  const union = unionChoices(action);
  if (union.length > 0) return union;
  return descriptionChoices(action);
}

function commandUnits(commands) {
  return [...commands.keys()].map((name) => ({ id: `command:/${name}`, kind: "command", label: `/${name}` }));
}

function toolUnits(tools) {
  return [...tools.entries()].flatMap(([name, definition]) => {
    const choices = actionChoices(definition);
    if (choices.length === 0) return [{ id: `tool:${name}`, kind: "tool", label: name }];
    return choices.map((choice) => ({ id: `tool:${name}#${choice}`, kind: "tool", label: `${name}#${choice}` }));
  });
}

export function buildInventory({ commands, tools }) {
  const units = [...commandUnits(commands), ...toolUnits(tools)].toSorted((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  return { units, total: units.length, byId };
}
