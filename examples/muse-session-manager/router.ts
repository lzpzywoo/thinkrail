import type { MuseHubClient } from './hub-client';
import type { SessionManager } from './session-manager';
import { buildPipelineSteps } from './tools';
import type { WsTaskDispatchedMessage } from './types';

export class ToolRouter {
  constructor(
    private sessionManager: SessionManager,
    private hubClient: MuseHubClient
  ) {
    this.hubClient.on('task.dispatched', (msg: WsTaskDispatchedMessage) => {
      this.handleTaskDispatched(msg).catch((err) => {
        this.hubClient.sendFailed(
          msg.taskId,
          err?.message || 'Error processing tool dispatch'
        );
      });
    });
  }

  public async handleTaskDispatched(msg: WsTaskDispatchedMessage): Promise<void> {
    const { taskId, payload } = msg;
    const { toolId, parameters = {} } = payload;

    switch (toolId) {
      case 'create_and_run_session': {
        const name = (parameters.name as string) || `长耗时任务-${new Date().toLocaleTimeString()}`;
        const taskType = (parameters.taskType as string) || 'data_pipeline';
        const stepCount = Number(parameters.stepCount) || 4;
        const stepDurationMs = Number(parameters.stepDurationMs) || 800;

        const steps = buildPipelineSteps(taskType, stepCount, stepDurationMs);

        // Create and auto-start session; SessionManager will stream progress to Muse Hub via taskId
        const session = this.sessionManager.createSession({
          name,
          parameters,
          steps,
          associatedTaskId: taskId,
          autoStart: true,
        });

        // We report initial progress right away so Muse/Luna gets instant feedback
        this.hubClient.sendProgress(taskId, {
          percentage: 0,
          message: `会话 [${name}] 已成功创建，开始逐步执行（共 ${steps.length} 步）`,
          currentStep: steps[0]?.title,
          stepIndex: 1,
          totalSteps: steps.length,
        });
        break;
      }

      case 'query_session_progress': {
        const sessionId = (parameters.sessionId as string) || '';
        let session = sessionId
          ? this.sessionManager.getSnapshot(sessionId)
          : undefined;

        // Fallback: search by taskId if sessionId wasn't matched
        if (!session && sessionId) {
          session = this.sessionManager.getSessionByTaskId(sessionId);
        }

        if (!session) {
          this.hubClient.sendCompleted(taskId, {
            ok: false,
            message: `未找到指定会话: ${sessionId}`,
          });
          return;
        }

        const currentStep = session.steps[session.currentStepIndex];
        this.hubClient.sendCompleted(taskId, {
          ok: true,
          sessionId: session.id,
          name: session.name,
          status: session.status,
          progress: `${session.progress}%`,
          currentStep: currentStep
            ? `[步骤 ${session.currentStepIndex + 1}/${session.totalSteps}] ${currentStep.title}`
            : '已结束',
          currentStepMessage: currentStep?.message,
          steps: session.steps.map((s, idx) => ({
            index: idx + 1,
            title: s.title,
            status: s.status,
            progress: `${s.progress}%`,
            message: s.message,
          })),
          createdAt: new Date(session.createdAt).toLocaleTimeString(),
          completedAt: session.completedAt
            ? new Date(session.completedAt).toLocaleTimeString()
            : null,
        });
        break;
      }

      case 'list_sessions': {
        const status = (parameters.status as any) || 'all';
        const limit = Number(parameters.limit) || 20;
        const list = this.sessionManager.listSessions({ status, limit });

        this.hubClient.sendCompleted(taskId, {
          ok: true,
          total: list.length,
          sessions: list.map((s) => ({
            sessionId: s.id,
            name: s.name,
            status: s.status,
            progress: `${s.progress}%`,
            currentStep: `${s.currentStepIndex + 1}/${s.totalSteps}`,
            createdAt: new Date(s.createdAt).toLocaleTimeString(),
          })),
        });
        break;
      }

      case 'cancel_session': {
        const sessionId = parameters.sessionId as string;
        const reason = (parameters.reason as string) || '由 Muse 用户请求取消';

        if (!sessionId) {
          this.hubClient.sendFailed(taskId, '参数缺失: 需要提供 sessionId');
          return;
        }

        const success = this.sessionManager.cancelSession(sessionId, reason);
        this.hubClient.sendCompleted(taskId, {
          ok: success,
          message: success
            ? `会话 ${sessionId} 已成功取消`
            : `会话 ${sessionId} 不存在或已处于终态`,
          sessionId,
        });
        break;
      }

      case 'send_pet_bubble': {
        const message = (parameters.message as string) || '你好！';
        const eventType = (parameters.type as any) || 'notification';

        const sent = this.hubClient.sendProactiveEvent(message, eventType);
        this.hubClient.sendCompleted(taskId, {
          ok: sent,
          message: `气泡消息已发送: ${message}`,
        });
        break;
      }

      default: {
        this.hubClient.sendFailed(taskId, `不支持的工具 ID: ${toolId}`);
        break;
      }
    }
  }
}
