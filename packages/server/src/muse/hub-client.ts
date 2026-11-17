import EventEmitter from "node:events";
import { logger } from "../log";
import type {
	AppManifest,
	HubHeartbeatResponse,
	HubRegisterResponse,
	IncomingHubMessage,
	MuseCompanionConfig,
	SoftwareExplorationDescriptor,
	ToolDefinition,
	WsProactiveEventMessage,
	WsTaskCancelledMessage,
	WsTaskCompletedMessage,
	WsTaskDispatchedMessage,
	WsTaskFailedMessage,
	WsTaskProgressMessage,
} from "./types";

const log = logger("muse");

interface ResolvedHubClientConfig {
	hubHttpUrl: string;
	hubWsUrl: string;
	appId: string;
	appName: string;
	appVersion: string;
	appDescription: string;
	secret: string;
	keywords: string[];
	heartbeatIntervalMs: number;
	reconnectIntervalMs: number;
	exploration?: SoftwareExplorationDescriptor | undefined;
}

export class MuseHubClient extends EventEmitter {
	private readonly config: ResolvedHubClientConfig;
	private sessionToken: string | null = null;
	private ws: WebSocket | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private isRunning = false;
	private registeredTools: ToolDefinition[] = [];
	private activeTasksCount = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(config: Partial<MuseCompanionConfig> = {}) {
		super();
		this.config = {
			hubHttpUrl: config.hubHttpUrl || "http://127.0.0.1:19840",
			hubWsUrl: config.hubWsUrl || "ws://127.0.0.1:19840/ws",
			appId: config.appId || "thinkrail.session-manager",
			appName: config.appName || "ThinkRail 会话与任务管理器",
			appVersion: config.appVersion || "2.0.0",
			keywords: config.keywords ?? [
				"thinkrail",
				"session",
				"task",
				"workspace",
				"agent",
				"会话",
				"任务",
				"工作区",
				"pi",
			],
			appDescription:
				config.appDescription ||
				"Understand ThinkRail projects, workspaces, and live agent sessions. Query progress on demand. 查询 ThinkRail 真实项目、工作区、会话、Agent运行状态与任务计划进度，并推送桌面宠物通知。用户询问ThinkRail在跑什么任务、有哪些会话、当前进度时使用。",
			secret: config.secret || "muse-session-manager-secret-2026",
			heartbeatIntervalMs: config.heartbeatIntervalMs || 20000,
			reconnectIntervalMs: config.reconnectIntervalMs || 3000,
			exploration: config.exploration,
		};
	}

	public getSessionToken(): string | null {
		return this.sessionToken;
	}

	public isConnected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
	}

	public setActiveTasksCount(count: number): void {
		this.activeTasksCount = count;
	}

	public async register(tools: ToolDefinition[]): Promise<HubRegisterResponse> {
		this.registeredTools = tools;
		const manifest: AppManifest = {
			appId: this.config.appId,
			name: this.config.appName,
			version: this.config.appVersion,
			description: this.config.appDescription,
			secret: this.config.secret,
			tools,
			keywords: this.config.keywords,
			...(this.config.exploration ? { exploration: this.config.exploration } : {}),
		};

		const registerUrl = `${this.config.hubHttpUrl}/api/v1/register`;
		try {
			const response = await fetch(registerUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(manifest),
				signal: AbortSignal.timeout(5000),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Hub registration failed (${response.status}): ${errorText}`);
			}

			const resJson = (await response.json()) as HubRegisterResponse;
			if (resJson.ok && resJson.data?.sessionToken) {
				this.sessionToken = resJson.data.sessionToken;
				this.emit("registered", resJson.data);
			} else {
				throw new Error(resJson.error || "Unknown error during registration");
			}

			return resJson;
		} catch (err) {
			this.emit("error", err);
			throw err;
		}
	}

	public connectWs(): Promise<void> {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.ws?.close();
				reject(new Error("Muse Hub WebSocket连接超时"));
			}, 5000);

			const encodedAppId = encodeURIComponent(this.config.appId);
			const encodedSecret = encodeURIComponent(this.config.secret);
			const wsUrl = `${this.config.hubWsUrl}?appId=${encodedAppId}&secret=${encodedSecret}`;

			try {
				const ws = new WebSocket(wsUrl);
				this.ws = ws;

				ws.onopen = () => {
					clearTimeout(timeout);
					this.emit("connected");
					this.startHeartbeat();
					resolve();
				};

				ws.onmessage = (event) => {
					try {
						const rawStr =
							typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
						const msg = JSON.parse(rawStr) as IncomingHubMessage;
						this.handleIncomingMessage(msg);
					} catch (err) {
						log.warn("无法解析来自 Muse Hub 的 WebSocket 消息", err);
					}
				};

				ws.onerror = (err) => {
					log.debug("Muse Hub WebSocket 错误", err);
					this.emit("ws_error", err);
				};

				ws.onclose = (ev) => {
					clearTimeout(timeout);
					this.stopHeartbeat();
					this.emit("disconnected", { code: ev.code, reason: ev.reason });

					if (this.isRunning) {
						this.scheduleReconnect();
					}
				};
			} catch (err) {
				clearTimeout(timeout);
				reject(err);
			}
		});
	}

	public sendProgress(
		taskId: string,
		payload: {
			percentage: number;
			message: string;
			currentStep?: string | undefined;
			stepIndex?: number | undefined;
			totalSteps?: number | undefined;
		},
	): void {
		const msg: WsTaskProgressMessage = {
			type: "task.progress",
			taskId,
			payload: {
				percentage: payload.percentage,
				message: payload.message,
				...(payload.currentStep !== undefined ? { currentStep: payload.currentStep } : {}),
				...(payload.stepIndex !== undefined ? { stepIndex: payload.stepIndex } : {}),
				...(payload.totalSteps !== undefined ? { totalSteps: payload.totalSteps } : {}),
			},
		};
		this.sendWsMessage(msg);
	}

	public sendCompleted(taskId: string, result: unknown): void {
		const msg: WsTaskCompletedMessage = {
			type: "task.completed",
			taskId,
			payload: { result },
		};
		this.sendWsMessage(msg);
	}

	public sendFailed(taskId: string, error: string, details?: unknown): void {
		const msg: WsTaskFailedMessage = {
			type: "task.failed",
			taskId,
			payload: {
				error,
				...(details !== undefined ? { details } : {}),
			},
		};
		this.sendWsMessage(msg);
	}

	public sendEvent(
		type: "task.completed" | "task.progress" | "notification" | "alert",
		message: string,
		metadata?: Record<string, unknown> | undefined,
	): void {
		const msg: WsProactiveEventMessage = {
			type: "event",
			payload: {
				type,
				message,
				...(metadata !== undefined ? { metadata } : {}),
			},
		};
		this.sendWsMessage(msg);
	}

	public async start(tools: ToolDefinition[]): Promise<void> {
		this.isRunning = true;
		await this.register(tools);
		await this.connectWs();
	}

	public async stop(): Promise<void> {
		this.isRunning = false;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.stopHeartbeat();
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				// ignore
			}
			this.ws = null;
		}
	}

	private sendWsMessage(msg: unknown): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		} else {
			log.debug("无法发送消息：Muse Hub WebSocket 未连接");
		}
	}

	private handleIncomingMessage(msg: IncomingHubMessage): void {
		switch (msg.type) {
			case "task.dispatched":
				this.emit("task.dispatched", msg as WsTaskDispatchedMessage);
				break;
			case "task.cancelled":
				this.emit("task.cancelled", msg as WsTaskCancelledMessage);
				break;
			case "task.approval_required":
				this.emit("task.approval_required", msg);
				break;
			default:
				log.debug(`收到未知类型的 Muse Hub 消息: ${(msg as { type?: string }).type}`);
		}
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			this.sendHeartbeat().catch((err) => {
				log.debug("向 Muse Hub 发送心跳失败", err);
			});
		}, this.config.heartbeatIntervalMs);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
	}

	private async sendHeartbeat(): Promise<void> {
		if (!this.sessionToken) return;

		const res = await fetch(`${this.config.hubHttpUrl}/api/v1/heartbeat`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.sessionToken}`,
				"X-App-Id": this.config.appId,
			},
			body: JSON.stringify({
				status: "active",
				activeTasks: this.activeTasksCount,
			}),
			signal: AbortSignal.timeout(3000),
		});

		if (res.ok) {
			const json = (await res.json()) as HubHeartbeatResponse;
			if (!json.ok) {
				log.debug("Muse Hub 心跳未确认，将在下一轮尝试重新注册");
			}
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			if (!this.isRunning) return;

			try {
				log.debug("正在尝试重新连接至 Muse Hub...");
				await this.register(this.registeredTools);
				await this.connectWs();
			} catch (err) {
				log.debug("重新连接至 Muse Hub 失败，将在稍后重试", err);
				this.scheduleReconnect();
			}
		}, this.config.reconnectIntervalMs);
	}
}
