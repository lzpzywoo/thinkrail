import { logger } from "../log";
import type { MuseHubClient } from "./hub-client";
import type { RealSession, RealSessionSource } from "./thinkrail-reader";

const log = logger("muse");

export class ThinkRailObserver {
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly known = new Map<string, string>();
	private polling = false;
	private baselined = false;

	constructor(
		private readonly reader: RealSessionSource,
		private readonly hubClient: MuseHubClient,
		private readonly intervalMs = 5000,
		private readonly onError?: (error: unknown) => void,
	) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.poll();
		}, this.intervalMs);
		void this.poll();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.known.clear();
		this.baselined = false;
	}

	async poll(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			const { sessions } = await this.reader.list({ status: "all", limit: 100 });
			if (!this.baselined) {
				this.known.clear();
				for (const s of sessions) {
					this.known.set(s.sessionId, this.fingerprint(s));
				}
				this.baselined = true;
				return;
			}

			const current = new Set<string>();
			for (const session of sessions) {
				current.add(session.sessionId);
				const prev = this.known.get(session.sessionId);
				const next = this.fingerprint(session);
				if (prev === undefined) {
					this.known.set(session.sessionId, next);
					this.notifyNew(session);
				} else if (prev !== next) {
					this.known.set(session.sessionId, next);
					this.notifyChange(session);
				}
			}

			for (const id of Array.from(this.known.keys())) {
				if (!current.has(id)) this.known.delete(id);
			}
		} catch (error) {
			this.known.clear();
			this.baselined = false;
			this.onError?.(error);
			log.debug("ThinkRailObserver poll failure", { error: String(error) });
		} finally {
			this.polling = false;
		}
	}

	private fingerprint(session: RealSession): string {
		return `${session.status}:${session.completionId ?? ""}:${session.planProgress.done}/${session.planProgress.total}`;
	}

	private notifyNew(session: RealSession): void {
		if (session.status === "running") {
			this.hubClient.sendEvent("notification", `ThinkRail 新任务开始: ${session.name}`);
		}
	}

	private notifyChange(session: RealSession): void {
		if (session.status === "completed") {
			this.hubClient.sendEvent(
				"task.completed",
				`🎉 ThinkRail 会话已完成: ${session.name} (${session.planProgress.done}/${session.planProgress.total} 步)`,
			);
		} else if (session.status === "failed") {
			this.hubClient.sendEvent("alert", `❌ ThinkRail 任务失败: ${session.name}`);
		} else if (session.status === "needs_input") {
			this.hubClient.sendEvent("alert", `⚠️ ThinkRail 会话正在等待您的确认: ${session.name}`);
		}
	}
}
