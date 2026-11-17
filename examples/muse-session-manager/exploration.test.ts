import { describe, expect, it } from "bun:test";
import type { MuseHubClient } from "./hub-client";
import { ToolRouter } from "./router";
import { SessionManager } from "./session-manager";
import type {
	RealProject,
	RealProjectSource,
	RealSession,
	RealSessionSource,
} from "./thinkrail-reader";
import {
	createThinkRailExploration,
	DEFAULT_EXPLORATION_DESCRIPTOR,
	EXPLORATION_TOOLS,
	ThinkRailExplorationAdapter,
} from "./thinkrail-software-exploration";

class MockDataSource implements RealSessionSource, RealProjectSource {
	public projects: RealProject[] = [
		{ projectId: "proj-1", name: "thinkrail", closed: false, lastOpened: 1700000000 },
		{ projectId: "proj-2", name: "pi-agent", closed: true, lastOpened: 1690000000 },
	];

	public sessions: RealSession[] = [
		{
			source: "thinkrail",
			sessionId: "sess-1",
			workspaceId: "ws-1",
			projectId: "proj-1",
			name: "Fix login redirect",
			projectName: "thinkrail",
			workspaceName: "fix-login",
			status: "running",
			state: {
				execution: "running",
				runId: "run-1",
				needsInput: null,
				completion: null,
				completionUnread: false,
				queuedCount: 0,
				backgroundWork: false,
			},
			planProgress: { done: 2, total: 4, percentage: 50 },
			currentTasks: [{ id: "t-2", title: "Add auth check", status: "in_progress" }],
			tasks: [
				{ id: "t-1", title: "Reproduce bug", status: "done" },
				{ id: "t-2", title: "Add auth check", status: "in_progress" },
				{ id: "t-3", title: "Add test", status: "pending" },
				{ id: "t-4", title: "Verify build", status: "pending" },
			],
			completionId: null,
		},
	];

	public failNext = false;

	async listProjects(): Promise<{ total: number; projects: RealProject[] }> {
		if (this.failNext) throw new Error("Connection refused to ThinkRail daemon");
		return { total: this.projects.length, projects: this.projects };
	}

	async list(query?: {
		status?: string;
		limit?: number;
		sessionId?: string;
	}): Promise<{ total: number; sessions: RealSession[] }> {
		if (this.failNext) throw new Error("ThinkRail RPC timeout");
		let list = this.sessions;
		if (query?.sessionId) {
			list = list.filter((s) => s.sessionId === query.sessionId);
		}
		return { total: list.length, sessions: list };
	}
}

describe("ThinkRail Software Exploration (muse-software/1)", () => {
	it("exposes tools that conform to read-only constraints and descriptor mapping", () => {
		expect(EXPLORATION_TOOLS.length).toBe(3);
		for (const tool of EXPLORATION_TOOLS) {
			expect(tool.riskLevel).toBe("read-only");
			expect(tool.requiresApproval).toBe(false);
			expect(["software_overview", "software_discover", "software_read"]).toContain(tool.toolId);
		}
		expect(DEFAULT_EXPLORATION_DESCRIPTOR.overviewToolId).toBe("software_overview");
		expect(DEFAULT_EXPLORATION_DESCRIPTOR.discoverToolId).toBe("software_discover");
		expect(DEFAULT_EXPLORATION_DESCRIPTOR.readToolId).toBe("software_read");
	});

	it("overview returns conceptual model, guidelines, and root references", async () => {
		const mock = new MockDataSource();
		const adapter = new ThinkRailExplorationAdapter(mock);

		const res = await adapter.overview();
		expect(res.protocol).toBe("muse-software/1");
		expect(res.kind).toBe("overview");
		expect(res.status).toBe("ok");
		expect(res.source.id).toBe("thinkrail:software-guide");
		expect(res.data).toBeDefined();

		const data = res.data as Record<string, unknown>;
		expect(typeof data.purpose).toBe("string");
		expect(data.concepts).toBeDefined();
		expect(data.limitations).toBeDefined();

		expect(res.references?.length).toBeGreaterThanOrEqual(2);
		const refs = res.references?.map((r) => r.ref);
		expect(refs).toContain("thinkrail:projects");
		expect(refs).toContain("thinkrail:sessions");
	});

	it("discover handles root, projects, sessions, queries and unknown parentRef", async () => {
		const mock = new MockDataSource();
		const adapter = new ThinkRailExplorationAdapter(mock);

		// 1. Root discovery
		const root = await adapter.discover();
		expect(root.kind).toBe("directory");
		expect(root.status).toBe("ok");
		expect(root.references?.map((r) => r.ref)).toEqual([
			"thinkrail:projects",
			"thinkrail:sessions",
		]);

		// 2. Projects discovery
		const projectsDir = await adapter.discover({ parentRef: "thinkrail:projects" });
		expect(projectsDir.status).toBe("ok");
		expect(projectsDir.references?.length).toBe(2);
		expect(projectsDir.references?.[0]?.ref).toBe("thinkrail:project:proj-1");

		// 3. Projects discovery with query
		const filteredProjects = await adapter.discover({
			parentRef: "thinkrail:projects",
			query: "thinkrail",
		});
		expect(filteredProjects.references?.length).toBe(1);
		expect(filteredProjects.references?.[0]?.title).toBe("thinkrail");

		// 4. Sessions discovery
		const sessionsDir = await adapter.discover({ parentRef: "thinkrail:sessions" });
		expect(sessionsDir.status).toBe("ok");
		expect(sessionsDir.references?.[0]?.ref).toBe("thinkrail:session:sess-1");

		// 5. Unknown parentRef
		const unknownDir = await adapter.discover({ parentRef: "unknown:ref" });
		expect(unknownDir.status).toBe("unsupported");
	});

	it("discover returns status unavailable when upstream ThinkRail fails", async () => {
		const mock = new MockDataSource();
		mock.failNext = true;
		const adapter = new ThinkRailExplorationAdapter(mock);

		const res = await adapter.discover({ parentRef: "thinkrail:projects" });
		expect(res.status).toBe("unavailable");
		expect(res.kind).toBe("directory");
		expect((res.data as Record<string, unknown>).message).toContain("Connection refused");
	});

	it("read queries projects, sessions, project entities, and session details", async () => {
		const mock = new MockDataSource();
		const adapter = new ThinkRailExplorationAdapter(mock);

		// 1. Read all projects
		const projectsRes = await adapter.read({ ref: "thinkrail:projects" });
		expect(projectsRes.status).toBe("ok");
		expect(projectsRes.kind).toBe("resource");
		expect((projectsRes.data as Record<string, unknown>).total).toBe(2);

		// 2. Read sessions
		const sessionsRes = await adapter.read({
			ref: "thinkrail:sessions",
			arguments: { status: "active" },
		});
		expect(sessionsRes.status).toBe("ok");
		expect((sessionsRes.data as Record<string, unknown>).count).toBe(1);

		// 3. Read specific project entity
		const projRes = await adapter.read({ ref: "thinkrail:project:proj-1" });
		expect(projRes.status).toBe("ok");
		expect((projRes.data as Record<string, unknown>).found).toBe(true);

		// 4. Read non-existent project
		const missingProjRes = await adapter.read({ ref: "thinkrail:project:not-found" });
		expect(missingProjRes.status).toBe("ok");
		expect((missingProjRes.data as Record<string, unknown>).found).toBe(false);

		// 5. Read specific session entity
		const sessRes = await adapter.read({ ref: "thinkrail:session:sess-1" });
		expect(sessRes.status).toBe("ok");
		const sessData = sessRes.data as Record<string, unknown>;
		expect(sessData.found).toBe(true);
		expect(sessData.name).toBe("Fix login redirect");
		expect(sessData.planProgress).toEqual({ done: 2, total: 4, percentage: 50 });

		// 6. Read non-existent session
		const missingSessRes = await adapter.read({ ref: "thinkrail:session:non-existent" });
		expect(missingSessRes.status).toBe("ok");
		expect((missingSessRes.data as Record<string, unknown>).found).toBe(false);

		// 7. Unsupported ref
		const unsupportedRes = await adapter.read({ ref: "thinkrail:unknown" });
		expect(unsupportedRes.status).toBe("unsupported");
	});

	it("read returns status unavailable when upstream ThinkRail is offline", async () => {
		const mock = new MockDataSource();
		mock.failNext = true;
		const adapter = new ThinkRailExplorationAdapter(mock);

		const res = await adapter.read({ ref: "thinkrail:sessions" });
		expect(res.status).toBe("unavailable");
		expect((res.data as Record<string, unknown>).message).toContain("ThinkRail RPC timeout");
	});

	it("ToolRouter routes exploration endpoints to ThinkRailExplorationAdapter", async () => {
		const mock = new MockDataSource();
		const { adapter } = createThinkRailExploration(mock);

		let completedPayload: unknown = null;
		const mockHubClient = {
			on: () => {},
			sendCompleted: (_taskId: string, payload: unknown) => {
				completedPayload = payload;
			},
			sendFailed: () => {},
			sendProgress: () => {},
			sendEvent: () => {},
		} as unknown as MuseHubClient;

		const mockSessionManager = new SessionManager(mockHubClient);
		const router = new ToolRouter(mockSessionManager, mockHubClient, mock, adapter);

		// 1. Dispatch software_overview
		await router.handleTaskDispatched({
			taskId: "task-ov-1",
			type: "task.dispatched",
			timestamp: Date.now(),
			payload: { taskId: "task-ov-1", toolId: "software_overview", parameters: {} },
		});

		expect(completedPayload).toBeDefined();
		expect((completedPayload as Record<string, unknown>).protocol).toBe("muse-software/1");
		expect((completedPayload as Record<string, unknown>).kind).toBe("overview");

		// 2. Dispatch software_read
		await router.handleTaskDispatched({
			taskId: "task-read-1",
			type: "task.dispatched",
			timestamp: Date.now(),
			payload: {
				taskId: "task-read-1",
				toolId: "software_read",
				parameters: { ref: "thinkrail:session:sess-1" },
			},
		});

		expect((completedPayload as Record<string, unknown>).kind).toBe("resource");
		expect(
			((completedPayload as Record<string, unknown>).data as Record<string, unknown>).found,
		).toBe(true);
	});
});
