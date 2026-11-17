import { randomUUID } from "node:crypto";
import EventEmitter from "node:events";
import type { MuseHubClient } from "./hub-client";
import type { SessionState, SessionStatus, SessionStepDefinition, SessionStepState } from "./types";

export interface CreateSessionOptions {
	name: string;
	parameters?: Record<string, unknown>;
	steps: SessionStepDefinition[];
	associatedTaskId?: string;
	autoStart?: boolean;
}

export class SessionManager extends EventEmitter {
	private readonly sessions = new Map<string, SessionState>();
	private readonly abortControllers = new Map<string, AbortController>();
	private readonly stepDefs = new Map<string, SessionStepDefinition[]>();
	private readonly hubClient: MuseHubClient | null = null;

	constructor(hubClient: MuseHubClient | null = null) {
		super();
		this.hubClient = hubClient;
	}

	public createSession(options: CreateSessionOptions): SessionState {
		const id = `sess_${randomUUID().slice(0, 8)}`;
		const now = Date.now();

		const stepStates: SessionStepState[] = options.steps.map((s) => ({
			id: s.id,
			title: s.title,
			status: "pending",
			progress: 0,
		}));

		const session: SessionState = {
			id,
			name: options.name,
			status: "pending",
			progress: 0,
			currentStepIndex: 0,
			totalSteps: options.steps.length,
			steps: stepStates,
			parameters: options.parameters || {},
			createdAt: now,
			updatedAt: now,
			associatedTaskId: options.associatedTaskId,
		};

		this.sessions.set(id, session);
		this.stepDefs.set(id, options.steps);

		this.emit("session_created", session);

		if (options.autoStart) {
			this.startSession(id).catch((err) => {
				this.emit("session_failed", { session, error: err?.message || String(err) });
			});
		}

		return session;
	}

	public async startSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		const defs = this.stepDefs.get(sessionId);
		if (!session || !defs) throw new Error(`会话不存在: ${sessionId}`);

		if (session.status === "running") return;
		if (session.status === "completed" || session.status === "cancelled") {
			throw new Error(`会话已处于终态 (${session.status})，无法启动`);
		}

		session.status = "running";
		session.updatedAt = Date.now();
		const ac = new AbortController();
		this.abortControllers.set(sessionId, ac);
		this.emit("session_started", session);

		try {
			for (let i = session.currentStepIndex; i < defs.length; i++) {
				if (ac.signal.aborted) break;

				session.currentStepIndex = i;
				const currentDef = defs[i];
				const currentStep = session.steps[i];
				if (!currentDef || !currentStep) continue;

				currentStep.status = "running";
				currentStep.startedAt = Date.now();
				session.updatedAt = Date.now();

				this.emit("step_started", { sessionId, step: currentStep });

				try {
					const result = await currentDef.execute({
						signal: ac.signal,
						isCancelled: () => ac.signal.aborted,
						reportProgress: (pctInStep, msg) => {
							currentStep.progress = Math.max(0, Math.min(100, Math.round(pctInStep)));
							currentStep.message = msg;
							this.recalculateOverallProgress(session);

							this.emit("step_progress", {
								sessionId,
								step: currentStep,
								overallProgress: session.progress,
							});

							if (session.associatedTaskId && this.hubClient?.isConnected()) {
								this.hubClient.sendProgress(session.associatedTaskId, {
									percentage: session.progress,
									message: msg || `正在执行步骤: ${currentStep.title}`,
									currentStep: currentStep.title,
									stepIndex: i + 1,
									totalSteps: session.totalSteps,
								});
							}
						},
					});

					if (ac.signal.aborted) {
						currentStep.status = "cancelled";
						break;
					}

					currentStep.status = "completed";
					currentStep.progress = 100;
					currentStep.result = result;
					currentStep.completedAt = Date.now();
					this.recalculateOverallProgress(session);

					this.emit("step_completed", { sessionId, step: currentStep });
				} catch (err: unknown) {
					currentStep.status = "failed";
					currentStep.error = err instanceof Error ? err.message : String(err);
					currentStep.completedAt = Date.now();
					session.status = "failed";
					session.error = currentStep.error;
					session.updatedAt = Date.now();

					this.emit("step_failed", { sessionId, step: currentStep, error: currentStep.error });
					this.emit("session_failed", session);

					if (session.associatedTaskId && this.hubClient?.isConnected()) {
						this.hubClient.sendFailed(session.associatedTaskId, currentStep.error);
					}
					return;
				}
			}

			if (ac.signal.aborted) {
				session.status = "cancelled";
				session.updatedAt = Date.now();
				this.emit("session_cancelled", session);

				if (session.associatedTaskId && this.hubClient?.isConnected()) {
					this.hubClient.sendFailed(session.associatedTaskId, "任务被用户或系统中断取消");
				}
			} else {
				session.status = "completed";
				session.progress = 100;
				session.completedAt = Date.now();
				session.updatedAt = Date.now();
				this.emit("session_completed", session);

				if (session.associatedTaskId && this.hubClient?.isConnected()) {
					this.hubClient.sendCompleted(session.associatedTaskId, {
						sessionId: session.id,
						name: session.name,
						status: "completed",
						totalSteps: session.totalSteps,
						result: session.steps[session.steps.length - 1]?.result || "OK",
					});
				}
			}
		} finally {
			this.abortControllers.delete(sessionId);
		}
	}

	public cancelSession(sessionId: string, reason = "用户取消"): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;

		if (
			session.status === "completed" ||
			session.status === "failed" ||
			session.status === "cancelled"
		) {
			return false;
		}

		const ac = this.abortControllers.get(sessionId);
		if (ac) ac.abort(reason);

		session.status = "cancelled";
		session.error = reason;
		session.updatedAt = Date.now();

		return true;
	}

	public getSnapshot(sessionId: string): SessionState | undefined {
		const s = this.sessions.get(sessionId);
		return s ? JSON.parse(JSON.stringify(s)) : undefined;
	}

	public getSessionByTaskId(taskId: string): SessionState | undefined {
		for (const s of this.sessions.values()) {
			if (s.associatedTaskId === taskId) return this.getSnapshot(s.id);
		}
		return undefined;
	}

	public listSessions(filter?: { status?: SessionStatus | "all"; limit?: number }): SessionState[] {
		let list = Array.from(this.sessions.values());
		if (filter?.status && filter.status !== "all") {
			list = list.filter((s) => s.status === filter.status);
		}
		list.sort((a, b) => b.createdAt - a.createdAt);
		if (filter?.limit && filter.limit > 0) {
			list = list.slice(0, filter.limit);
		}
		return list.map((s) => JSON.parse(JSON.stringify(s)));
	}

	private recalculateOverallProgress(session: SessionState): void {
		const defs = this.stepDefs.get(session.id) || [];
		let totalWeight = 0;
		let accumulated = 0;

		for (let i = 0; i < session.steps.length; i++) {
			const step = session.steps[i];
			if (!step) continue;
			const weight = defs[i]?.weight || 1;
			totalWeight += weight;
			const stepProgress = step.progress;
			accumulated += (stepProgress / 100) * weight;
		}

		session.progress = totalWeight > 0 ? Math.round((accumulated / totalWeight) * 100) : 0;
		session.updatedAt = Date.now();
	}
}
