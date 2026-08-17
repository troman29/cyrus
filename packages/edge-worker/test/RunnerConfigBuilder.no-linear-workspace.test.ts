// Регрессия: GitHub-триггер на репозитории без Linear.
//
// buildIssueConfig звал requireLinearWorkspaceId, который бросает. Ломалось это не на старте,
// а в середине обработки вебхука — worktree уже создан, сессия уже заведена, и тут исключение:
//
//   Failed to process GitHub webhook Error: Repository "agentek-console" is not linked to a
//   Linear workspace ... at RunnerConfigBuilder.buildIssueConfig
//
// Пустой workspace id ниже по стеку обрабатывается штатно: токена для него нет, и buildMcpConfig
// уходит в ветку «CLI platform mode» без cyrus-tools.
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
		// Осталось в контракте ради Linear-путей; для GitHub-репозитория звать его нельзя.
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

describe("RunnerConfigBuilder без Linear-воркспейса", () => {
	it("не бросает для GitHub-репозитория и отдаёт пустой workspace id", () => {
		const { result, seen } = buildFor(githubOnlyRepo);

		expect(result.config.workingDirectory).toBe("/ws/root");
		expect(seen).toEqual([""]);
	});

	it("использует linearWorkspaceId репозитория, когда он есть", () => {
		const linked = {
			...githubOnlyRepo,
			linearWorkspaceId: "ws-from-repo",
		} as RepositoryConfig;

		expect(buildFor(linked).seen).toEqual(["ws-from-repo"]);
	});

	it("явный аргумент важнее значения из репозитория", () => {
		const linked = {
			...githubOnlyRepo,
			linearWorkspaceId: "ws-from-repo",
		} as RepositoryConfig;

		expect(buildFor(linked, "ws-explicit").seen).toEqual(["ws-explicit"]);
	});
});
