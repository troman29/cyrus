import type { GitHubWebhookEvent } from "cyrus-github-event-transport";
import type { ShepherdConfig, ShepherdEvent } from "./types.js";

export type DropReason =
	| "repo_not_allowed"
	| "not_pr"
	| "event_not_supported"
	| "bot_sender"
	| "author_not_allowed"
	| "no_pull_requests";

const HUMAN_EVENTS = new Set([
	"issue_comment",
	"pull_request_review",
	"pull_request_review_comment",
]);

/** Cheap checks on the raw webhook, before any normalization or API call. */
export function rawDropReason(
	event: GitHubWebhookEvent,
	config: ShepherdConfig,
): DropReason | undefined {
	const payload = event.payload as {
		repository: { full_name: string };
		sender: { login: string; type: string };
		issue?: { pull_request?: unknown };
	};
	if (
		config.repos &&
		!config.repos.some((glob) => glob.test(payload.repository.full_name))
	) {
		return "repo_not_allowed";
	}
	if (event.eventType === "push") {
		return "event_not_supported";
	}
	if (event.eventType === "issue_comment" && !payload.issue?.pull_request) {
		return "not_pr";
	}
	// The agent writes as an author account itself; its own text must not loop back.
	if (
		HUMAN_EVENTS.has(event.eventType) &&
		(payload.sender.type === "Bot" ||
			config.authors.has(payload.sender.login.toLowerCase()))
	) {
		return "bot_sender";
	}
	return undefined;
}

export function eventDropReason(
	event: ShepherdEvent,
	config: ShepherdConfig,
): DropReason | undefined {
	return config.authors.has(event.prAuthor.toLowerCase())
		? undefined
		: "author_not_allowed";
}
