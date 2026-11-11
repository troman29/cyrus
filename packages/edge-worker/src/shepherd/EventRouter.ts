import { createLogger, type ILogger } from "cyrus-core";
import type { GitHubWebhookEvent } from "cyrus-github-event-transport";
import { eventDropReason, rawDropReason } from "./filter.js";
import { type HubAck, sendToHub } from "./hubClient.js";
import { normalize } from "./normalize.js";
import type { PrLookup, ShepherdConfig, ShepherdEvent } from "./types.js";

export type HubSender = (request: {
	socketPath: string;
	deliveryId: string;
	event: ShepherdEvent;
}) => Promise<HubAck>;

export interface EventRouterOptions {
	config: ShepherdConfig;
	lookupPr: PrLookup;
	logger?: ILogger;
	/** Overridable for tests. */
	sendToHub?: HubSender;
}

/**
 * Filters, normalizes and forwards GitHub events to the hub. Never starts a
 * Cyrus session. handle() resolves true when the transport may answer 200
 * (everything forwarded or deliberately dropped), false for 503.
 */
export class EventRouter {
	private readonly config: ShepherdConfig;
	private readonly lookupPr: PrLookup;
	private readonly logger: ILogger;
	private readonly send: HubSender;

	constructor(options: EventRouterOptions) {
		this.config = options.config;
		this.lookupPr = options.lookupPr;
		this.logger =
			options.logger ?? createLogger({ component: "ShepherdEventRouter" });
		this.send = options.sendToHub ?? sendToHub;
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
			try {
				const ack = await this.send({
					socketPath: this.config.socketPath,
					deliveryId: hubDeliveryId,
					event,
				});
				const outcome = ack === "duplicate" ? "duplicate" : "forwarded";
				this.logger.info(
					`shepherd: ${outcome} delivery=${deliveryId} repo=${where} kind=${event.kind}`,
				);
			} catch (error) {
				allAcknowledged = false;
				this.logger.error(
					`shepherd: failed delivery=${deliveryId} repo=${where} kind=${event.kind}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		}
		return allAcknowledged;
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
