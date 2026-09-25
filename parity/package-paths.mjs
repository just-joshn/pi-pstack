import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function packagePathsAt(absoluteRoot) {
	if (!isAbsolute(absoluteRoot)) throw new TypeError(`package root must be absolute: ${absoluteRoot}`);
	const packageRoot = resolve(absoluteRoot);
	const parityRoot = join(packageRoot, "parity");
	const upstreamRoot = join(parityRoot, "upstream");
	return Object.freeze({
		packageRoot,
		parityRoot,
		skillsRoot: join(packageRoot, "skills"),
		agentsRoot: join(packageRoot, "agents"),
		extensionsRoot: join(packageRoot, "extensions"),
		upstreamRoot,
		upstreamPreviousRoot: join(upstreamRoot, "0.15.5"),
		upstreamCurrentRoot: join(upstreamRoot, "current"),
		additionsFile: join(parityRoot, "pi-additions.tsv"),
	});
}

export const packagePaths = packagePathsAt(dirname(dirname(fileURLToPath(import.meta.url))));
