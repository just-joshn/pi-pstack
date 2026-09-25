import { relative, resolve, sep } from "node:path";

export function resolveSkillReference(skillsRoot, referringFile, reference) {
	const relativeFile = relative(skillsRoot, referringFile);
	const [skillName] = relativeFile.split(sep);
	if (!skillName || skillName === "..") {
		throw new TypeError(`skill file is outside the skills root: ${referringFile}`);
	}
	return resolve(skillsRoot, skillName, reference);
}
