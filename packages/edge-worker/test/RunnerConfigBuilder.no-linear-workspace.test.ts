// Regression: buildIssueConfig threw for repos without Linear, mid-webhook — after the worktree
// was created and the session registered.
import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function buildFor(repository: RepositoryConfig, linearWorkspaceId?: string) {
	const seen: string[] = [];
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: (_repoId: string, workspaceId: string) => {
			seen.push(workspaceId);
			return {};
		},
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" as const }),
		getDefaultModelForRunner: () => "opus",
		getDefaultFallbackModelForRunner: () => "sonnet",
	};
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};

	const builder = new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);

	const result = builder.buildIssueConfig({
		session: {
			issueId: "issue-1",
			issue: { identifier: "PR-688" },
			workspace: { path: "/ws/root", isGitWorktree: true },
		} as unknown as CyrusAgentSession,
		repository,
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId,
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => {
			throw new Error("Repository is not linked to a Linear workspace");
		},
	});
	return { result, seen };
}

const githubOnlyRepo = {
	id: "agentek-console",
	name: "agentek-console",
	repositoryPath: "/repos/agentek-console",
	githubUrl: "https://github.com/windbit/agentek-console",
	allowedTools: [],
} as unknown as RepositoryConfig;

describe("RunnerConfigBuilder without a Linear workspace", () => {
	it("does not throw for a GitHub-only repo and passes an empty workspace id", () => {
		const { result, seen } = buildFor(githubOnlyRepo);

		expect(result.config.workingDirectory).toBe("/ws/root");
		expect(seen).toEqual([""]);
	});

	it("uses the repository linearWorkspaceId when present", () => {
		const linked = {
			...githubOnlyRepo,
			linearWorkspaceId: "ws-from-repo",
		} as RepositoryConfig;

		expect(buildFor(linked).seen).toEqual(["ws-from-repo"]);
	});

	it("prefers the explicit argument over the repository value", () => {
		const linked = {
			...githubOnlyRepo,
			linearWorkspaceId: "ws-from-repo",
		} as RepositoryConfig;

		expect(buildFor(linked, "ws-explicit").seen).toEqual(["ws-explicit"]);
	});
});
