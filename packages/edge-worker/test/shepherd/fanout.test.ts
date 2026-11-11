import { mkdtempSync, rmSync } from "node:fs";
import {
	createServer as createHttpServer,
	type Server as HttpServer,
} from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubWebhookEvent } from "cyrus-github-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadShepherdConfig } from "../../src/shepherd/config.js";
import { EventRouter } from "../../src/shepherd/EventRouter.js";
import type { PrLookup } from "../../src/shepherd/types.js";

const webhook = {
	eventType: "pull_request",
	deliveryId: "d-1",
	payload: {
		action: "opened",
		repository: { full_name: "troman29/cyrus" },
		sender: { login: "thomas5788", type: "User" },
		pull_request: {
			number: 5,
			html_url: "https://github.com/troman29/cyrus/pull/5",
			title: "t",
			user: { login: "thomas5788" },
			head: { ref: "h", sha: "abc" },
			base: { ref: "main" },
			merged: false,
		},
	},
} as unknown as GitHubWebhookEvent;

const lookupPr: PrLookup = async () => {
	throw new Error("unused");
};

type Reply = string | "hang";
type Seen = { op: string; auth?: string };

describe("EventRouter fan-out", () => {
	let dir: string;
	let servers: Array<Server | HttpServer>;
	let seen: Record<string, Seen[]>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fanout-"));
		servers = [];
		seen = {};
	});
	afterEach(() => {
		for (const server of servers) {
			server.closeAllConnections?.();
			server.close();
		}
		rmSync(dir, { recursive: true, force: true });
	});

	/** Fake hub answering per op; returns the target string for SHEPHERD_HUBS. */
	async function fakeUnix(
		name: string,
		replies: { event: Reply; unowned?: Reply },
	): Promise<string> {
		const path = join(dir, `${name}.sock`);
		seen[name] = [];
		const server = createServer((socket) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString();
				if (!buffer.includes("\n")) {
					return;
				}
				const { op } = JSON.parse(buffer);
				seen[name].push({ op });
				const reply = op === "pr-event" ? replies.event : replies.unowned;
				if (reply && reply !== "hang") {
					socket.write(`${reply}\n`);
				}
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(path, resolve));
		return `unix:${path}`;
	}

	async function fakeHttp(name: string, reply: string): Promise<string> {
		seen[name] = [];
		const server = createHttpServer((req, res) => {
			seen[name].push({
				op: (req.url ?? "").split("/").pop() ?? "",
				auth: req.headers.authorization,
			});
			req.resume();
			res.setHeader("content-type", "application/json");
			res.end(reply);
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	}

	function router(hubs: string, extra: Record<string, string> = {}) {
		const logger = {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			debug: vi.fn(),
		};
		const instance = new EventRouter({
			config: loadShepherdConfig({ SHEPHERD_HUBS: hubs, ...extra }),
			lookupPr,
			logger: logger as never,
		});
		return { instance, logger };
	}

	const mine = '{"ok":true,"status":"persisted","owner":"mine"}';
	const none = '{"ok":true,"status":"persisted","owner":"none"}';

	it("200 when all hubs ok and one owns it; no pr-unowned", async () => {
		const a = await fakeUnix("home", { event: none });
		const b = await fakeHttp("vm", mine);
		const { instance, logger } = router(`home=${a},vm=${b}`);
		expect(await instance.handle(webhook)).toBe(true);
		expect(seen.home.map((s) => s.op)).toEqual(["pr-event"]);
		expect(logger.info).toHaveBeenCalledWith(
			"shepherd: delivered delivery=d-1 repo=troman29/cyrus#5 kind=pr_opened owner=vm hubs=2/2",
		);
	});

	it("all none sends pr-unowned to the primary only and still 200 if that fails", async () => {
		const a = await fakeUnix("home", { event: none, unowned: '{"ok":true}' });
		const b = await fakeUnix("vm", { event: none });
		const { instance, logger } = router(`home=${a},vm=${b}`);
		expect(await instance.handle(webhook)).toBe(true);
		expect(seen.home.map((s) => s.op)).toEqual(["pr-event", "pr-unowned"]);
		expect(seen.vm.map((s) => s.op)).toEqual(["pr-event"]);
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("owner=none hubs=2/2"),
		);

		const c = await fakeUnix("bad", {
			event: none,
			unowned: '{"ok":false,"error":"x"}',
		});
		const failing = router(`bad=${c}`);
		expect(await failing.instance.handle(webhook)).toBe(true);
		expect(failing.logger.warn).toHaveBeenCalled();
	});

	it("a disabled hub is a normal not-mine answer", async () => {
		const a = await fakeUnix("home", { event: mine });
		const b = await fakeUnix("vm", {
			event: '{"ok":false,"error":"disabled"}',
		});
		const { instance } = router(`home=${a},vm=${b}`);
		expect(await instance.handle(webhook)).toBe(true);
	});

	it("a secondary timeout gives 503 and no pr-unowned", async () => {
		const a = await fakeUnix("home", { event: none, unowned: '{"ok":true}' });
		const b = await fakeUnix("vm", { event: "hang" });
		const { instance, logger } = router(`home=${a},vm=${b}`);
		expect(await instance.handle(webhook)).toBe(false);
		expect(seen.home.map((s) => s.op)).toEqual(["pr-event"]);
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("hubs=1/2 failed=vm"),
			expect.any(Error),
		);
	}, 10000);

	it("sends the bearer token to http hubs", async () => {
		const b = await fakeHttp("vm", none);
		const { instance } = router(`vm=${b}`, { SHEPHERD_HUB_TOKEN: "secret" });
		await instance.handle(webhook);
		expect(seen.vm).toEqual([
			{ op: "pr-event", auth: "Bearer secret" },
			{ op: "pr-unowned", auth: "Bearer secret" },
		]);
	});

	it("single SHEPHERD_SOCKET keeps working as the only primary hub", async () => {
		const target = await fakeUnix("old", {
			event: '{"ok":true,"status":"persisted"}',
		});
		const instance = new EventRouter({
			config: loadShepherdConfig({ SHEPHERD_SOCKET: target.slice(5) }),
			lookupPr,
			logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
		});
		expect(await instance.handle(webhook)).toBe(true);
		expect(seen.old.map((s) => s.op)).toEqual(["pr-event"]);
	});
});
