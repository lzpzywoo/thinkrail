import { describe, expect, it } from "bun:test";
import { MuseHubClient } from "./hub-client";
import { ToolRouter } from "./router";
import { SessionManager } from "./session-manager";
import type { WsTaskDispatchedMessage } from "./types";

describe("Muse Session Manager & Hub Integration", () => {
	it("creates and executes session with smooth multi-step progress", async () => {
		const sessionManager = new SessionManager();
		const progressUpdates: number[] = [];

		sessionManager.on("step_progress", ({ overallProgress }) => {
			progressUpdates.push(overallProgress);
		});

		const session = sessionManager.createSession({
			name: "单元测试任务流",
			steps: [
				{
					id: "step_1",
					title: "第一步: 初始化",
					weight: 1,
					execute: async (ctx) => {
						ctx.reportProgress(50, "初始化中...");
						ctx.reportProgress(100, "初始化完成");
						return { ok: true };
					},
				},
				{
					id: "step_2",
					title: "第二步: 运算",
					weight: 1,
					execute: async (ctx) => {
						ctx.reportProgress(50, "运算半程");
						ctx.reportProgress(100, "运算结束");
						return { calculated: 42 };
					},
				},
			],
		});

		expect(session.status).toBe("pending");
		expect(session.progress).toBe(0);
		expect(session.steps.length).toBe(2);

		const completedSession = await sessionManager.startSession(session.id);

		expect(completedSession.status).toBe("completed");
		expect(completedSession.progress).toBe(100);
		expect(completedSession.steps[0].status).toBe("completed");
		expect(completedSession.steps[1].status).toBe("completed");
		expect(progressUpdates.length).toBeGreaterThan(0);
	});

	it("handles cancellation properly mid-execution", async () => {
		const sessionManager = new SessionManager();

		const session = sessionManager.createSession({
			name: "可取消任务",
			steps: [
				{
					id: "step_slow_1",
					title: "慢步骤 1",
					execute: async (ctx) => {
						await new Promise((r) => setTimeout(r, 20));
						ctx.reportProgress(100, "完成");
					},
				},
				{
					id: "step_slow_2",
					title: "慢步骤 2",
					execute: async () => {
						await new Promise((r) => setTimeout(r, 200));
					},
				},
			],
			autoStart: true,
		});

		// Wait a brief tick for step 1 to run
		await new Promise((r) => setTimeout(r, 30));

		// Cancel while in progress
		const cancelled = sessionManager.cancelSession(session.id, "测试中断");
		expect(cancelled).toBe(true);

		const snapshot = sessionManager.getSnapshot(session.id);
		expect(snapshot?.status).toBe("cancelled");
		expect(snapshot?.error).toBe("测试中断");
	});

	it("lists and queries sessions with filters", () => {
		const sessionManager = new SessionManager();

		sessionManager.createSession({
			id: "sess_test_1",
			name: "会话 A",
			steps: [],
		});

		sessionManager.createSession({
			id: "sess_test_2",
			name: "会话 B",
			steps: [],
		});

		const all = sessionManager.listSessions();
		expect(all.length).toBe(2);

		const s1 = sessionManager.getSnapshot("sess_test_1");
		expect(s1?.name).toBe("会话 A");
	});

	it("routes Muse Hub tool calls and forwards real-time progress and notifications", async () => {
		// Mock MuseHubClient without network
		const hubClient = new MuseHubClient();
		const sentProgress: { taskId: string; payload: unknown }[] = [];
		const sentCompleted: { taskId: string; result: unknown }[] = [];
		const sentProactiveEvents: { message: string; type: unknown; metadata: unknown }[] = [];

		hubClient.isConnected = () => true;
		hubClient.sendProgress = (taskId, payload) => {
			sentProgress.push({ taskId, payload });
			return true;
		};
		hubClient.sendCompleted = (taskId, result) => {
			sentCompleted.push({ taskId, result });
			return true;
		};
		hubClient.sendProactiveEvent = (message, type, metadata) => {
			sentProactiveEvents.push({ message, type, metadata });
			return true;
		};

		const sessionManager = new SessionManager(hubClient);
		const router = new ToolRouter(sessionManager, hubClient);

		// 1. Simulate Luna dispatching 'create_and_run_session'
		const dispatchMsg: WsTaskDispatchedMessage = {
			taskId: "tsk_luna_12345",
			type: "task.dispatched",
			timestamp: Date.now(),
			payload: {
				taskId: "tsk_luna_12345",
				toolId: "create_and_run_session",
				parameters: {
					name: "Luna 派发的代码检查任务",
					taskType: "code_inspection",
					stepCount: 2,
					stepDurationMs: 40,
				},
			},
		};

		await router.handleTaskDispatched(dispatchMsg);

		// Initial progress was sent
		expect(sentProgress.length).toBeGreaterThan(0);
		expect(sentProgress[0].taskId).toBe("tsk_luna_12345");

		// Wait for the steps to complete
		const session = sessionManager.getSessionByTaskId("tsk_luna_12345");
		if (!session) throw new Error("Expected demo session");
		expect(session).toBeDefined();

		// Polling wait for completion
		let attempts = 0;
		while (sessionManager.getSnapshot(session.id)?.status === "running" && attempts < 20) {
			await new Promise((r) => setTimeout(r, 30));
			attempts++;
		}

		const finished = sessionManager.getSnapshot(session.id);
		if (!finished) throw new Error("Expected finished session");
		expect(finished.status).toBe("completed");
		expect(finished.progress).toBe(100);

		// Verify task.completed was sent to Hub
		expect(sentCompleted.some((c) => c.taskId === "tsk_luna_12345")).toBe(true);

		// Verify pet balloon notification was triggered
		expect(sentProactiveEvents.length).toBeGreaterThan(0);
		expect(sentProactiveEvents[0].message).toContain("Luna 派发的代码检查任务");

		// 2. Query session progress tool
		const queryMsg: WsTaskDispatchedMessage = {
			taskId: "tsk_query_999",
			type: "task.dispatched",
			timestamp: Date.now(),
			payload: {
				taskId: "tsk_query_999",
				toolId: "query_session_progress",
				parameters: {
					sessionId: session.id,
					source: "demo",
				},
			},
		};

		await router.handleTaskDispatched(queryMsg);
		const queryResult = sentCompleted.find((c) => c.taskId === "tsk_query_999");
		expect(queryResult).toBeDefined();
		expect(queryResult?.result).toMatchObject({ ok: true, progress: "100%" });
		expect(queryResult?.result).toHaveProperty("steps.length", 2);

		// 3. Send pet bubble tool
		const bubbleMsg: WsTaskDispatchedMessage = {
			taskId: "tsk_bubble_888",
			type: "task.dispatched",
			timestamp: Date.now(),
			payload: {
				taskId: "tsk_bubble_888",
				toolId: "send_pet_bubble",
				parameters: {
					message: "主人，工作已就绪！",
				},
			},
		};

		await router.handleTaskDispatched(bubbleMsg);
		const lastBubble = sentProactiveEvents[sentProactiveEvents.length - 1];
		expect(lastBubble.message).toBe("主人，工作已就绪！");
	});
});
