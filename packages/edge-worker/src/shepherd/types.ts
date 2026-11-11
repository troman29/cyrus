/**
 * ShepherdEvent: wire format of op `pr-event` v1 on shepherd.sock.
 * The hub validates strictly (unknown kind or extra fields are rejected),
 * so normalize.ts must emit exactly these fields.
 */

export interface ShepherdEventBase {
	repo: string;
	pr: number;
	prUrl: string;
	prTitle: string;
	prAuthor: string;
	headRef: string;
	headSha: string;
	baseRef: string;
	actor: string;
	at: string;
}

export type ShepherdEvent = ShepherdEventBase &
	(
		| {
				kind: "pr_opened" | "pr_reopened" | "pr_ready" | "pr_synchronize";
		  }
		| { kind: "pr_closed"; merged: boolean; mergedBy?: string }
		| {
				kind: "checks_completed";
				conclusion: string;
				suiteId: number;
				app: string;
		  }
		| {
				kind: "review";
				state: "approved" | "changes_requested" | "commented";
				id: number;
				body: string;
				url: string;
				association: string;
		  }
		| {
				kind: "review_comment";
				id: number;
				body: string;
				path: string;
				line?: number;
				url: string;
				association: string;
		  }
		| {
				kind: "comment";
				id: number;
				body: string;
				url: string;
				association: string;
		  }
	);

export type ShepherdEventKind = ShepherdEvent["kind"];

/** PR fields absent from check_suite / issue_comment payloads; fetched from the API. */
export interface PrMeta {
	title: string;
	author: string;
	headRef: string;
	headSha: string;
	baseRef: string;
}

/** installationToken is the one forwarded with the webhook, if any. */
export type PrLookup = (
	repo: string,
	pr: number,
	installationToken?: string,
) => Promise<PrMeta>;

export interface ShepherdConfig {
	socketPath: string;
	/** Lower-cased PR author logins we shepherd. */
	authors: ReadonlySet<string>;
	/** Repo globs (`owner/name`, `owner/*`); undefined allows every repo. */
	repos?: readonly RegExp[];
}
