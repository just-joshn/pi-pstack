/** Tab-separated ledger parsing. Every ledger file carries the same header line. */

export function parseTsv(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const [headerLine, ...dataLines] = lines;
  const header = headerLine.split("\t");
  return dataLines.map((line) => {
    const cells = line.split("\t");
    return Object.fromEntries(header.map((key, index) => [key, cells[index] ?? ""]));
  });
}

/** Split a cell such as "9, 12" into trimmed non-empty tokens. */
export function splitList(value) {
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
