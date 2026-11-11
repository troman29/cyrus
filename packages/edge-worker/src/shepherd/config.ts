import { homedir } from "node:os";
import { join } from "node:path";
import type { ShepherdConfig } from "./types.js";

const DEFAULT_AUTHORS = "thomas5788,agentek-bot[bot]";

export function isShepherdEnabled(env: NodeJS.ProcessEnv): boolean {
	return env.SHEPHERD_ENABLED === "1";
}

function globToRegExp(glob: string): RegExp {
	const escaped = glob
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "i");
}

export function loadShepherdConfig(env: NodeJS.ProcessEnv): ShepherdConfig {
	const stateDir =
		env.TELEGRAM_STATE_DIR || join(homedir(), ".claude/channels/telegram");
	const split = (value: string): string[] =>
		value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	const repos = split(env.SHEPHERD_REPOS ?? "");
	return {
		socketPath: env.SHEPHERD_SOCKET || join(stateDir, "shepherd.sock"),
		authors: new Set(
			split(env.SHEPHERD_AUTHORS || DEFAULT_AUTHORS).map((login) =>
				login.toLowerCase(),
			),
		),
		repos: repos.length > 0 ? repos.map(globToRegExp) : undefined,
	};
}
