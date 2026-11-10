import type {
	GitHubCheckSuitePayload,
	GitHubIssueCommentPayload,
	GitHubPullRequest,
	GitHubPullRequestPayload,
	GitHubPullRequestReviewCommentPayload,
	GitHubPullRequestReviewPayload,
	GitHubWebhookEvent,
} from "cyrus-github-event-transport";
import type { PrLookup, ShepherdEvent } from "./types.js";

const DEFAULT_ASSOCIATION = "NONE";

const PR_ACTION_KINDS = {
	opened: "pr_opened",
	reopened: "pr_reopened",
	ready_for_review: "pr_ready",
	synchronize: "pr_synchronize",
} as const;

function baseFromPr(
	repo: string,
	pr: GitHubPullRequest,
	actor: string,
	at: string,
) {
	return {
		repo,
		pr: pr.number,
		prUrl: pr.html_url,
		prTitle: pr.title,
		prAuthor: pr.user.login,
		headRef: pr.head.ref,
		headSha: pr.head.sha,
		baseRef: pr.base.ref,
		actor,
		at,
	};
}

/**
 * Webhook -> events for the hub; empty when the event carries nothing
 * (unknown action, check_suite without PRs). Throws when the PR lookup
 * fails, so the caller can answer 503 and let GitHub redeliver.
 */
export async function normalize(
	event: GitHubWebhookEvent,
	lookupPr: PrLookup,
	now: () => Date = () => new Date(),
): Promise<ShepherdEvent[]> {
	const payload = event.payload;
	const repo = (payload as { repository: { full_name: string } }).repository
		.full_name;
	const actor = (payload as { sender: { login: string } }).sender.login;

	switch (event.eventType) {
		case "pull_request": {
			const { action, pull_request: pr } = payload as GitHubPullRequestPayload;
			const at = pr.updated_at ?? now().toISOString();
			const base = baseFromPr(repo, pr, actor, at);
			if (action === "closed") {
				return [
					{
						...base,
						kind: "pr_closed",
						merged: pr.merged === true,
						...(pr.merged_by ? { mergedBy: pr.merged_by.login } : {}),
					},
				];
			}
			if (action in PR_ACTION_KINDS) {
				const kind = PR_ACTION_KINDS[action as keyof typeof PR_ACTION_KINDS];
				return [{ ...base, kind }];
			}
			return [];
		}
		case "pull_request_review": {
			const { review, pull_request: pr } =
				payload as GitHubPullRequestReviewPayload;
			return [
				{
					...baseFromPr(repo, pr, actor, review.submitted_at),
					kind: "review",
					state: review.state,
					id: review.id,
					body: review.body ?? "",
					url: review.html_url,
					association: review.author_association ?? DEFAULT_ASSOCIATION,
				},
			];
		}
		case "pull_request_review_comment": {
			const { comment, pull_request: pr } =
				payload as GitHubPullRequestReviewCommentPayload;
			return [
				{
					...baseFromPr(repo, pr, actor, comment.created_at),
					kind: "review_comment",
					id: comment.id,
					body: comment.body,
					path: comment.path ?? "",
					...(typeof comment.line === "number" ? { line: comment.line } : {}),
					url: comment.html_url,
					association: comment.author_association ?? DEFAULT_ASSOCIATION,
				},
			];
		}
		case "issue_comment": {
			const { issue, comment } = payload as GitHubIssueCommentPayload;
			// The payload has no head/base of the PR; fetch them with title and author.
			const meta = await lookupPr(repo, issue.number);
			return [
				{
					repo,
					pr: issue.number,
					prUrl: issue.pull_request?.html_url ?? issue.html_url,
					prTitle: meta.title,
					prAuthor: meta.author,
					headRef: meta.headRef,
					headSha: meta.headSha,
					baseRef: meta.baseRef,
					actor,
					at: comment.created_at,
					kind: "comment",
					id: comment.id,
					body: comment.body,
					url: comment.html_url,
					association: comment.author_association ?? DEFAULT_ASSOCIATION,
				},
			];
		}
		case "check_suite": {
			const { check_suite: suite } = payload as GitHubCheckSuitePayload;
			return Promise.all(
				suite.pull_requests.map(async (pr) => {
					const meta = await lookupPr(repo, pr.number);
					return {
						repo,
						pr: pr.number,
						prUrl: `https://github.com/${repo}/pull/${pr.number}`,
						prTitle: meta.title,
						prAuthor: meta.author,
						headRef: pr.head.ref,
						headSha: suite.head_sha,
						baseRef: pr.base.ref,
						actor,
						at: suite.updated_at,
						kind: "checks_completed" as const,
						conclusion: suite.conclusion ?? "unknown",
						suiteId: suite.id,
						app: suite.app.slug,
					};
				}),
			);
		}
		default:
			return [];
	}
}
