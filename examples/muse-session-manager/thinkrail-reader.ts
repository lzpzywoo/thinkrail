import { randomUUID } from "node:crypto";
import {
	PROTOCOL_VERSION,
	type SessionStateRecord,
	type TodoPlan,
	type WsMethodName,
	type WsParams,
	type WsResult,
} from "../../packages/contracts/src/index";

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

export interface RealSessionSource {
	list(query?: SessionQuery): Promise<{ total: number; sessions: RealSession[] }>;
}

class ThinkRailConnection {
	private pending = new Map<
		string,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	private socket: WebSocket;
	readonly ready: Promise<void>;

	constructor(
		endpoint: string,
		private timeoutMs: number,
	) {
		const url = new URL(endpoint);
		url.searchParams.set("client", `muse-${randomUUID()}`);
		url.searchParams.set("protocol", String(PROTOCOL_VERSION));
		const endpointLabel = `${url.protocol}//${url.host}${url.pathname}`;
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
				} catch {
					clearTimeout(timer);
					reject(new Error("ThinkRail返回了无效的协议数据"));
					this.close();
				}
			};
		});
	}

	async request<M extends WsMethodName>(method: M, params: WsParams<M>): Promise<WsResult<M>> {
		await this.ready;
		const id = randomUUID();
		return new Promise<WsResult<M>>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`ThinkRail查询超时: ${method}`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve: (value) => resolve(value as WsResult<M>), reject, timer });
			try {
				this.socket.send(JSON.stringify({ id, method, params }));
			} catch {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error("ThinkRail连接已断开"));
			}
		});
	}

	private rejectPending() {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error("ThinkRail连接已断开"));
		}
		this.pending.clear();
	}

	close() {
		this.rejectPending();
		this.socket.close();
	}
}

export function realStatus(state: SessionStateRecord["state"]): RealSessionStatus {
	if (state.needsInput) return "needs_input";
	if (state.execution === "running" || state.backgroundWork) return "running";
	switch (state.completion?.outcome) {
		case "succeeded":
			return "completed";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "interrupted":
			return "interrupted";
		default:
			return "idle";
	}
}

export class ThinkRailSessionReader implements RealSessionSource {
	constructor(
		private endpoint = DEFAULT_THINKRAIL_WS_URL,
		private timeoutMs = 5000,
	) {}

	async list(query: SessionQuery = {}) {
		const connection = new ThinkRailConnection(this.endpoint, this.timeoutMs);
		try {
			const [records, projects] = await Promise.all([
				connection.request("session.stateList", {}),
				connection.request("project.list", {}),
			]);
			const workspaces = (
				await Promise.all(
					projects.map((project) =>
						connection.request("workspace.list", { projectId: project.id }),
					),
				)
			).flat();
			const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
			const projectById = new Map(projects.map((project) => [project.id, project]));
			const exactId = records.find((record) => record.sessionId === query.sessionId);
			let selected = records.filter((record) => {
				const status = realStatus(record.state);
				if (query.status === "active" && status !== "running" && status !== "needs_input")
					return false;
				if (
					query.status &&
					!["all", "recent", "active"].includes(query.status) &&
					query.status !== status
				)
					return false;
				if (!query.sessionId) return true;
				if (exactId) return record.sessionId === exactId.sessionId;
				return [
					record.sessionId,
					record.title,
					workspaceById.get(record.workspaceId)?.name,
				].includes(query.sessionId);
			});
			selected.sort(
				(a, b) =>
					(workspaceById.get(b.workspaceId)?.lastActiveAt ?? 0) -
						(workspaceById.get(a.workspaceId)?.lastActiveAt ?? 0) ||
					a.sessionId.localeCompare(b.sessionId),
			);
			if (query.sessionId && selected.length > 1)
				throw new Error("会话名称不唯一，请使用sessionId精确查询");
			const total = selected.length;
			selected = selected.slice(0, Math.max(1, Math.min(100, Math.floor(query.limit ?? 20))));
			const sessions: RealSession[] = [];
			for (const record of selected) {
				const plan: TodoPlan = await connection.request("todo.list", {
					workspaceId: record.workspaceId,
					sessionId: record.sessionId,
				});
				const tasks = [...plan.todos, ...plan.groups.flatMap((group) => group.todos)].map(
					({ id, title, status }) => ({ id, title, status }),
				);
				const done = tasks.filter((task) => task.status === "done").length;
				sessions.push({
					source: "thinkrail",
					sessionId: record.sessionId,
					workspaceId: record.workspaceId,
					projectId: record.projectId,
					name: record.title || record.firstPrompt || record.sessionId,
					projectName: projectById.get(record.projectId)?.name ?? record.projectId,
					workspaceName: workspaceById.get(record.workspaceId)?.name ?? record.workspaceId,
					status: realStatus(record.state),
					state: {
						execution: record.state.execution,
						runId: record.state.runId,
						needsInput: record.state.needsInput ? { kind: record.state.needsInput.kind } : null,
						completion: record.state.completion,
						completionUnread: record.state.completionUnread,
						queuedCount: record.state.queuedCount,
						backgroundWork: record.state.backgroundWork,
					},
					planProgress: {
						done,
						total: tasks.length,
						percentage: tasks.length ? Math.round((done / tasks.length) * 100) : null,
					},
					currentTasks: tasks.filter((task) => task.status === "in_progress"),
					tasks,
					completionId: record.state.completion?.completionId ?? null,
				});
			}
			return { total, sessions };
		} finally {
			connection.close();
		}
	}
}
