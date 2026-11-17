import type { MuseHubClient } from "./hub-client";
import type { SessionManager } from "./session-manager";
import {
	type RealProjectSource,
	type RealSessionSource,
	type SessionFilter,
	ThinkRailSessionReader,
} from "./thinkrail-reader";
import {
	ThinkRailExplorationAdapter,
} from "./thinkrail-software-exploration";
import { buildPipelineSteps } from "./tools";
import type { SessionStatus, WsTaskDispatchedMessage } from "./types";

export class ToolRouter {
	private readonly sessionManager: SessionManager;
	private readonly hubClient: MuseHubClient;
	private readonly realSessions: RealSessionSource & RealProjectSource;
	private readonly explorationAdapter: ThinkRailExplorationAdapter;

	constructor(
		sessionManager: SessionManager,
		hubClient: MuseHubClient,
		realSessions: RealSessionSource & RealProjectSource = new ThinkRailSessionReader(),
		explorationAdapter?: ThinkRailExplorationAdapter,
	) {
		this.sessionManager = sessionManager;
		this.hubClient = hubClient;
		this.realSessions = realSessions;
		this.explorationAdapter = explorationAdapter ?? new ThinkRailExplorationAdapter(realSessions);
		this.hubClient.on("task.dispatched", (msg: WsTaskDispatchedMessage) => {
			this.handleTaskDispatched(msg).catch((err) => {
				this.hubClient.sendFailed(msg.taskId, err?.message || "Error processing tool dispatch");
			});
		});
	}

	public async handleTaskDispatched(msg: WsTaskDispatchedMessage): Promise<void> {
		const { taskId, payload } = msg;
		const { toolId, parameters = {} } = payload;

		if (this.explorationAdapter.isExplorationTool(toolId)) {
			const explorationResult = await this.explorationAdapter.handleToolCall(toolId, parameters);
			this.hubClient.sendCompleted(taskId, explorationResult);
			return;
		}

		if (toolId === "list_projects") {
			const result = await this.realSessions.listProjects();
			this.hubClient.sendCompleted(taskId, {
				ok: true,
				source: "thinkrail",
				...result,
				summary: `ThinkRail共有${result.total}个项目`,
			});
			return;
		}

		if (
			parameters.source !== undefined &&
			parameters.source !== "demo" &&
			parameters.source !== "thinkrail"
		) {
			throw new Error("source必须为thinkrail或demo");
		}
		if (
			(toolId === "list_sessions" || toolId === "query_session_progress") &&
			parameters.source !== "demo"
		) {
			const status = String(parameters.status ?? "all");
			const allowed: SessionFilter[] = [
				"all",
				"active",
				"recent",
				"running",
				"needs_input",
				"idle",
				"completed",
				"failed",
				"cancelled",
				"interrupted",
			];
			if (!allowed.includes(status as SessionFilter)) throw new Error("无效的会话状态筛选");
			const sessionId = parameters.sessionId;
			if (
				toolId === "query_session_progress" &&
				(typeof sessionId !== "string" || !sessionId.trim())
			)
				throw new Error("需要提供sessionId或完整会话名称");
			const limit = Number(parameters.limit ?? 20);
			if (!Number.isFinite(limit) || limit < 1) throw new Error("limit必须为正数");
			const result = await this.realSessions.list({
				status: status as SessionFilter,
				limit,
				...(toolId === "query_session_progress" ? { sessionId: String(sessionId) } : {}),
			});
			this.hubClient.sendCompleted(taskId, {
				ok: toolId === "list_sessions" || result.total > 0,
				source: "thinkrail",
				...result,
				summary: result.total
					? `查询到 ${result.total} 个真实ThinkRail会话（按工作区最近活动排序）`
					: "没有匹配的ThinkRail会话",
				progressMeaning: "planProgress是TODO计划完成比例，不代表Agent执行百分比",
			});
			return;
		}

		switch (toolId) {
			case "create_and_run_session": {
				const name = (parameters.name as string) || `长耗时任务-${new Date().toLocaleTimeString()}`;
				const taskType = (parameters.taskType as string) || "data_pipeline";
				const stepCount = Number(parameters.stepCount) || 4;
				const stepDurationMs = Number(parameters.stepDurationMs) || 800;

				const steps = buildPipelineSteps(taskType, stepCount, stepDurationMs);

				this.sessionManager.createSession({
					name,
					parameters,
					steps,
					associatedTaskId: taskId,
					autoStart: true,
				});

				this.hubClient.sendProgress(taskId, {
					percentage: 0,
					message: `会话 [${name}] 已成功创建，开始逐步执行（共 ${steps.length} 步）`,
					currentStep: steps[0]?.title,
					stepIndex: 1,
					totalSteps: steps.length,
				});
				break;
			}

			case "query_session_progress": {
				const sessionId = (parameters.sessionId as string) || "";
				let session = sessionId ? this.sessionManager.getSnapshot(sessionId) : undefined;

				if (!session && sessionId) {
					session = this.sessionManager.getSessionByTaskId(sessionId);
				}

				if (!session) {
					this.hubClient.sendCompleted(taskId, {
						ok: false,
						message: `未找到指定会话: ${sessionId}`,
					});
					return;
				}

				const currentStep = session.steps[session.currentStepIndex];
				this.hubClient.sendCompleted(taskId, {
					ok: true,
					sessionId: session.id,
					name: session.name,
					status: session.status,
					progress: `${session.progress}%`,
					currentStep: currentStep
						? `[步骤 ${session.currentStepIndex + 1}/${session.totalSteps}] ${currentStep.title}`
						: "已结束",
					currentStepMessage: currentStep?.message,
					steps: session.steps.map((s, idx) => ({
						index: idx + 1,
						title: s.title,
						status: s.status,
						progress: `${s.progress}%`,
						message: s.message,
					})),
					createdAt: new Date(session.createdAt).toLocaleTimeString(),
					completedAt: session.completedAt
						? new Date(session.completedAt).toLocaleTimeString()
						: null,
				});
				break;
			}

			case "list_sessions": {
				const status = (parameters.status as SessionStatus | "all") || "all";
				const limit = Number(parameters.limit) || 20;
				const list = this.sessionManager.listSessions({ status, limit });

				this.hubClient.sendCompleted(taskId, {
					ok: true,
					total: list.length,
					sessions: list.map((s) => ({
						sessionId: s.id,
						name: s.name,
						status: s.status,
						progress: `${s.progress}%`,
						currentStep: `${s.currentStepIndex + 1}/${s.totalSteps}`,
						createdAt: new Date(s.createdAt).toLocaleTimeString(),
					})),
				});
				break;
			}

			case "cancel_session": {
				const sessionId = parameters.sessionId as string;
				const reason = (parameters.reason as string) || "由 Muse 用户请求取消";

				if (!sessionId) {
					this.hubClient.sendFailed(taskId, "参数缺失: 需要提供 sessionId");
					return;
				}

				const success = this.sessionManager.cancelSession(sessionId, reason);
				this.hubClient.sendCompleted(taskId, {
					ok: success,
					message: success
						? `会话 ${sessionId} 已成功取消`
						: `会话 ${sessionId} 不存在或已处于终态`,
					sessionId,
				});
				break;
			}

			case "send_pet_bubble": {
				const message = (parameters.message as string) || "你好！";
				const requestedType = parameters.type ?? "notification";
				if (
					requestedType !== "task.completed" &&
					requestedType !== "notification" &&
					requestedType !== "alert"
				)
					throw new Error("无效的气泡事件类型");
				const eventType = requestedType;

				this.hubClient.sendEvent(eventType, message, {
					source: "thinkrail.session-manager",
					timestamp: Date.now(),
				});

				this.hubClient.sendCompleted(taskId, {
					ok: true,
					message: `已向桌面宠物发送气泡提醒: "${message}"`,
				});
				break;
			}

			default:
				this.hubClient.sendFailed(taskId, `未知或未实现的工具命令: ${toolId}`);
		}
	}
}
