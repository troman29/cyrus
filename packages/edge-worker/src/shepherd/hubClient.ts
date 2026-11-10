import { createConnection } from "node:net";
import type { ShepherdEvent } from "./types.js";

export const HUB_TIMEOUT_MS = 3000;

export type HubAck = "persisted" | "duplicate";

export interface HubRequest {
	socketPath: string;
	deliveryId: string;
	event: ShepherdEvent;
	timeoutMs?: number;
}

/**
 * One NDJSON round trip over shepherd.sock. Resolves with the hub ACK;
 * rejects on connect error, timeout, malformed reply or `ok:false`.
 * No retries: GitHub redelivery is the retry.
 */
export function sendToHub(request: HubRequest): Promise<HubAck> {
	const { socketPath, deliveryId, event, timeoutMs = HUB_TIMEOUT_MS } = request;
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let received = "";
		let settled = false;
		const finish = (error?: Error, ack?: HubAck) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.destroy();
			if (error) {
				reject(error);
			} else {
				resolve(ack as HubAck);
			}
		};

		socket.setTimeout(timeoutMs, () =>
			finish(new Error(`hub timeout after ${timeoutMs}ms`)),
		);
		socket.on("error", (error) => finish(error));
		socket.on("close", () => finish(new Error("hub closed without reply")));
		socket.on("connect", () => {
			socket.write(
				`${JSON.stringify({ op: "pr-event", v: 1, deliveryId, event })}\n`,
			);
		});
		socket.on("data", (chunk) => {
			received += chunk.toString("utf8");
			const newline = received.indexOf("\n");
			if (newline === -1) {
				return;
			}
			try {
				const reply = JSON.parse(received.slice(0, newline)) as {
					ok?: boolean;
					status?: string;
					error?: string;
				};
				if (
					reply.ok === true &&
					(reply.status === "persisted" || reply.status === "duplicate")
				) {
					finish(undefined, reply.status);
				} else {
					finish(new Error(`hub rejected: ${reply.error ?? reply.status}`));
				}
			} catch {
				finish(new Error("hub sent malformed reply"));
			}
		});
	});
}
