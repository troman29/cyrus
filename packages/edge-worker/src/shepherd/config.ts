import { homedir } from "node:os";
import { join } from "node:path";
import type { HubTarget, ShepherdConfig } from "./types.js";

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

const PRIMARY_HUB_NAME = "primary";

function parseHub(entry: string): HubTarget {
	const separator = entry.indexOf("=");
	const name = entry.slice(0, separator).trim();
	const target = entry.slice(separator + 1).trim();
	if (separator < 1 || !name) {
		throw new Error(`SHEPHERD_HUBS: expected name=target, got "${entry}"`);
	}
	if (target.startsWith("unix:") && target.length > "unix:".length) {
		return {
			name,
			primary: false,
			kind: "unix",
			socketPath: target.slice("unix:".length),
		};
	}
	if (/^https?:\/\/[^/]/.test(target)) {
		return {
			name,
			primary: false,
			kind: "http",
			baseUrl: target.replace(/\/+$/, ""),
		};
	}
	throw new Error(
		`SHEPHERD_HUBS: hub "${name}" target must be unix:/path or http(s)://host:port`,
	);
}

/** Primary is the entry named `primary`, else the first one. */
function parseHubs(list: string[]): HubTarget[] {
	const parsed = list.map(parseHub);
	if (new Set(parsed.map((hub) => hub.name)).size !== parsed.length) {
		throw new Error("SHEPHERD_HUBS: hub names must be unique");
	}
	const primaryName = parsed.some((hub) => hub.name === PRIMARY_HUB_NAME)
		? PRIMARY_HUB_NAME
		: parsed[0]?.name;
	return parsed.map((hub) => ({ ...hub, primary: hub.name === primaryName }));
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
	const hubList = split(env.SHEPHERD_HUBS ?? "");
	const accounts = split(env.SHEPHERD_ACCOUNTS ?? "");
	const hubs: HubTarget[] =
		hubList.length > 0
			? parseHubs(hubList)
			: [
					{
						name: PRIMARY_HUB_NAME,
						primary: true,
						kind: "unix",
						socketPath: env.SHEPHERD_SOCKET || join(stateDir, "shepherd.sock"),
					},
				];
	return {
		hubs,
		hubToken: env.SHEPHERD_HUB_TOKEN || undefined,
		accounts:
			accounts.length > 0
				? new Set(accounts.map((owner) => owner.toLowerCase()))
				: undefined,
		authors: new Set(
			split(env.SHEPHERD_AUTHORS || DEFAULT_AUTHORS).map((login) =>
				login.toLowerCase(),
			),
		),
		repos: repos.length > 0 ? repos.map(globToRegExp) : undefined,
	};
}
