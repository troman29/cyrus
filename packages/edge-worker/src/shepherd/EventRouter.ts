import { createLogger, type ILogger } from "cyrus-core";
import type { GitHubWebhookEvent } from "cyrus-github-event-transport";
import { eventDropReason, rawDropReason } from "./filter.js";
import {
	type HubAck,
	type PrEventRequest,
	type PrUnownedRequest,
	sendToHub,
	sendUnowned,
} from "./hubClient.js";
import { normalize } from "./normalize.js";
import type { PrLookup, ShepherdConfig, ShepherdEvent } from "./types.js";

export type HubSender = (request: PrEventRequest) => Promise<HubAck>;
export type UnownedSender = (request: PrUnownedRequest) => Promise<void>;

export interface EventRouterOptions {
	config: ShepherdConfig;
	lookupPr: PrLookup;
	logger?: ILogger;
	/** Overridable for tests. */
	sendToHub?: HubSender;
	sendUnowned?: UnownedSender;
}

/**
 * Filters, normalizes and fans GitHub events out to every hub. Never starts a
 * Cyrus session. handle() resolves true when the transport may answer 200
 * (every hub answered ok for everything, or the event was deliberately
 * dropped), false for 503.
 */
export class EventRouter {
	private readonly config: ShepherdConfig;
	private readonly lookupPr: PrLookup;
	private readonly logger: ILogger;
	private readonly send: HubSender;
	private readonly sendUnowned: UnownedSender;

	constructor(options: EventRouterOptions) {
		this.config = options.config;
		this.lookupPr = options.lookupPr;
		this.logger =
			options.logger ?? createLogger({ component: "ShepherdEventRouter" });
		this.send = options.sendToHub ?? sendToHub;
		this.sendUnowned = options.sendUnowned ?? sendUnowned;
	}

	async handle(webhook: GitHubWebhookEvent): Promise<boolean> {
		const { deliveryId } = webhook;
		const repo = (webhook.payload as { repository: { full_name: string } })
			.repository.full_name;
		const evt = webhook.eventType;

		const rawReason = rawDropReason(webhook, this.config);
		if (rawReason) {
			this.logDropped(rawReason, deliveryId, `${repo}#?`, evt);
			return true;
		}

		let events: ShepherdEvent[];
		try {
			events = await normalize(webhook, this.lookupPr);
		} catch (error) {
			this.logger.error(
				`shepherd: failed delivery=${deliveryId} repo=${repo}#? kind=${evt} stage=normalize`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return false;
		}
		if (events.length === 0) {
			this.logDropped("no_pull_requests", deliveryId, `${repo}#?`, evt);
			return true;
		}

		let allAcknowledged = true;
		for (const event of events) {
			const where = `${event.repo}#${event.pr}`;
			const reason = eventDropReason(event, this.config);
			if (reason) {
				this.logDropped(reason, deliveryId, where, event.kind);
				continue;
			}
			// Hub dedups by deliveryId, so PRs sharing one suite delivery need distinct ids.
			const hubDeliveryId =
				events.length > 1 ? `${deliveryId}#${event.pr}` : deliveryId;
			if (!(await this.deliver(hubDeliveryId, deliveryId, event))) {
				allAcknowledged = false;
			}
		}
		return allAcknowledged;
	}

	/** Sends one event to all hubs in parallel; true when every hub answered ok. */
	private async deliver(
		hubDeliveryId: string,
		deliveryId: string,
		event: ShepherdEvent,
	): Promise<boolean> {
		const { hubs, hubToken: token } = this.config;
		const where = `${event.repo}#${event.pr}`;
		const results = await Promise.all(
			hubs.map((hub) =>
				this.send({ hub, token, deliveryId: hubDeliveryId, event }).then(
					(ack) => ({ hub, ack }),
					(error: unknown) => ({
						hub,
						error: error instanceof Error ? error : new Error(String(error)),
					}),
				),
			),
		);
		const failed: string[] = [];
		let firstError: Error | undefined;
		let owner = "none";
		for (const result of results) {
			if ("error" in result) {
				failed.push(result.hub.name);
				firstError ??= result.error;
			} else if (result.ack.owner === "mine" && owner === "none") {
				owner = result.hub.name;
			}
		}
		const counts = `hubs=${hubs.length - failed.length}/${hubs.length}`;
		if (failed.length > 0) {
			this.logger.error(
				`shepherd: failed delivery=${deliveryId} repo=${where} kind=${event.kind} ${counts} failed=${failed.join(",")}`,
				firstError,
			);
			return false;
		}
		if (owner === "none") {
			await this.reportUnowned(hubDeliveryId, deliveryId, where);
		}
		this.logger.info(
			`shepherd: delivered delivery=${deliveryId} repo=${where} kind=${event.kind} owner=${owner} ${counts}`,
		);
		return true;
	}

	/** Best effort: the primary hub falls back on its own timer if this fails. */
	private async reportUnowned(
		hubDeliveryId: string,
		deliveryId: string,
		where: string,
	): Promise<void> {
		const primary = this.config.hubs.find((hub) => hub.primary);
		if (!primary) {
			return;
		}
		try {
			await this.sendUnowned({
				hub: primary,
				token: this.config.hubToken,
				deliveryId: hubDeliveryId,
			});
		} catch (error) {
			this.logger.warn(
				`shepherd: pr-unowned failed delivery=${deliveryId} repo=${where}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private logDropped(
		reason: string,
		deliveryId: string,
		where: string,
		kind: string,
	): void {
		this.logger.info(
			`shepherd: dropped reason=${reason} delivery=${deliveryId} repo=${where} kind=${kind}`,
		);
	}
}
