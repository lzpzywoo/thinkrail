/**
 * Muse Local Agent Hub & Session Manager Types
 * Conforms to Muse Local Agent Hub Integration Protocol
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
	outputSchema?: Record<string, unknown>;
	requiresApproval?: boolean;
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
	icon?: string;
	tools: ToolDefinition[];
	keywords?: string[];
	exploration?: SoftwareExplorationDescriptor;
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
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface ExplorationEnvelope<T = unknown> {
	protocol: "muse-software/1";
	kind: ExplorationKind;
	status: ExplorationStatus;
	source: ExplorationSource;
	observedAt: string;
	data?: T;
	references?: ExplorationReference[];
	nextCursor?: string | null;
}

export interface HubRegisterResponse {
	ok: boolean;
	data?: {
		sessionToken: string;
		hubVersion: number;
		heartbeatTimeoutMs: number;
	};
	error?: string;
}

export interface HubHeartbeatResponse {
	ok: boolean;
	data?: {
		online: boolean;
	};
	error?: string;
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
	timestamp?: number;
	payload?: {
		reason?: string;
	};
}

export interface WsTaskApprovalRequiredMessage {
	taskId: string;
	type: "task.approval_required";
	timestamp: number;
	payload?: {
		toolId: string;
		riskLevel: RiskLevel;
	};
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
		currentStep?: string;
		stepIndex?: number;
		totalSteps?: number;
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
		details?: unknown;
	};
}

export interface WsProactiveEventMessage {
	type: "event";
	payload: {
		type: "task.completed" | "task.progress" | "notification" | "alert";
		message: string;
		metadata?: Record<string, unknown>;
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
	description?: string;
	weight?: number; // relative weight towards overall percentage (default: 1)
	execute: (ctx: SessionStepContext) => Promise<unknown>;
}

export interface SessionStepState {
	id: string;
	title: string;
	status: StepStatus;
	progress: number; // 0 - 100 within this step
	message?: string;
	startedAt?: number;
	completedAt?: number;
	result?: unknown;
	error?: string;
}

export interface SessionState {
	id: string;
	name: string;
	status: SessionStatus;
	progress: number; // Overall progress 0 - 100
	currentStepIndex: number;
	totalSteps: number;
	steps: SessionStepState[];
	parameters: Record<string, unknown>;
	result?: unknown;
	error?: string;
	createdAt: number;
	updatedAt: number;
	completedAt?: number;
	associatedTaskId?: string; // If triggered by Muse via Hub
}

export interface SessionManagerConfig {
	hubHttpUrl?: string; // e.g. "http://127.0.0.1:19840"
	hubWsUrl?: string; // e.g. "ws://127.0.0.1:19840/ws"
	appId?: string;
	appName?: string;
	appVersion?: string;
	appDescription?: string;
	keywords?: string[];
	thinkrailWsUrl?: string;
	thinkrailQueryTimeoutMs?: number;
	observationIntervalMs?: number;
	secret?: string;
	heartbeatIntervalMs?: number; // default: 20000 (20s)
	reconnectIntervalMs?: number; // default: 3000
	exploration?: SoftwareExplorationDescriptor;
}
