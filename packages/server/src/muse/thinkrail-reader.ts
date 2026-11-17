import { randomUUID } from "node:crypto";
import {
	PROTOCOL_VERSION,
	type SessionStateRecord,
	type TodoPlan,
	type WsMethodName,
	type WsParams,
	type WsResult,
} from "@thinkrail/contracts";

export const DEFAULT_THINKRAIL_WS_URL = "ws://localhost:24242/ws";

export type RealSessionStatus =
	| "running"
	| "needs_input"
	| "idle"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";
export type SessionFilter = "all" | "active" | "recent" | RealSessionStatus;

export interface RealSession {
	source: "thinkrail";
	sessionId: string;
	workspaceId: string;
	projectId: string;
	name: string;
	projectName: string;
	workspaceName: string;
	status: RealSessionStatus;
	state: Omit<SessionStateRecord["state"], "needsInput"> & {
		needsInput: { kind: "dialog" | "tool-response" } | null;
	};
	planProgress: { done: number; total: number; percentage: number | null };
	currentTasks: { id: string; title: string; status: string }[];
	tasks: { id: string; title: string; status: string }[];
	completionId: string | null;
}

export interface SessionQuery {
	status?: SessionFilter;
	limit?: number;
	sessionId?: string;
}

export interface RealProject {
	projectId: string;
	name: string;
	closed: boolean;
	lastOpened: number;
}

export interface RealSessionSource {
	list(query?: SessionQuery): Promise<{ total: number; sessions: RealSession[] }>;
}

export interface RealProjectSource {
	listProjects(): Promise<{ total: number; projects: RealProject[] }>;
}

class ThinkRailConnection {
	private readonly pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private readonly socket: WebSocket;
	private readonly endpointLabel: string;
	private readonly timeoutMs: number;
	readonly ready: Promise<void>;

	constructor(endpoint: string, timeoutMs: number) {
		this.timeoutMs = timeoutMs;
		const url = new URL(endpoint);
		url.searchParams.set("client", `muse-${randomUUID()}`);
		url.searchParams.set("protocol", String(PROTOCOL_VERSION));
		const endpointLabel = `${url.protocol}//${url.host}${url.pathname}`;
		this.endpointLabel = endpointLabel;
		this.socket = new WebSocket(url);
		this.ready = new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new Error(
						`ThinkRail连接超时 (${endpointLabel})，请检查THINKRAIL_WS_URL和运行中的ThinkRail服务`,
					),
				);
				this.close();
			}, timeoutMs);
			const fail = (detail: string) => {
				clearTimeout(timer);
				reject(
					new Error(
						`ThinkRail连接中断 (${endpointLabel}，${detail})，请将THINKRAIL_WS_URL设为ThinkRail实际监听地址；默认主机使用localhost`,
					),
				);
				this.rejectPending();
			};
			this.socket.onerror = () => fail("网络或握手错误");
			this.socket.onclose = (event) => fail(`关闭码${event.code}`);
			this.socket.onmessage = (event) => {
				try {
					const message = JSON.parse(String(event.data));
					if (message.channel === "server.welcome") {
						clearTimeout(timer);
						if (message.data?.protocolVersion !== PROTOCOL_VERSION) {
							reject(new Error("ThinkRail协议版本不匹配，请使用同版本Hub服务"));
							this.close();
						} else resolve();
					} else if (typeof message.id === "string") {
						const request = this.pending.get(message.id);
						if (!request) return;
						this.pending.delete(message.id);
						clearTimeout(request.timer);
						this.socket.send(JSON.stringify({ ack: [message.id] }));
						if (message.ok) request.resolve(message.result);
						else request.reject(new Error(message.error || "ThinkRail查询失败"));
					}
				} catch (err) {
					reject(err instanceof Error ? err : new Error(String(err)));
				}
			};
		});
	}

	request<M extends WsMethodName>(
		method: M,
		params: WsParams<M>,
		timeoutMs = this.timeoutMs,
	): Promise<WsResult<M>> {
		return new Promise((resolve, reject) => {
			const id = randomUUID();
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new Error(
						`ThinkRail已连接，但查询超时: ${method} (${this.endpointLabel}，超过${timeoutMs}ms)`,
					),
				);
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (val) => resolve(val as WsResult<M>),
				reject,
				timer,
			});
			this.socket.send(JSON.stringify({ id, method, params }));
		});
	}

	close(): void {
		this.rejectPending();
		try {
			this.socket.close();
		} catch {
			// ignore
		}
	}

	private rejectPending(): void {
		for (const [id, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(new Error("ThinkRail连接已关闭"));
			this.pending.delete(id);
		}
	}
}

export class ThinkRailSessionReader implements RealSessionSource, RealProjectSource {
	constructor(
		private readonly wsUrl: string = DEFAULT_THINKRAIL_WS_URL,
		private readonly connectTimeoutMs = 5000,
		private readonly sessionScanTimeoutMs = 30000,
	) {}

	async listProjects(): Promise<{ total: number; projects: RealProject[] }> {
		const conn = new ThinkRailConnection(this.wsUrl, this.connectTimeoutMs);
		try {
			await conn.ready;
			const projectList = await conn.request("project.list", {});
			const projects = projectList.projects.map((p) => ({
				projectId: p.projectId,
				name: p.name,
				closed: p.closed,
				lastOpened: p.lastOpened,
			}));
			return { total: projects.length, projects };
		} finally {
			conn.close();
		}
	}

	async list(query?: SessionQuery): Promise<{ total: number; sessions: RealSession[] }> {
		const conn = new ThinkRailConnection(this.wsUrl, this.connectTimeoutMs);
		try {
			await conn.ready;
			const [projectList, sessionRecords] = await Promise.all([
				conn.request("project.list", {}),
				conn.request("session.stateList", {}, this.sessionScanTimeoutMs),
			]);

			const projectMap = new Map(projectList.projects.map((p) => [p.projectId, p.name]));
			const workspaceMap = new Map<
				string,
				{
					projectId: string;
					name: string;
					lastActiveAt: number;
					sessions: { id: string; name: string }[];
				}
			>();
			const workspaces = await Promise.all(
				projectList.projects.map((p) =>
					conn.request("workspace.list", { projectId: p.projectId }).catch(() => ({
						workspaces: [],
					})),
				),
			);
			for (const group of workspaces) {
				for (const ws of group.workspaces) {
					workspaceMap.set(ws.workspaceId, {
						projectId: ws.projectId,
						name: ws.name,
						lastActiveAt: ws.lastActiveAt,
						sessions: ws.sessions,
					});
				}
			}

			const normalizedQuerySession = query?.sessionId?.trim();
			let filteredRecords = sessionRecords;
			if (normalizedQuerySession) {
				filteredRecords = sessionRecords.filter((r) => {
					if (r.sessionId === normalizedQuerySession) return true;
					if (r.title && r.title.trim() === normalizedQuerySession) return true;
					const wsInfo = workspaceMap.get(r.workspaceId);
					const wsSession = wsInfo?.sessions.find((s) => s.id === r.sessionId);
					if (wsSession && wsSession.name.trim() === normalizedQuerySession) return true;
					return false;
				});

				if (filteredRecords.length === 0) {
					const matchingWorkspaces = Array.from(workspaceMap.entries()).filter(
						([, ws]) => ws.name.trim() === normalizedQuerySession,
					);
					if (matchingWorkspaces.length === 1) {
						const wsId = matchingWorkspaces[0][0];
						filteredRecords = sessionRecords.filter((r) => r.workspaceId === wsId);
					} else if (matchingWorkspaces.length > 1) {
						throw new Error(`存在多个同名工作区 "${normalizedQuerySession}"，请使用具体会话ID`);
					}
				}
			}

			const built: RealSession[] = [];
			for (const record of filteredRecords) {
				const wsInfo = workspaceMap.get(record.workspaceId);
				const projectName =
					(wsInfo && projectMap.get(wsInfo.projectId)) ||
					projectMap.get(record.projectId) ||
					record.projectId;
				const workspaceName = wsInfo ? wsInfo.name : record.workspaceId;
				const sessionName =
					record.title || wsInfo?.sessions.find((s) => s.id === record.sessionId)?.name || record.sessionId;

				const status = this.classifyStatus(record.state);

				let plan: TodoPlan = { loose: [], groups: [] };
				try {
					plan = await conn.request("todo.list", { sessionId: record.sessionId });
				} catch {
					// Fallback to empty plan if todo read fails
				}

				const planProgress = this.calculatePlan(plan);
				const tasks = [
					...plan.loose.map((t) => ({ id: t.id, title: t.title, status: t.status })),
					...plan.groups.flatMap((g) =>
						g.todos.map((t) => ({ id: t.id, title: t.title, status: t.status })),
					),
				];
				const currentTasks = tasks.filter((t) => t.status === "in_progress");

				built.push({
					source: "thinkrail",
					sessionId: record.sessionId,
					workspaceId: record.workspaceId,
					projectId: record.projectId,
					name: sessionName,
					projectName,
					workspaceName,
					status,
					state: {
						execution: record.state.execution,
						runId: record.state.runId,
						needsInput: record.state.needsInput
							? {
									kind:
										record.state.needsInput.type === "interactive-tool"
											? "tool-response"
											: "dialog",
								}
							: null,
						completion: record.state.completion,
						completionUnread: record.state.completionUnread,
						queuedCount: record.state.queuedCount,
						backgroundWork: record.state.backgroundWork,
					},
					planProgress,
					currentTasks,
					tasks,
					completionId: record.state.completion?.outcome || null,
				});
			}

			let finalSessions = built;
			const filter = query?.status || "all";
			if (filter === "active") {
				finalSessions = built.filter(
					(s) => s.status === "running" || s.status === "needs_input",
				);
			} else if (filter === "recent") {
				finalSessions = [...built].sort((a, b) => {
					const aTime = workspaceMap.get(a.workspaceId)?.lastActiveAt || 0;
					const bTime = workspaceMap.get(b.workspaceId)?.lastActiveAt || 0;
					return bTime - aTime;
				});
			} else if (filter !== "all") {
				finalSessions = built.filter((s) => s.status === filter);
			}

			const total = finalSessions.length;
			const limit = query?.limit && query.limit > 0 ? query.limit : 20;
			return { total, sessions: finalSessions.slice(0, limit) };
		} finally {
			conn.close();
		}
	}

	private classifyStatus(state: SessionStateRecord["state"]): RealSessionStatus {
		if (state.needsInput !== null) return "needs_input";
		if (state.execution === "running" || state.backgroundWork) return "running";
		if (state.completion) {
			const outcome = state.completion.outcome;
			if (outcome === "success") return "completed";
			if (outcome === "failed") return "failed";
			if (outcome === "cancelled") return "cancelled";
			if (outcome === "interrupted") return "interrupted";
		}
		return "idle";
	}

	private calculatePlan(plan: TodoPlan): {
		done: number;
		total: number;
		percentage: number | null;
	} {
		const allItems = [...plan.loose, ...plan.groups.flatMap((g) => g.todos)];
		const total = allItems.length;
		if (total === 0) return { done: 0, total: 0, percentage: null };
		const done = allItems.filter((i) => i.status === "done").length;
		return { done, total, percentage: Math.round((done / total) * 100) };
	}
}
