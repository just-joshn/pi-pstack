export function bestEffort(what, operation) {
  try {
    operation();
  } catch (error) {
    if (process.env.PSTACK_DEBUG) console.error(`${what} skipped:`, error);
  }
}
