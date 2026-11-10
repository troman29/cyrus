import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHubWebhookEvent } from "cyrus-github-event-transport";
import { describe, expect, it, vi } from "vitest";
import { loadShepherdConfig } from "../../src/shepherd/config.js";
import { EventRouter } from "../../src/shepherd/EventRouter.js";
import { normalize } from "../../src/shepherd/normalize.js";
import type { PrLookup, ShepherdEvent } from "../../src/shepherd/types.js";

function fixture(name: string, eventType: string): GitHubWebhookEvent {
	const payload = JSON.parse(
		readFileSync(join(__dirname, "../fixtures/github", `${name}.json`), "utf8"),
	);
	return { eventType, deliveryId: "d-1", payload } as GitHubWebhookEvent;
}

const lookupPr: PrLookup = vi.fn(async (_repo, pr) => ({
	title: `PR ${pr}`,
	author: pr === 1688 ? "someone" : "thomas5788",
	headRef: "feat/x",
	headSha: "abc1234def5678",
	baseRef: "dev",
}));

const config = loadShepherdConfig({ SHEPHERD_SOCKET: "/tmp/x.sock" });

const logger = () => ({
	info: vi.fn(),
	error: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
});

function router(
	sendResult: "persisted" | "duplicate" | Error,
	overrides: Partial<ConstructorParameters<typeof EventRouter>[0]> = {},
) {
	const sent: Array<{ deliveryId: string; event: ShepherdEvent }> = [];
	const log = logger();
	const instance = new EventRouter({
		config,
		lookupPr,
		logger: log as never,
		sendToHub: async (request) => {
			sent.push(request);
			if (sendResult instanceof Error) {
				throw sendResult;
			}
			return sendResult;
		},
		...overrides,
	});
	return { instance, sent, log };
}

describe("normalize", () => {
	it.each([
		["pull_request.opened", "pr_opened"],
		["pull_request.reopened", "pr_reopened"],
		["pull_request.ready_for_review", "pr_ready"],
		["pull_request.synchronize", "pr_synchronize"],
	])("maps %s to %s", async (name, kind) => {
		const [event] = await normalize(fixture(name, "pull_request"), lookupPr);
		expect(event).toEqual({
			repo: "windbit/agentek-console",
			pr: 1687,
			prUrl: "https://github.com/windbit/agentek-console/pull/1687",
			prTitle: "feat: shepherd",
			prAuthor: "thomas5788",
			headRef: "feat/x",
			headSha: "abc1234def5678",
			baseRef: "dev",
			actor: "thomas5788",
			at: "2026-11-11T00:00:00Z",
			kind,
		});
	});

	it("maps merged and unmerged closes", async () => {
		const [merged] = await normalize(
			fixture("pull_request.closed_merged", "pull_request"),
			lookupPr,
		);
		expect(merged).toMatchObject({
			kind: "pr_closed",
			merged: true,
			mergedBy: "troman29",
		});
		const [unmerged] = await normalize(
			fixture("pull_request.closed_unmerged", "pull_request"),
			lookupPr,
		);
		expect(unmerged).toMatchObject({ kind: "pr_closed", merged: false });
		expect(unmerged).not.toHaveProperty("mergedBy");
	});

	it("maps review, review comment and PR comment", async () => {
		const [review] = await normalize(
			fixture("pull_request_review.submitted", "pull_request_review"),
			lookupPr,
		);
		expect(review).toMatchObject({
			kind: "review",
			state: "changes_requested",
			id: 555,
			body: "Please fix",
			association: "OWNER",
			actor: "troman29",
			at: "2026-11-11T01:00:00Z",
		});
		const [reviewComment] = await normalize(
			fixture(
				"pull_request_review_comment.created",
				"pull_request_review_comment",
			),
			lookupPr,
		);
		expect(reviewComment).toMatchObject({
			kind: "review_comment",
			id: 777,
			path: "src/a.ts",
			line: 12,
			association: "COLLABORATOR",
		});
		const [comment] = await normalize(
			fixture("issue_comment.on_pr", "issue_comment"),
			lookupPr,
		);
		expect(comment).toMatchObject({
			kind: "comment",
			id: 888,
			prTitle: "PR 1687",
			headRef: "feat/x",
			association: "OWNER",
		});
	});

	it("emits one checks_completed event per PR of a suite", async () => {
		const events = await normalize(
			fixture("check_suite.completed_2_prs", "check_suite"),
			lookupPr,
		);
		expect(events.map((event) => event.pr)).toEqual([1687, 1688]);
		expect(events[0]).toMatchObject({
			kind: "checks_completed",
			conclusion: "failure",
			suiteId: 4242,
			app: "github-actions",
			headSha: "abc1234def5678",
			prAuthor: "thomas5788",
		});
		expect(
			await normalize(
				fixture("check_suite.completed_0_prs", "check_suite"),
				lookupPr,
			),
		).toEqual([]);
	});

	it("propagates lookup failures", async () => {
		await expect(
			normalize(
				fixture("check_suite.completed_1_pr", "check_suite"),
				async () => {
					throw new Error("api down");
				},
			),
		).rejects.toThrow("api down");
	});
});

describe("loadShepherdConfig", () => {
	it("defaults authors and socket, supports repo globs", () => {
		const defaults = loadShepherdConfig({ TELEGRAM_STATE_DIR: "/state" });
		expect(defaults.socketPath).toBe("/state/shepherd.sock");
		expect([...defaults.authors]).toEqual(["thomas5788", "agentek-bot[bot]"]);
		expect(defaults.repos).toBeUndefined();
		const scoped = loadShepherdConfig({
			SHEPHERD_REPOS: "windbit/*,troman29/homelab",
		});
		expect(scoped.repos?.some((glob) => glob.test("windbit/x"))).toBe(true);
		expect(scoped.repos?.some((glob) => glob.test("troman29/homelab"))).toBe(
			true,
		);
		expect(scoped.repos?.some((glob) => glob.test("evil/windbit/x"))).toBe(
			false,
		);
	});
});

describe("EventRouter", () => {
	it("forwards a PR event and answers true", async () => {
		const { instance, sent, log } = router("persisted");
		expect(
			await instance.handle(fixture("pull_request.opened", "pull_request")),
		).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0].deliveryId).toBe("d-1");
		expect(log.info).toHaveBeenCalledWith(
			"shepherd: forwarded delivery=d-1 repo=windbit/agentek-console#1687 kind=pr_opened",
		);
	});

	it("logs duplicate and still answers true", async () => {
		const { instance, log } = router("duplicate");
		expect(
			await instance.handle(fixture("pull_request.opened", "pull_request")),
		).toBe(true);
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("shepherd: duplicate delivery=d-1"),
		);
	});

	it("answers false when the hub fails", async () => {
		const { instance, log } = router(new Error("ECONNREFUSED"));
		expect(
			await instance.handle(fixture("pull_request.opened", "pull_request")),
		).toBe(false);
		expect(log.error).toHaveBeenCalledWith(
			expect.stringContaining("shepherd: failed delivery=d-1"),
			expect.any(Error),
		);
	});

	it("answers false when the PR lookup fails", async () => {
		const { instance, sent } = router("persisted", {
			lookupPr: async () => {
				throw new Error("api down");
			},
		});
		expect(
			await instance.handle(
				fixture("check_suite.completed_1_pr", "check_suite"),
			),
		).toBe(false);
		expect(sent).toHaveLength(0);
	});

	it.each([
		["pull_request.foreign_author", "pull_request", "author_not_allowed"],
		["pull_request_review.by_bot", "pull_request_review", "bot_sender"],
		["issue_comment.on_issue", "issue_comment", "not_pr"],
		["check_suite.completed_0_prs", "check_suite", "no_pull_requests"],
	])("drops %s with reason %s", async (name, eventType, reason) => {
		const { instance, sent, log } = router("persisted");
		expect(await instance.handle(fixture(name, eventType))).toBe(true);
		expect(sent).toHaveLength(0);
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining(
				`shepherd: dropped reason=${reason} delivery=d-1`,
			),
		);
	});

	it("drops repos outside the allowlist and push events", async () => {
		const scoped = router("persisted", {
			config: loadShepherdConfig({ SHEPHERD_REPOS: "troman29/*" }),
		});
		await scoped.instance.handle(
			fixture("pull_request.opened", "pull_request"),
		);
		expect(scoped.sent).toHaveLength(0);
		expect(scoped.log.info).toHaveBeenCalledWith(
			expect.stringContaining("reason=repo_not_allowed"),
		);
		const { instance, log } = router("persisted");
		await instance.handle({
			...fixture("pull_request.opened", "pull_request"),
			eventType: "push",
		});
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("reason=event_not_supported"),
		);
	});

	it("forwards only allowed-author PRs of a 2-PR suite with distinct delivery ids", async () => {
		const { instance, sent } = router("persisted");
		expect(
			await instance.handle(
				fixture("check_suite.completed_2_prs", "check_suite"),
			),
		).toBe(true);
		expect(sent.map((request) => request.deliveryId)).toEqual(["d-1#1687"]);
	});

	it("forwards a 1-PR suite under the plain delivery id", async () => {
		const { instance, sent } = router("persisted");
		await instance.handle(fixture("check_suite.completed_1_pr", "check_suite"));
		expect(sent.map((request) => request.deliveryId)).toEqual(["d-1"]);
	});
});
