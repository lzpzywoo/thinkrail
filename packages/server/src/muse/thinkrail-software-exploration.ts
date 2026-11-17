import type { RealProjectSource, RealSession, RealSessionSource } from "./thinkrail-reader";
import type {
	ExplorationEnvelope,
	ExplorationReference,
	SoftwareExplorationDescriptor,
	ToolDefinition,
} from "./types";

export const DEFAULT_EXPLORATION_DESCRIPTOR: SoftwareExplorationDescriptor = {
	version: 1,
	overviewToolId: "software_overview",
	discoverToolId: "software_discover",
	readToolId: "software_read",
};

export const EXPLORATION_TOOLS: ToolDefinition[] = [
	{
		toolId: "software_overview",
		name: "ThinkRail软件概述与概念模型",
		description:
			"获取ThinkRail的基本定位、核心概念（项目、工作区、会话、任务）、运行机制与只读探索入口。当需要了解ThinkRail是什么、有哪些功能或开始动态探索时调用。",
		category: "query",
		riskLevel: "read-only",
		requiresApproval: false,
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		toolId: "software_discover",
		name: "ThinkRail软件资源目录发现",
		description:
			"动态探索ThinkRail的资源目录、分类及可用查询集合（项目列表、会话集等）。当需要逐层查找ThinkRail中的资源或查看目录时调用。",
		category: "query",
		riskLevel: "read-only",
		requiresApproval: false,
		inputSchema: {
			type: "object",
			properties: {
				parentRef: {
					type: "string",
					description: "父级资源引用ID，如 thinkrail:projects 或 thinkrail:root",
				},
				query: { type: "string", description: "搜索关键词" },
				cursor: { type: "string", description: "分页游标" },
			},
			additionalProperties: false,
		},
	},
	{
		toolId: "software_read",
		name: "ThinkRail软件资源详情读取",
		description:
			"根据资源引用ID（如 thinkrail:sessions、thinkrail:session:<id>、thinkrail:projects）读取ThinkRail实时数据与状态。当需要深入查看具体会话任务、计划进度或项目详情时调用。",
		category: "query",
		riskLevel: "read-only",
		requiresApproval: false,
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "资源引用标识符，例如 thinkrail:sessions 或 thinkrail:session:<id>",
				},
				arguments: {
					type: "object",
					description: "查询参数，如 status, limit 等",
				},
			},
			required: ["ref"],
			additionalProperties: false,
		},
	},
];

const MAX_PAYLOAD_BYTES = 256000;
const MAX_REFERENCES = 30;

function boundEnvelope<T>(envelope: ExplorationEnvelope<T>): ExplorationEnvelope<T> {
	if (envelope.references && envelope.references.length > MAX_REFERENCES) {
		envelope.references = envelope.references.slice(0, MAX_REFERENCES);
	}
	const json = JSON.stringify(envelope);
	if (json.length > MAX_PAYLOAD_BYTES) {
		return {
			...envelope,
			data: {
				warning: "Payload truncated to stay within byte limit",
				summary: "Data exceeded 256KB budget",
			} as unknown as T,
		};
	}
	return envelope;
}

export class ThinkRailExplorationAdapter {
	private readonly realSessions: RealSessionSource & RealProjectSource;
	readonly descriptor: SoftwareExplorationDescriptor;

	constructor(
		realSessions: RealSessionSource & RealProjectSource,
		descriptor: SoftwareExplorationDescriptor = DEFAULT_EXPLORATION_DESCRIPTOR,
	) {
		this.realSessions = realSessions;
		this.descriptor = descriptor;
	}

	public isExplorationTool(toolId: string): boolean {
		return (
			toolId === this.descriptor.overviewToolId ||
			toolId === this.descriptor.discoverToolId ||
			toolId === this.descriptor.readToolId
		);
	}

	public async handleToolCall(
		toolId: string,
		parameters: Record<string, unknown> = {},
	): Promise<ExplorationEnvelope> {
		if (toolId === this.descriptor.overviewToolId) {
			return this.overview();
		}
		if (toolId === this.descriptor.discoverToolId) {
			return this.discover({
				parentRef: typeof parameters.parentRef === "string" ? parameters.parentRef : undefined,
				query: typeof parameters.query === "string" ? parameters.query : undefined,
				cursor: typeof parameters.cursor === "string" ? parameters.cursor : undefined,
			});
		}
		if (toolId === this.descriptor.readToolId) {
			const ref = typeof parameters.ref === "string" ? parameters.ref : "";
			if (!ref) {
				return {
					protocol: "muse-software/1",
					kind: "resource",
					status: "unsupported",
					source: { id: "thinkrail:adapter", kind: "documentation" },
					observedAt: new Date().toISOString(),
					data: { message: "ref parameter is required" },
				};
			}
			return this.read({
				ref,
				arguments:
					typeof parameters.arguments === "object" && parameters.arguments !== null
						? (parameters.arguments as Record<string, unknown>)
						: undefined,
			});
		}
		return {
			protocol: "muse-software/1",
			kind: "overview",
			status: "unsupported",
			source: { id: "thinkrail:adapter", kind: "documentation" },
			observedAt: new Date().toISOString(),
			data: { message: `Unknown toolId: ${toolId}` },
		};
	}

	public async overview(): Promise<ExplorationEnvelope> {
		const references: ExplorationReference[] = [
			{
				ref: "thinkrail:projects",
				title: "Registered Projects",
				kind: "collection",
				description: "Discover all open and registered projects managed in ThinkRail",
			},
			{
				ref: "thinkrail:sessions",
				title: "Active Sessions & Tasks",
				kind: "query",
				description: "Query live ThinkRail sessions, their status and TODO progress",
				inputSchema: {
					type: "object",
					properties: {
						status: {
							type: "string",
							enum: [
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
							],
							default: "active",
						},
						limit: { type: "number", default: 10, minimum: 1, maximum: 50 },
					},
				},
			},
		];

		return boundEnvelope({
			protocol: "muse-software/1",
			kind: "overview",
			status: "ok",
			source: {
				id: "thinkrail:software-guide",
				kind: "documentation",
			},
			observedAt: new Date().toISOString(),
			data: {
				purpose:
					"ThinkRail is an agentic IDE and developer workbench that coordinates coding agents across projects and workspaces.",
				concepts: {
					project: "A root project directory registered in ThinkRail.",
					workspace: "An isolated git worktree or working branch within a project.",
					session: "A live conversational chat or coding agent run in a workspace.",
					task: "A concrete TODO plan item or execution step within a session.",
				},
				operatingWorkflow:
					"ThinkRail hosts coding agents in-process. Sessions track real-time agent execution status (running, needs_input, idle, completed) and structured TODO plan progress.",
				limitations: [
					"Read-only exploration: does not execute terminal commands, modify files, or mutate agent sessions.",
					"planProgress represents TODO plan completion ratio, not an estimated agent execution percentage. Unplanned sessions have null percentage.",
				],
			},
			references,
		});
	}

	public async discover(params?: {
		parentRef?: string;
		query?: string;
		cursor?: string;
	}): Promise<ExplorationEnvelope> {
		const parentRef = params?.parentRef?.trim() || "thinkrail:root";
		const observedAt = new Date().toISOString();

		if (parentRef === "thinkrail:root") {
			return boundEnvelope({
				protocol: "muse-software/1",
				kind: "directory",
				status: "ok",
				source: { id: "thinkrail:directory", kind: "documentation" },
				observedAt,
				data: {
					directory: "root",
					description: "Top-level ThinkRail resources available for exploration",
				},
				references: [
					{
						ref: "thinkrail:projects",
						title: "Projects",
						kind: "collection",
						description: "All registered ThinkRail project repositories",
					},
					{
						ref: "thinkrail:sessions",
						title: "Sessions & Tasks",
						kind: "query",
						description: "Active coding agent sessions and plan execution state",
					},
				],
			});
		}

		if (parentRef === "thinkrail:projects") {
			try {
				const { projects, total } = await this.realSessions.listProjects();
				const query = params?.query?.toLowerCase();
				const filtered = query
					? projects.filter((p) => p.name.toLowerCase().includes(query))
					: projects;

				const offset = params?.cursor ? Number.parseInt(params.cursor, 10) || 0 : 0;
				const pageSize = 10;
				const page = filtered.slice(offset, offset + pageSize);
				const nextCursor = offset + pageSize < filtered.length ? String(offset + pageSize) : null;

				const references: ExplorationReference[] = page.map((p) => ({
					ref: `thinkrail:project:${p.projectId}`,
					title: p.name,
					kind: "entity",
					description: p.closed ? "Closed project" : "Active project",
				}));

				return boundEnvelope({
					protocol: "muse-software/1",
					kind: "directory",
					status: "ok",
					source: { id: "thinkrail:projects", kind: "live" },
					observedAt,
					data: {
						total,
						filteredCount: filtered.length,
						pageCount: page.length,
					},
					references,
					nextCursor,
				});
			} catch (err) {
				return {
					protocol: "muse-software/1",
					kind: "directory",
					status: "unavailable",
					source: { id: "thinkrail:projects", kind: "live" },
					observedAt,
					data: {
						message: err instanceof Error ? err.message : "Failed to query ThinkRail projects",
					},
				};
			}
		}

		if (parentRef === "thinkrail:sessions") {
			try {
				const { sessions, total } = await this.realSessions.list({ status: "active", limit: 20 });
				const query = params?.query?.toLowerCase();
				const filtered = query
					? sessions.filter(
							(s) =>
								s.name.toLowerCase().includes(query) ||
								s.projectName.toLowerCase().includes(query),
						)
					: sessions;

				const offset = params?.cursor ? Number.parseInt(params.cursor, 10) || 0 : 0;
				const pageSize = 10;
				const page = filtered.slice(offset, offset + pageSize);
				const nextCursor = offset + pageSize < filtered.length ? String(offset + pageSize) : null;

				const references: ExplorationReference[] = page.map((s) => ({
					ref: `thinkrail:session:${s.sessionId}`,
					title: s.name || s.sessionId,
					kind: "entity",
					description: `Project: ${s.projectName} | Status: ${s.status} | Plan: ${s.planProgress.percentage ?? "N/A"}%`,
				}));

				return boundEnvelope({
					protocol: "muse-software/1",
					kind: "directory",
					status: "ok",
					source: { id: "thinkrail:sessions", kind: "live" },
					observedAt,
					data: {
						total,
						filteredCount: filtered.length,
						pageCount: page.length,
					},
					references,
					nextCursor,
				});
			} catch (err) {
				return {
					protocol: "muse-software/1",
					kind: "directory",
					status: "unavailable",
					source: { id: "thinkrail:sessions", kind: "live" },
					observedAt,
					data: {
						message: err instanceof Error ? err.message : "Failed to query ThinkRail sessions",
					},
				};
			}
		}

		return {
			protocol: "muse-software/1",
			kind: "directory",
			status: "unsupported",
			source: { id: "thinkrail:directory", kind: "documentation" },
			observedAt,
			data: { message: `Unsupported parentRef: ${parentRef}` },
		};
	}

	public async read(params: {
		ref: string;
		arguments?: Record<string, unknown>;
	}): Promise<ExplorationEnvelope> {
		const { ref, arguments: args } = params;
		const observedAt = new Date().toISOString();

		if (ref === "thinkrail:projects") {
			try {
				const { projects, total } = await this.realSessions.listProjects();
				const references: ExplorationReference[] = projects.slice(0, 15).map((p) => ({
					ref: `thinkrail:project:${p.projectId}`,
					title: p.name,
					kind: "entity",
					description: p.closed ? "Closed project" : "Active project",
				}));

				return boundEnvelope({
					protocol: "muse-software/1",
					kind: "resource",
					status: "ok",
					source: { id: "thinkrail:projects", kind: "live" },
					observedAt,
					data: {
						total,
						projects: projects.map((p) => ({
							projectId: p.projectId,
							name: p.name,
							closed: p.closed,
							lastOpened: p.lastOpened,
						})),
					},
					references,
				});
			} catch (err) {
				return {
					protocol: "muse-software/1",
					kind: "resource",
					status: "unavailable",
					source: { id: "thinkrail:projects", kind: "live" },
					observedAt,
					data: {
						message: err instanceof Error ? err.message : "Failed to query ThinkRail projects",
					},
				};
			}
		}

		if (ref === "thinkrail:sessions") {
			try {
				const status = (typeof args?.status === "string" ? args.status : "active") as
					| "all"
					| "active"
					| "recent"
					| "running";
				const limit = typeof args?.limit === "number" ? Math.min(args.limit, 25) : 10;
				const { sessions, total } = await this.realSessions.list({ status, limit });

				const references: ExplorationReference[] = sessions.slice(0, 15).map((s) => ({
					ref: `thinkrail:session:${s.sessionId}`,
					title: s.name || s.sessionId,
					kind: "entity",
					description: `Status: ${s.status} | Plan: ${s.planProgress.percentage ?? "N/A"}%`,
				}));

				return boundEnvelope({
					protocol: "muse-software/1",
					kind: "resource",
					status: "ok",
					source: { id: "thinkrail:sessions", kind: "live" },
					observedAt,
					data: {
						total,
						count: sessions.length,
						statusFilter: status,
						sessions: sessions.map((s) => ({
							sessionId: s.sessionId,
							name: s.name,
							projectName: s.projectName,
							workspaceName: s.workspaceName,
							status: s.status,
							planProgress: s.planProgress,
							currentTasks: s.currentTasks,
						})),
					},
					references,
				});
			} catch (err) {
				return {
					protocol: "muse-software/1",
					kind: "resource",
					status: "unavailable",
					source: { id: "thinkrail:sessions", kind: "live" },
					observedAt,
					data: {
						message: err instanceof Error ? err.message : "Failed to query ThinkRail sessions",
					},
				};
			}
		}

		if (ref.startsWith("thinkrail:project:")) {
			const projectId = ref.slice("thinkrail:project:".length).trim();
			try {
				const { projects } = await this.realSessions.listProjects();
				const project = projects.find((p) => p.projectId === projectId);
				if (!project) {
					return {
						protocol: "muse-software/1",
						kind: "resource",
						status: "ok",
						source: { id: `thinkrail:project:${projectId}`, kind: "live" },
						observedAt,
						data: { found: false, message: `Project ${projectId} not found` },
					};
				}

				let projectSessions: RealSession[] = [];
				try {
					const sessionResult = await this.realSessions.list({ status: "all", limit: 30 });
					projectSessions = sessionResult.sessions.filter((s) => s.projectId === projectId);
				} catch {
					// Session read is best-effort
				}

				const references: ExplorationReference[] = projectSessions.slice(0, 10).map((s) => ({
					ref: `thinkrail:session:${s.sessionId}`,
					title: s.name || s.sessionId,
					kind: "entity",
					description: `Status: ${s.status} | Plan: ${s.planProgress.percentage ?? "N/A"}%`,
				}));

				return boundEnvelope({
					protocol: "muse-software/1",
					kind: "resource",
					status: "ok",
					source: { id: `thinkrail:project:${projectId}`, kind: "live" },
					observedAt,
					data: {
						found: true,
						project: {
							projectId: project.projectId,
							name: project.name,
							closed: project.closed,
							lastOpened: project.lastOpened,
						},
						sessionCount: projectSessions.length,
						activeSessions: projectSessions.filter((s) => s.status === "running").length,
					},
					references,
				});
			} catch (err) {
				return {
					protocol: "muse-software/1",
					kind: "resource",
					status: "unavailable",
					source: { id: `thinkrail:project:${projectId}`, kind: "live" },
					observedAt,
					data: {
						message: err instanceof Error ? err.message : "Failed to query ThinkRail project",
					},
				};
			}
		}

		if (ref.startsWith("thinkrail:session:")) {
			const sessionId = ref.slice("thinkrail:session:".length).trim();
			try {
				const { sessions } = await this.realSessions.list({ sessionId });
				const session = sessions.find((s) => s.sessionId === sessionId);
				if (!session) {
					return {
						protocol: "muse-software/1",
						kind: "resource",
						status: "ok",
						source: { id: `thinkrail:session:${sessionId}`, kind: "live" },
						observedAt,
						data: { found: false, message: `Session ${sessionId} not found` },
					};
				}

				const references: ExplorationReference[] = [
					{
						ref: `thinkrail:project:${session.projectId}`,
						title: session.projectName,
						kind: "entity",
						description: "Parent project repository",
					},
				];

				return boundEnvelope({
					protocol: "muse-software/1",
					kind: "resource",
					status: "ok",
					source: { id: `thinkrail:session:${sessionId}`, kind: "live" },
					observedAt,
					data: {
						found: true,
						sessionId: session.sessionId,
						name: session.name,
						projectId: session.projectId,
						projectName: session.projectName,
						workspaceId: session.workspaceId,
						workspaceName: session.workspaceName,
						status: session.status,
						state: {
							execution: session.state.execution,
							backgroundWork: session.state.backgroundWork,
							needsInput: session.state.needsInput,
							queuedCount: session.state.queuedCount,
						},
						planProgress: session.planProgress,
						currentTasks: session.currentTasks,
						tasks: session.tasks,
					},
					references,
				});
			} catch (err) {
				return {
					protocol: "muse-software/1",
					kind: "resource",
					status: "unavailable",
					source: { id: `thinkrail:session:${sessionId}`, kind: "live" },
					observedAt,
					data: {
						message: err instanceof Error ? err.message : "Failed to query ThinkRail session",
					},
				};
			}
		}

		return {
			protocol: "muse-software/1",
			kind: "resource",
			status: "unsupported",
			source: { id: "thinkrail:resource", kind: "documentation" },
			observedAt,
			data: { message: `Unsupported ref: ${ref}` },
		};
	}
}

export function createThinkRailExploration(
	realSessions: RealSessionSource & RealProjectSource,
	descriptor: SoftwareExplorationDescriptor = DEFAULT_EXPLORATION_DESCRIPTOR,
): {
	exploration: SoftwareExplorationDescriptor;
	tools: ToolDefinition[];
	adapter: ThinkRailExplorationAdapter;
} {
	const adapter = new ThinkRailExplorationAdapter(realSessions, descriptor);
	return {
		exploration: descriptor,
		tools: EXPLORATION_TOOLS,
		adapter,
	};
}
