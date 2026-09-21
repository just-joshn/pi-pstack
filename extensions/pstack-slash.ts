/**
 * pstack slash-command parity.
 *
 * In the original Cursor plugin, every pstack skill is a first-class slash
 * command: `/poteto-mode fix the login bug`, `/how does auth work?`,
 * `/interrogate review this pr`.
 *
 * pi exposes skills as `/skill:<name>`. This extension accepts the
 * Cursor-style spelling and transforms it to pi's native skill command right
 * before skill expansion, so both spellings work and arguments carry over.
 *
 * It only transforms exact matches of bundled pstack skill names; everything
 * else (built-in commands, other skills, templates) passes through untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SKILL_NAMES = [
	"architect",
	"arena",
	"automate-me",
	"blast-radius",
	"bro",
	"create-verification-skill",
	"figure-it-out",
	"how",
	"interrogate",
	"maintain-verification-skill",
	"make-bot-ui",
	"no-comments",
	"poteto-mode",
	"principle-attack-the-premise",
	"principle-boundary-discipline",
	"principle-build-the-lever",
	"principle-encode-lessons-in-structure",
	"principle-exhaust-the-design-space",
	"principle-experience-first",
	"principle-fix-root-causes",
	"principle-foundational-thinking",
	"principle-guard-the-context-window",
	"principle-laziness-protocol",
	"principle-make-operations-idempotent",
	"principle-migrate-callers-then-delete-legacy-apis",
	"principle-minimize-reader-load",
	"principle-model-the-domain",
	"principle-never-block-on-the-human",
	"principle-outcome-oriented-execution",
	"principle-prove-it-works",
	"principle-redesign-from-first-principles",
	"principle-separate-before-serializing-shared-state",
	"principle-sequence-verifiable-units",
	"principle-subtract-before-you-add",
	"principle-test-behavior-not-implementation",
	"principle-type-system-discipline",
	"recall",
	"reflect",
	"setup-pstack",
	"show-me-your-work",
	"swarm",
	"tdd",
	"teach",
	"technical-writing",
	"typescript-best-practices",
	"unslop",
	"why",
] as const;

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		// Never touch messages injected by extensions.
		if (event.source === "extension") return { action: "continue" };

		const text = event.text;
		if (!text.startsWith("/")) return { action: "continue" };

		const spaceIndex = text.indexOf(" ");
		const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		if (!(SKILL_NAMES as readonly string[]).includes(name)) return { action: "continue" };

		// "/poteto-mode fix the bug" -> "/skill:poteto-mode fix the bug"
		return {
			action: "transform",
			text: `/skill:${name}${spaceIndex === -1 ? "" : text.slice(spaceIndex)}`,
		};
	});
}
