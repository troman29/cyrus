import { createConnection } from "node:net";
import type { HubTarget, ShepherdEvent } from "./types.js";

export const HUB_TIMEOUT_MS = 3000;

/** A hub that has the repo disabled answers `error:"disabled"`: a normal "not mine". */
const DISABLED_ERROR = "disabled";

export interface HubAck {
	status: "persisted" | "duplicate" | "disabled";
	owner: "mine" | "none";
}

interface HubCall {
	hub: HubTarget;
	token?: string;
	timeoutMs?: number;
}

export interface PrEventRequest extends HubCall {
	deliveryId: string;
	event: ShepherdEvent;
}

export type PrUnownedRequest = HubCall & { deliveryId: string };

interface HubReply {
	ok?: boolean;
	status?: string;
	owner?: string;
	error?: string;
}

function callUnix(
	socketPath: string,
	body: object,
	timeoutMs: number,
): Promise<HubReply> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let received = "";
		let settled = false;
		const finish = (error?: Error, reply?: HubReply) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.destroy();
			if (error) {
				reject(error);
			} else {
				resolve(reply as HubReply);
			}
		};

		socket.setTimeout(timeoutMs, () =>
			finish(new Error(`hub timeout after ${timeoutMs}ms`)),
		);
		socket.on("error", (error) => finish(error));
		socket.on("close", () => finish(new Error("hub closed without reply")));
		socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
		socket.on("data", (chunk) => {
			received += chunk.toString("utf8");
			const newline = received.indexOf("\n");
			if (newline === -1) {
				return;
			}
			try {
				finish(undefined, JSON.parse(received.slice(0, newline)) as HubReply);
			} catch {
				finish(new Error("hub sent malformed reply"));
			}
		});
	});
}

async function callHttp(
	baseUrl: string,
	op: string,
	body: object,
	token: string | undefined,
	timeoutMs: number,
): Promise<HubReply> {
	const response = await fetch(`${baseUrl}/shepherd/${op}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	}).catch((error: Error) => {
		throw error.name === "TimeoutError"
			? new Error(`hub timeout after ${timeoutMs}ms`)
			: error;
	});
	try {
		return (await response.json()) as HubReply;
	} catch {
		throw new Error(`hub http ${response.status} without JSON reply`);
	}
}

/**
 * One round trip to one hub (NDJSON line on a unix socket, or HTTP POST).
 * Rejects on connect error, timeout, malformed reply or `ok:false`
 * (except the `disabled` reply, see call sites).
 * No retries here: the retry is a GitHub redelivery, which needs an external job.
 */
function call(
	{ hub, token, timeoutMs = HUB_TIMEOUT_MS }: HubCall,
	op: "pr-event" | "pr-unowned",
	payload: object,
): Promise<HubReply> {
	const body = { op, v: 1, ...payload };
	return hub.kind === "unix"
		? callUnix(hub.socketPath, body, timeoutMs)
		: callHttp(hub.baseUrl, op, body, token, timeoutMs);
}

export async function sendToHub(request: PrEventRequest): Promise<HubAck> {
	const reply = await call(request, "pr-event", {
		deliveryId: request.deliveryId,
		event: request.event,
	});
	if (reply.ok === false && reply.error === DISABLED_ERROR) {
		return { status: "disabled", owner: "none" };
	}
	if (
		reply.ok === true &&
		(reply.status === "persisted" || reply.status === "duplicate")
	) {
		// A hub without the multihub contract has no `owner`: it owns every event it accepts.
		return {
			status: reply.status,
			owner: reply.owner === "none" ? "none" : "mine",
		};
	}
	throw new Error(`hub rejected: ${reply.error ?? reply.status}`);
}

export async function sendUnowned(request: PrUnownedRequest): Promise<void> {
	const reply = await call(request, "pr-unowned", {
		deliveryId: request.deliveryId,
	});
	if (reply.ok !== true) {
		throw new Error(`hub rejected: ${reply.error}`);
	}
}
