/**
 * Muse Local Agent Hub & Session Manager Types
 * Conforms to Muse Local Agent Hub Integration Protocol & muse-software/1
 */

export type RiskLevel = "read-only" | "write-safe" | "write-dangerous";
export type ToolCategory = "query" | "action" | "vision" | "system";

export interface ToolDefinition {
	toolId: string;
	name: string;
	description: string;
	category: ToolCategory;
	riskLevel: RiskLevel;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown> | undefined;
	requiresApproval?: boolean | undefined;
}

export interface SoftwareExplorationDescriptor {
	version: 1;
	overviewToolId: string;
	discoverToolId: string;
	readToolId: string;
}

export interface AppManifest {
	appId: string;
	name: string;
	version: string;
	description: string;
	secret: string;
	icon?: string | undefined;
	tools: ToolDefinition[];
	keywords?: string[] | undefined;
	exploration?: SoftwareExplorationDescriptor | undefined;
}

// ---------------- Software Understanding & Exploration (muse-software/1) ----------------

export type ExplorationKind = "overview" | "directory" | "resource";
export type ExplorationStatus = "ok" | "unsupported" | "unavailable";
export type ExplorationSourceKind = "live" | "documentation" | "cache";
export type ExplorationRefKind = "guide" | "collection" | "entity" | "query";

export interface ExplorationSource {
	id: string;
	kind: ExplorationSourceKind;
}

export interface ExplorationReference {
	ref: string;
	title: string;
	kind: ExplorationRefKind;
	description?: string | undefined;
	inputSchema?: Record<string, unknown> | undefined;
}

export interface ExplorationEnvelope<T = unknown> {
	protocol: "muse-software/1";
	kind: ExplorationKind;
	status: ExplorationStatus;
	source: ExplorationSource;
	observedAt: string;
	data?: T | undefined;
	references?: ExplorationReference[] | undefined;
	nextCursor?: string | null | undefined;
}

export interface HubRegisterResponse {
	ok: boolean;
	data?:
		| {
				sessionToken: string;
				hubVersion: number;
				heartbeatTimeoutMs: number;
		  }
		| undefined;
	error?: string | undefined;
}

export interface HubHeartbeatResponse {
	ok: boolean;
	data?:
		| {
				online: boolean;
		  }
		| undefined;
	error?: string | undefined;
}

// ---------------- WebSocket Protocol Messages ----------------

export interface WsTaskDispatchedPayload {
	taskId: string;
	toolId: string;
	parameters: Record<string, unknown>;
}

export interface WsTaskDispatchedMessage {
	taskId: string;
	type: "task.dispatched";
	timestamp: number;
	payload: WsTaskDispatchedPayload;
}

export interface WsTaskCancelledMessage {
	taskId: string;
	type: "task.cancelled";
	timestamp?: number | undefined;
	payload?:
		| {
				reason?: string | undefined;
		  }
		| undefined;
}

export interface WsTaskApprovalRequiredMessage {
	taskId: string;
	type: "task.approval_required";
	timestamp: number;
	payload?:
		| {
				toolId: string;
				riskLevel: RiskLevel;
		  }
		| undefined;
}

export type IncomingHubMessage =
	| WsTaskDispatchedMessage
	| WsTaskCancelledMessage
	| WsTaskApprovalRequiredMessage;

export interface WsTaskProgressMessage {
	type: "task.progress";
	taskId: string;
	payload: {
		percentage: number;
		message: string;
		currentStep?: string | undefined;
		stepIndex?: number | undefined;
		totalSteps?: number | undefined;
	};
}

export interface WsTaskCompletedMessage {
	type: "task.completed";
	taskId: string;
	payload: {
		result: unknown;
	};
}

export interface WsTaskFailedMessage {
	type: "task.failed";
	taskId: string;
	payload: {
		error: string;
		details?: unknown | undefined;
	};
}

export interface WsProactiveEventMessage {
	type: "event";
	payload: {
		type: "task.completed" | "task.progress" | "notification" | "alert";
		message: string;
		metadata?: Record<string, unknown> | undefined;
	};
}

export type OutgoingHubMessage =
	| WsTaskProgressMessage
	| WsTaskCompletedMessage
	| WsTaskFailedMessage
	| WsProactiveEventMessage;

// ---------------- Session State Machine ----------------

export type SessionStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type StepStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface SessionStepContext {
	reportProgress: (percentageInStep: number, message: string) => void;
	isCancelled: () => boolean;
	signal: AbortSignal;
}

export interface SessionStepDefinition {
	id: string;
	title: string;
	description?: string | undefined;
	weight?: number | undefined;
	execute: (ctx: SessionStepContext) => Promise<unknown>;
}

export interface SessionStepState {
	id: string;
	title: string;
	status: StepStatus;
	progress: number;
	message?: string | undefined;
	startedAt?: number | undefined;
	completedAt?: number | undefined;
	result?: unknown | undefined;
	error?: string | undefined;
}

export interface SessionState {
	id: string;
	name: string;
	status: SessionStatus;
	progress: number;
	currentStepIndex: number;
	totalSteps: number;
	steps: SessionStepState[];
	parameters: Record<string, unknown>;
	result?: unknown | undefined;
	error?: string | undefined;
	createdAt: number;
	updatedAt: number;
	completedAt?: number | undefined;
	associatedTaskId?: string | undefined;
}

export interface MuseCompanionConfig {
	thinkrailWsUrl: string;
	hubHttpUrl?: string | undefined;
	hubWsUrl?: string | undefined;
	secret?: string | undefined;
	appId?: string | undefined;
	appName?: string | undefined;
	appVersion?: string | undefined;
	appDescription?: string | undefined;
	keywords?: string[] | undefined;
	thinkrailQueryTimeoutMs?: number | undefined;
	observationIntervalMs?: number | undefined;
	heartbeatIntervalMs?: number | undefined;
	reconnectIntervalMs?: number | undefined;
	exploration?: SoftwareExplorationDescriptor | undefined;
}
