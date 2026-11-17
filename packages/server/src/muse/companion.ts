import { logger } from "../log";
import { MuseHubClient } from "./hub-client";
import { ThinkRailObserver } from "./observer";
import { ToolRouter } from "./router";
import { SessionManager } from "./session-manager";
import { ThinkRailSessionReader } from "./thinkrail-reader";
import { createThinkRailExploration } from "./thinkrail-software-exploration";
import { ALL_SESSION_MANAGER_TOOLS } from "./tools";
import type { MuseCompanionConfig } from "./types";

const log = logger("muse");

export class MuseCompanion {
	private readonly config: MuseCompanionConfig;
	readonly hubClient: MuseHubClient;
	readonly sessionManager: SessionManager;
	readonly reader: ThinkRailSessionReader;
	readonly router: ToolRouter;
	readonly observer: ThinkRailObserver;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private isRunning = false;
	private retryDelayMs = 15000;

	constructor(config: MuseCompanionConfig) {
		this.config = config;
		this.hubClient = new MuseHubClient(config);
		this.sessionManager = new SessionManager(this.hubClient);
		this.reader = new ThinkRailSessionReader(
			config.thinkrailWsUrl,
			5000,
			config.thinkrailQueryTimeoutMs,
		);
		const { adapter: explorationAdapter } = createThinkRailExploration(
			this.reader,
			config.exploration,
		);
		this.router = new ToolRouter(this.sessionManager, this.hubClient, this.reader, explorationAdapter);
		this.observer = new ThinkRailObserver(
			this.reader,
			this.hubClient,
			config.observationIntervalMs,
			(error) => {
				log.debug("ThinkRailObserver polling error", { error: String(error) });
			},
		);

		this.hubClient.on("registered", () => {
			log.info("Registered ThinkRail capabilities with Muse Local Agent Hub", {
				appId: config.appId || "thinkrail.session-manager",
			});
		});

		this.hubClient.on("connected", () => {
			log.info("Connected to Muse Local Agent Hub event bus", {
				toolCount: ALL_SESSION_MANAGER_TOOLS.length,
			});
		});

		this.hubClient.on("disconnected", ({ code, reason }) => {
			log.debug("Disconnected from Muse Local Agent Hub", { code, reason });
		});
	}

	public start(): void {
		if (this.isRunning) return;
		this.isRunning = true;
		this.observer.start();
		void this.tryConnect();
	}

	public async stop(): Promise<void> {
		this.isRunning = false;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		this.observer.stop();
		await this.hubClient.stop();
		log.debug("Muse companion daemon stopped");
	}

	public isConnected(): boolean {
		return this.hubClient.isConnected();
	}

	private async tryConnect(): Promise<void> {
		if (!this.isRunning) return;
		try {
			await this.hubClient.start(ALL_SESSION_MANAGER_TOOLS);
		} catch (err) {
			log.debug("Muse Local Agent Hub not reachable, will retry registration periodically", {
				error: err instanceof Error ? err.message : String(err),
			});
			if (this.isRunning) {
				this.retryTimer = setTimeout(() => {
					this.retryTimer = null;
					void this.tryConnect();
				}, this.retryDelayMs);
			}
		}
	}
}

export function startMuseCompanion(config: MuseCompanionConfig): MuseCompanion {
	const companion = new MuseCompanion(config);
	companion.start();
	return companion;
}
