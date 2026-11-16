import { afterEach, describe, expect, it } from "bun:test";
import {
	PROTOCOL_VERSION,
	type SessionStateRecord,
	type TodoPlan,
} from "../../packages/contracts/src/index";
import { MuseHubClient } from "./hub-client";
import { ThinkRailObserver } from "./observer";
import { ToolRouter } from "./router";
import { SessionManager } from "./session-manager";
import {
	DEFAULT_THINKRAIL_WS_URL,
	type RealSession,
	ThinkRailSessionReader,
} from "./thinkrail-reader";
import { SESSION_MANAGER_TOOLS } from "./tools";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

function record(
	sessionId: string,
	state: Partial<SessionStateRecord["state"]> = {},
): SessionStateRecord {
	return {
		sessionId,
		workspaceId: "w1",
		projectId: "p1",
		title: `真实任务${sessionId}`,
		state: {
			execution: "idle",
			runId: null,
			needsInput: null,
			completion: null,
			completionUnread: false,
			queuedCount: 0,
			backgroundWork: false,
			...state,
		},
	};
}

function fixture(
	records: SessionStateRecord[],
	plan: TodoPlan = { todos: [], groups: [] },
	options: { protocol?: number; failTodo?: boolean; ignoreState?: boolean; hostname?: string } = {},
) {
	const methods: string[] = [];
	const acknowledgements: string[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: options.hostname ?? "127.0.0.1",
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				ws.send(
					JSON.stringify({
						channel: "server.welcome",
						data: { protocolVersion: options.protocol ?? PROTOCOL_VERSION },
					}),
				);
			},
			message(ws, raw) {
				const request = JSON.parse(String(raw));
				if (request.ack) {
					acknowledgements.push(...request.ack);
					return;
				}
				methods.push(request.method);
				if (request.method === "session.stateList" && options.ignoreState) return;
				const results: Record<string, unknown> = {
					"session.stateList": records,
					"project.list": [{ id: "p1", name: "真实项目" }],
					"workspace.list": [{ id: "w1", name: "真实工作区", lastActiveAt: 123 }],
					"todo.list": plan,
				};
				const ok = request.method !== "todo.list" || !options.failTodo;
				ws.send(
					JSON.stringify({
						id: request.id,
						ok,
						result: results[request.method],
						error: ok ? undefined : "fixture todo failure",
					}),
				);
			},
		},
	});
	servers.push(server);
	return {
		url: `ws://${options.hostname ?? "127.0.0.1"}:${server.port}/ws`,
		methods,
		acknowledgements,
	};
}

const plan: TodoPlan = {
	todos: [],
	groups: [
		{
			id: "g1",
			title: "真实开发计划",
			status: "active",
			todos: [
				{ id: "a", title: "已完成", status: "done", origin: "agent", createdAt: "", updatedAt: "" },
				{
					id: "b",
					title: "正在开发",
					status: "in_progress",
					origin: "agent",
					createdAt: "",
					updatedAt: "",
				},
			],
		},
	],
};

describe("real ThinkRail session reader", () => {
	it("matches the host localhost binding and reads a localhost fixture", async () => {
		expect(DEFAULT_THINKRAIL_WS_URL).toBe("ws://localhost:24242/ws");
		const service = fixture([record("localhost")], undefined, { hostname: "localhost" });
		const result = await new ThinkRailSessionReader(service.url).list();
		expect(result.sessions[0]?.sessionId).toBe("localhost");
	});

	it("includes the target endpoint in connection failures", async () => {
		const service = fixture([]);
		servers.pop()?.stop(true);
		await expect(new ThinkRailSessionReader(service.url).list()).rejects.toThrow(service.url);
	});
	it("reads authoritative live and background states plus real TODO progress", async () => {
		const service = fixture(
			[
				record("running", { execution: "running", runId: "run1" }),
				record("background", { backgroundWork: true }),
				record("input", {
					needsInput: { kind: "tool-response", interactionId: "i", toolCallId: "t" },
				}),
				record("completed", { completion: { completionId: "c", outcome: "succeeded" } }),
				record("idle"),
			],
			plan,
		);
		const reader = new ThinkRailSessionReader(service.url);
		const result = await reader.list();
		expect(result.total).toBe(5);
		expect(result.sessions.find((s) => s.sessionId === "background")?.status).toBe("running");
		expect(result.sessions.find((s) => s.sessionId === "input")?.status).toBe("needs_input");
		expect(result.sessions.find((s) => s.sessionId === "idle")?.status).toBe("idle");
		const session = result.sessions[0];
		expect(session?.projectName).toBe("真实项目");
		expect(session?.workspaceName).toBe("真实工作区");
		expect(session?.planProgress).toEqual({ done: 1, total: 2, percentage: 50 });
		expect(session?.currentTasks[0]?.title).toBe("正在开发");
		expect((await reader.list({ status: "active" })).total).toBe(3);
		expect((await reader.list({ sessionId: "真实任务completed" })).sessions[0]?.status).toBe(
			"completed",
		);
		expect(
			service.methods.every((method) =>
				["session.stateList", "project.list", "workspace.list", "todo.list"].includes(method),
			),
		).toBe(true);
		expect(service.acknowledgements.length).toBeGreaterThan(0);
	});

	it("omits pending dialog contents and tool arguments from Muse results", async () => {
		const service = fixture([
			record("private", {
				needsInput: {
					kind: "dialog",
					interactionId: "i",
					request: {
						id: "dialog",
						sessionId: "private",
						kind: "confirm",
						title: "private-dialog-title",
						message: "private-dialog-message",
						toolInput: { path: "C:/private/secret.txt", content: "private-file-content" },
					},
				},
			}),
		]);
		const result = await new ThinkRailSessionReader(service.url).list();
		expect(result.sessions[0]?.state.needsInput).toEqual({ kind: "dialog" });
		const serialized = JSON.stringify(result);
		for (const secret of [
			"private-dialog-title",
			"private-dialog-message",
			"C:/private/secret.txt",
			"private-file-content",
			"toolInput",
		]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("reports total before limiting and refuses ambiguous workspace names", async () => {
		const service = fixture([record("a"), record("b")]);
		const reader = new ThinkRailSessionReader(service.url);
		const result = await reader.list({ limit: 1 });
		expect(result.total).toBe(2);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]?.planProgress.percentage).toBeNull();
		await expect(reader.list({ sessionId: "真实工作区" })).rejects.toThrow("不唯一");
		expect((await reader.list({ sessionId: "absent" })).total).toBe(0);
	});

	it("distinguishes empty results, protocol errors, RPC failures and deadlines", async () => {
		expect((await new ThinkRailSessionReader(fixture([]).url).list()).total).toBe(0);
		await expect(
			new ThinkRailSessionReader(fixture([], undefined, { protocol: 1 }).url).list(),
		).rejects.toThrow("协议");
		await expect(
			new ThinkRailSessionReader(fixture([record("a")], undefined, { failTodo: true }).url).list(),
		).rejects.toThrow("fixture todo failure");
		await expect(
			new ThinkRailSessionReader(fixture([], undefined, { ignoreState: true }).url, 50).list(),
		).rejects.toThrow("超时");
	});

	it("routes list_sessions to real data without creating a demo session", async () => {
		const service = fixture([record("a", { execution: "running" })], plan);
		const hub = new MuseHubClient();
		const completed: unknown[] = [];
		hub.sendCompleted = (_id, result) => {
			completed.push(result);
			return true;
		};
		const router = new ToolRouter(
			new SessionManager(),
			hub,
			new ThinkRailSessionReader(service.url),
		);
		await router.handleTaskDispatched({
			type: "task.dispatched",
			taskId: "tsk1",
			timestamp: 1,
			payload: { taskId: "tsk1", toolId: "list_sessions", parameters: {} },
		});
		expect(completed[0]).toMatchObject({
			source: "thinkrail",
			total: 1,
			sessions: [{ sessionId: "a", status: "running" }],
		});
		await expect(
			router.handleTaskDispatched({
				type: "task.dispatched",
				taskId: "tsk2",
				timestamp: 1,
				payload: { taskId: "tsk2", toolId: "list_sessions", parameters: { source: "invalid" } },
			}),
		).rejects.toThrow("source");
	});

	it("publishes changes once, baselines history and recovers without replay", async () => {
		let session: RealSession = (await new ThinkRailSessionReader(fixture([record("a")]).url).list())
			.sessions[0] as RealSession;
		let failed = false;
		const hub = new MuseHubClient();
		hub.isConnected = () => true;
		const events: string[] = [];
		hub.sendProactiveEvent = (message) => {
			events.push(message);
			return true;
		};
		const observer = new ThinkRailObserver(
			{
				list: async () => {
					if (failed) throw new Error("offline");
					return { total: 1, sessions: [session] };
				},
			},
			hub,
		);
		await observer.poll();
		expect(events).toHaveLength(0);
		session = { ...session, status: "running" };
		await observer.poll();
		await observer.poll();
		expect(events).toHaveLength(1);
		failed = true;
		await observer.poll();
		failed = false;
		session = { ...session, status: "completed", completionId: "c1" };
		await observer.poll();
		expect(events).toHaveLength(1);
		session = { ...session, completionId: "c2" };
		await observer.poll();
		expect(events).toHaveLength(2);
		hub.emit("disconnected");
		session = { ...session, completionId: "c3" };
		await observer.poll();
		expect(events).toHaveLength(2);
		observer.stop();
	});

	it("returns a real ThinkRail result over the Muse WebSocket task channel", async () => {
		const thinkrail = fixture([record("actual", { execution: "running" })], plan);
		let received: (value: unknown) => void = () => {};
		const result = new Promise<unknown>((resolve) => {
			received = resolve;
		});
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request, server) {
				if (new URL(request.url).pathname === "/ws" && server.upgrade(request)) return;
				return Response.json({
					ok: true,
					data: { sessionToken: "fixture", hubVersion: 1, heartbeatTimeoutMs: 75000 },
				});
			},
			websocket: {
				open(ws) {
					ws.send(
						JSON.stringify({
							type: "task.dispatched",
							taskId: "network-task",
							payload: { taskId: "network-task", toolId: "list_sessions", parameters: {} },
						}),
					);
				},
				message(_ws, raw) {
					received(JSON.parse(String(raw)));
				},
			},
		});
		servers.push(server);
		const hub = new MuseHubClient({
			hubHttpUrl: `http://127.0.0.1:${server.port}`,
			hubWsUrl: `ws://127.0.0.1:${server.port}/ws`,
		});
		new ToolRouter(new SessionManager(), hub, new ThinkRailSessionReader(thinkrail.url));
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await hub.start(SESSION_MANAGER_TOOLS);
			const frame = await Promise.race([
				result,
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error("Muse result timeout")), 2000);
				}),
			]);
			expect(frame).toMatchObject({
				type: "task.completed",
				taskId: "network-task",
				payload: {
					result: {
						source: "thinkrail",
						total: 1,
						sessions: [
							{ sessionId: "actual", status: "running", planProgress: { percentage: 50 } },
						],
					},
				},
			});
		} finally {
			if (timer) clearTimeout(timer);
			await hub.stop();
		}
	});

	it("registers ThinkRail discovery metadata and read-only query tools with Hub", async () => {
		let manifest: unknown;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				manifest = await request.json();
				return Response.json({
					ok: true,
					data: { sessionToken: "fixture", hubVersion: 1, heartbeatTimeoutMs: 75000 },
				});
			},
		});
		servers.push(server);
		const hub = new MuseHubClient({ hubHttpUrl: `http://127.0.0.1:${server.port}` });
		await hub.register(SESSION_MANAGER_TOOLS);
		expect(manifest).toMatchObject({
			appId: "thinkrail.session-manager",
			name: "ThinkRail 会话与任务管理器",
			keywords: expect.arrayContaining(["thinkrail", "会话", "任务"]),
		});
		expect(
			SESSION_MANAGER_TOOLS.filter((tool) =>
				["list_sessions", "query_session_progress"].includes(tool.toolId),
			).every((tool) => tool.riskLevel === "read-only" && tool.description.includes("ThinkRail")),
		).toBe(true);
	});
});
