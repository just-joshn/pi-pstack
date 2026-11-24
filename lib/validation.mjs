/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} source @param {string} label @returns {unknown} */
export function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // oxlint-disable-next-line eslint/preserve-caught-error -- JSON.parse errors may expose file contents.
    throw new Error(`Invalid JSON in ${label}`);
  }
}
