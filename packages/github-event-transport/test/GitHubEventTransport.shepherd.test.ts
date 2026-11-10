import { describe, expect, it, vi } from "vitest";
import { GitHubEventTransport } from "../src/GitHubEventTransport.js";
import type {
	GitHubEventTransportConfig,
	GitHubWebhookEvent,
} from "../src/types.js";

const SECRET = "s3cret";
const repository = { full_name: "windbit/agentek-console" };

function setup(eventHandler?: (e: GitHubWebhookEvent) => Promise<boolean>) {
	let handler!: (request: unknown, reply: unknown) => Promise<void>;
	const fastify = {
		post: vi.fn((_path: string, _opts: unknown, h: typeof handler) => {
			handler = h;
		}),
	};
	const transport = new GitHubEventTransport({
		fastifyServer:
			fastify as unknown as GitHubEventTransportConfig["fastifyServer"],
		verificationMode: "proxy",
		secret: SECRET,
		eventHandler,
	});
	transport.register();
	const legacy = vi.fn();
	transport.on("event", legacy);
	const call = async (eventType: string, body: object) => {
		const reply = {
			code: vi.fn().mockReturnThis(),
			send: vi.fn().mockReturnThis(),
		};
		await handler(
			{
				body,
				headers: {
					authorization: `Bearer ${SECRET}`,
					"x-github-event": eventType,
					"x-github-delivery": "d-1",
				},
				ip: "127.0.0.1",
			},
			reply,
		);
		return reply.code.mock.calls[0][0] as number;
	};
	return { call, legacy };
}

describe("GitHubEventTransport shepherd mode", () => {
	it("answers 200 when the handler acknowledges", async () => {
		const eventHandler = vi.fn().mockResolvedValue(true);
		const { call, legacy } = setup(eventHandler);
		expect(await call("check_suite", { action: "completed", repository })).toBe(
			200,
		);
		expect(eventHandler).toHaveBeenCalledOnce();
		expect(legacy).not.toHaveBeenCalled();
	});

	it("answers 503 when the handler fails or throws", async () => {
		const failing = setup(vi.fn().mockResolvedValue(false));
		expect(
			await failing.call("pull_request", { action: "opened", repository }),
		).toBe(503);
		const throwing = setup(vi.fn().mockRejectedValue(new Error("boom")));
		expect(
			await throwing.call("pull_request", { action: "closed", repository }),
		).toBe(503);
	});

	it("ignores unsupported actions with 200 without calling the handler", async () => {
		const eventHandler = vi.fn().mockResolvedValue(true);
		const { call } = setup(eventHandler);
		expect(await call("pull_request", { action: "labeled", repository })).toBe(
			200,
		);
		expect(await call("check_run", { action: "completed", repository })).toBe(
			200,
		);
		expect(eventHandler).not.toHaveBeenCalled();
	});

	it("keeps ignoring pull_request/check_suite when shepherd is disabled", async () => {
		const { call, legacy } = setup(undefined);
		expect(await call("pull_request", { action: "opened", repository })).toBe(
			200,
		);
		expect(await call("check_suite", { action: "completed", repository })).toBe(
			200,
		);
		expect(legacy).not.toHaveBeenCalled();
	});

	it("emits legacy events when shepherd is disabled", async () => {
		const { call, legacy } = setup(undefined);
		await call("pull_request_review", { action: "submitted", repository });
		expect(legacy).toHaveBeenCalledOnce();
	});
});
