import EventEmitter from 'node:events';
import type { MuseHubClient } from './hub-client';
import type {
  SessionState,
  SessionStatus,
  SessionStepContext,
  SessionStepDefinition,
  SessionStepState,
} from './types';

export interface CreateSessionOptions {
  id?: string;
  name: string;
  parameters?: Record<string, unknown>;
  steps: SessionStepDefinition[];
  associatedTaskId?: string;
  autoStart?: boolean;
}

export interface SessionExecutionInternal {
  state: SessionState;
  stepDefs: SessionStepDefinition[];
  abortController: AbortController;
  promise?: Promise<SessionState>;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, SessionExecutionInternal>();
  private taskIdToSessionId = new Map<string, string>();
  private hubClient?: MuseHubClient;

  constructor(hubClient?: MuseHubClient) {
    super();
    if (hubClient) {
      this.attachHubClient(hubClient);
    }
  }

  public attachHubClient(hubClient: MuseHubClient): void {
    this.hubClient = hubClient;

    // Listen to task cancellation from Hub (e.g. Luna / user cancelled task)
    hubClient.on('task.cancelled', (msg) => {
      const sessionId = this.taskIdToSessionId.get(msg.taskId);
      if (sessionId) {
        this.cancelSession(sessionId, msg.payload?.reason || 'Cancelled by Muse Hub');
      }
    });
  }

  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 8);
    return `sess_${timestamp}_${rand}`;
  }

  /**
   * Create a new session with configured execution steps
   */
  public createSession(options: CreateSessionOptions): SessionState {
    const sessionId = options.id || this.generateSessionId();
    const now = Date.now();

    const stepStates: SessionStepState[] = options.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: 'pending',
      progress: 0,
      message: step.description,
    }));

    const state: SessionState = {
      id: sessionId,
      name: options.name,
      status: 'pending',
      progress: 0,
      currentStepIndex: 0,
      totalSteps: options.steps.length,
      steps: stepStates,
      parameters: options.parameters || {},
      createdAt: now,
      updatedAt: now,
      associatedTaskId: options.associatedTaskId,
    };

    const internal: SessionExecutionInternal = {
      state,
      stepDefs: options.steps,
      abortController: new AbortController(),
    };

    this.sessions.set(sessionId, internal);
    if (options.associatedTaskId) {
      this.taskIdToSessionId.set(options.associatedTaskId, sessionId);
    }

    this.emit('session_created', state);

    if (options.autoStart) {
      this.startSession(sessionId).catch(() => {
        // Handled internally in startSession
      });
    }

    return this.getSnapshot(sessionId)!;
  }

  /**
   * Start executing a session through its steps
   */
  public async startSession(sessionId: string): Promise<SessionState> {
    const internal = this.sessions.get(sessionId);
    if (!internal) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (internal.state.status === 'running') {
      return this.getSnapshot(sessionId)!;
    }

    if (internal.state.status === 'completed' || internal.state.status === 'cancelled') {
      throw new Error(`Session ${sessionId} is in terminal state: ${internal.state.status}`);
    }

    internal.state.status = 'running';
    internal.state.updatedAt = Date.now();
    this.updateHubActiveCount();
    this.emit('session_started', this.getSnapshot(sessionId)!);

    // Initial progress report (0%)
    this.notifyProgress(internal, '会话已启动...');

    internal.promise = this.executeSteps(internal);
    return internal.promise;
  }

  private async executeSteps(internal: SessionExecutionInternal): Promise<SessionState> {
    const { state, stepDefs, abortController } = internal;
    const totalSteps = stepDefs.length;

    try {
      for (let i = 0; i < totalSteps; i++) {
        if (abortController.signal.aborted) {
          throw new Error('Session cancelled');
        }

        const stepDef = stepDefs[i];
        const stepState = state.steps[i];

        state.currentStepIndex = i;
        stepState.status = 'running';
        stepState.startedAt = Date.now();
        stepState.progress = 0;
        state.updatedAt = Date.now();

        this.notifyProgress(
          internal,
          `[步骤 ${i + 1}/${totalSteps}] ${stepDef.title} 开始执行`
        );
        this.emit('step_started', { sessionId: state.id, step: stepState });

        // Step context for runner
        const stepContext: SessionStepContext = {
          reportProgress: (progressInStep: number, message: string) => {
            if (abortController.signal.aborted) return;
            stepState.progress = Math.min(100, Math.max(0, progressInStep));
            stepState.message = message;
            state.updatedAt = Date.now();
            this.recalculateOverallProgress(internal);
            this.notifyProgress(internal, message);
            this.emit('step_progress', {
              sessionId: state.id,
              step: stepState,
              overallProgress: state.progress,
            });
          },
          isCancelled: () => abortController.signal.aborted,
          signal: abortController.signal,
        };

        try {
          const stepResult = await stepDef.execute(stepContext);
          stepState.result = stepResult;
          stepState.status = 'completed';
          stepState.progress = 100;
          stepState.completedAt = Date.now();
          this.recalculateOverallProgress(internal);

          this.emit('step_completed', {
            sessionId: state.id,
            step: stepState,
            result: stepResult,
          });
        } catch (stepErr) {
          if (abortController.signal.aborted) {
            stepState.status = 'cancelled';
            stepState.error = 'Step cancelled';
            throw new Error('Session cancelled');
          }
          stepState.status = 'failed';
          stepState.error = stepErr instanceof Error ? stepErr.message : String(stepErr);
          stepState.completedAt = Date.now();
          throw stepErr;
        }
      }

      // All steps completed successfully
      state.status = 'completed';
      state.progress = 100;
      state.completedAt = Date.now();
      state.updatedAt = Date.now();
      state.result = {
        summary: `会话 [${state.name}] 完成，共成功执行 ${totalSteps} 个步骤。`,
        stepResults: state.steps.map((s) => ({
          id: s.id,
          title: s.title,
          result: s.result,
        })),
      };

      this.updateHubActiveCount();
      this.notifyCompleted(internal);
      this.emit('session_completed', this.getSnapshot(state.id)!);

      return this.getSnapshot(state.id)!;
    } catch (err) {
      if (abortController.signal.aborted) {
        state.status = 'cancelled';
        state.error = 'Session execution was cancelled';
        this.updateHubActiveCount();
        this.notifyCancelled(internal);
        this.emit('session_cancelled', this.getSnapshot(state.id)!);
      } else {
        state.status = 'failed';
        const error = err instanceof Error ? err.message : String(err);
        state.error = error;
        this.updateHubActiveCount();
        this.notifyFailed(internal, error);
        this.emit('session_failed', this.getSnapshot(state.id)!);
      }
      return this.getSnapshot(state.id)!;
    }
  }

  private recalculateOverallProgress(internal: SessionExecutionInternal): void {
    const { state, stepDefs } = internal;
    if (stepDefs.length === 0) {
      state.progress = 100;
      return;
    }

    let totalWeight = 0;
    let accumulatedWeight = 0;

    for (let i = 0; i < stepDefs.length; i++) {
      const weight = stepDefs[i].weight || 1;
      totalWeight += weight;

      const stepProgress = state.steps[i]?.progress || 0;
      accumulatedWeight += weight * (stepProgress / 100);
    }

    state.progress = Math.min(100, Math.round((accumulatedWeight / totalWeight) * 100));
  }

  private notifyProgress(internal: SessionExecutionInternal, message: string): void {
    const { state } = internal;
    if (!this.hubClient) return;

    if (state.associatedTaskId) {
      const currentStep = state.steps[state.currentStepIndex];
      this.hubClient.sendProgress(state.associatedTaskId, {
        percentage: state.progress,
        message,
        currentStep: currentStep?.title,
        stepIndex: state.currentStepIndex + 1,
        totalSteps: state.totalSteps,
      });
    }
  }

  private notifyCompleted(internal: SessionExecutionInternal): void {
    const { state } = internal;
    if (!this.hubClient) return;

    if (state.associatedTaskId) {
      this.hubClient.sendCompleted(state.associatedTaskId, state.result);
    }

    // Trigger desktop pet balloon notification
    this.hubClient.sendProactiveEvent(
      `🎉 会话「${state.name}」已顺利完成全部 ${state.totalSteps} 个步骤！`,
      'task.completed',
      { sessionId: state.id, name: state.name }
    );
  }

  private notifyFailed(internal: SessionExecutionInternal, error: string): void {
    const { state } = internal;
    if (!this.hubClient) return;

    if (state.associatedTaskId) {
      this.hubClient.sendFailed(state.associatedTaskId, error, {
        sessionId: state.id,
        currentStep: state.currentStepIndex + 1,
      });
    }

    this.hubClient.sendProactiveEvent(
      `⚠️ 会话「${state.name}」在步骤 ${state.currentStepIndex + 1} 执行失败: ${error}`,
      'alert',
      { sessionId: state.id, error }
    );
  }

  private notifyCancelled(internal: SessionExecutionInternal): void {
    const { state } = internal;
    if (!this.hubClient) return;

    this.hubClient.sendProactiveEvent(
      `🛑 会话「${state.name}」已由用户或系统中断取消。`,
      'notification',
      { sessionId: state.id }
    );
  }

  private updateHubActiveCount(): void {
    if (!this.hubClient) return;
    let activeCount = 0;
    for (const internal of this.sessions.values()) {
      if (internal.state.status === 'running') {
        activeCount++;
      }
    }
    this.hubClient.setActiveTasksCount(activeCount);
  }

  /**
   * Cancel an active session
   */
  public cancelSession(sessionId: string, reason?: string): boolean {
    const internal = this.sessions.get(sessionId);
    if (!internal) return false;

    if (internal.state.status !== 'running' && internal.state.status !== 'pending') {
      return false;
    }

    internal.abortController.abort(reason);
    internal.state.status = 'cancelled';
    internal.state.updatedAt = Date.now();
    internal.state.error = reason || 'Cancelled by user';

    // Mark current running step as cancelled
    const currentStep = internal.state.steps[internal.state.currentStepIndex];
    if (currentStep && currentStep.status === 'running') {
      currentStep.status = 'cancelled';
      currentStep.completedAt = Date.now();
    }

    this.updateHubActiveCount();
    this.notifyCancelled(internal);
    this.emit('session_cancelled', this.getSnapshot(sessionId)!);
    return true;
  }

  /**
   * Get immutable snapshot of a session
   */
  public getSnapshot(sessionId: string): SessionState | undefined {
    const internal = this.sessions.get(sessionId);
    if (!internal) return undefined;
    return JSON.parse(JSON.stringify(internal.state));
  }

  /**
   * Get session by Muse taskId
   */
  public getSessionByTaskId(taskId: string): SessionState | undefined {
    const sessionId = this.taskIdToSessionId.get(taskId);
    if (!sessionId) return undefined;
    return this.getSnapshot(sessionId);
  }

  /**
   * List sessions with optional filters
   */
  public listSessions(filter?: {
    status?: SessionStatus | 'all';
    limit?: number;
  }): SessionState[] {
    const results: SessionState[] = [];
    const limit = filter?.limit || 50;

    for (const internal of this.sessions.values()) {
      if (!filter?.status || filter.status === 'all' || internal.state.status === filter.status) {
        results.push(this.getSnapshot(internal.state.id)!);
      }
      if (results.length >= limit) break;
    }

    // Sort newest first
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results;
  }
}
