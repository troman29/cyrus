import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendToHub } from "../../src/shepherd/hubClient.js";
import type { HubTarget, ShepherdEvent } from "../../src/shepherd/types.js";

const event: ShepherdEvent = {
	repo: "windbit/agentek-console",
	pr: 1,
	prUrl: "u",
	prTitle: "t",
	prAuthor: "thomas5788",
	headRef: "h",
	headSha: "s",
	baseRef: "dev",
	actor: "a",
	at: "2026-11-11T00:00:00Z",
	kind: "pr_opened",
};

describe("sendToHub", () => {
	let dir: string;
	let server: Server;
	let socketPath: string;
	let hub: HubTarget;
	let received: unknown[];

	function listen(onLine: (line: string, write: (s: string) => void) => void) {
		return new Promise<void>((resolve) => {
			server = createServer((socket) => {
				let buffer = "";
				socket.on("data", (chunk) => {
					buffer += chunk.toString();
					if (buffer.includes("\n")) {
						received.push(JSON.parse(buffer));
						onLine(buffer, (s) => socket.write(s));
					}
				});
			});
			server.listen(socketPath, resolve);
		});
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "shepherd-"));
		socketPath = join(dir, "shepherd.sock");
		hub = { name: "primary", primary: true, kind: "unix", socketPath };
		received = [];
	});
	afterEach(() => {
		server?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("sends one op line and returns persisted", async () => {
		await listen((_l, write) => write('{"ok":true,"status":"persisted"}\n'));
		await expect(sendToHub({ hub, deliveryId: "d1", event })).resolves.toEqual({
			status: "persisted",
			owner: "mine",
		});
		expect(received).toEqual([
			{ op: "pr-event", v: 1, deliveryId: "d1", event },
		]);
	});

	it("returns duplicate", async () => {
		await listen((_l, write) => write('{"ok":true,"status":"duplicate"}\n'));
		await expect(sendToHub({ hub, deliveryId: "d1", event })).resolves.toEqual({
			status: "duplicate",
			owner: "mine",
		});
	});

	it("reports owner none and treats disabled as a normal answer", async () => {
		await listen((_l, write) =>
			write('{"ok":true,"status":"persisted","owner":"none"}\n'),
		);
		await expect(sendToHub({ hub, deliveryId: "d1", event })).resolves.toEqual({
			status: "persisted",
			owner: "none",
		});
		server.close();
		await listen((_l, write) => write('{"ok":false,"error":"disabled"}\n'));
		await expect(sendToHub({ hub, deliveryId: "d1", event })).resolves.toEqual({
			status: "disabled",
			owner: "none",
		});
	});

	it("rejects on hub error", async () => {
		await listen((_l, write) =>
			write('{"ok":false,"error":"invalid: kind"}\n'),
		);
		await expect(sendToHub({ hub, deliveryId: "d1", event })).rejects.toThrow(
			/invalid: kind/,
		);
	});

	it("rejects on timeout", async () => {
		await listen(() => {});
		await expect(
			sendToHub({ hub, deliveryId: "d1", event, timeoutMs: 100 }),
		).rejects.toThrow(/timeout/);
	});

	it("rejects when the socket does not exist", async () => {
		await expect(sendToHub({ hub, deliveryId: "d1", event })).rejects.toThrow();
	});
});
