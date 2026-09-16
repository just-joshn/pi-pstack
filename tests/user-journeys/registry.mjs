/**
 * The user-journey table.
 *
 * Concatenates one file per workstream. Each journey is `{ id, title, critical, surfaces, run }`;
 * ids must be unique and every entry is critical. W2-W5 replace their own placeholder file.
 */
import { JOURNEYS as installJourneys } from "./journeys/install.mjs";
import { JOURNEYS as routingJourneys } from "./journeys/routing.mjs";
import { JOURNEYS as orchestrateJourneys } from "./journeys/orchestrate.mjs";
import { JOURNEYS as toolingJourneys } from "./journeys/tooling.mjs";
import { JOURNEYS as knowledgeJourneys } from "./journeys/knowledge.mjs";

export const JOURNEYS = [
  ...installJourneys,
  ...routingJourneys,
  ...orchestrateJourneys,
  ...toolingJourneys,
  ...knowledgeJourneys,
];
