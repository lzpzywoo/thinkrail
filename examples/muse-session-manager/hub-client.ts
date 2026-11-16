import EventEmitter from 'node:events';
import type {
  AppManifest,
  HubHeartbeatResponse,
  HubRegisterResponse,
  IncomingHubMessage,
  SessionManagerConfig,
  ToolDefinition,
  WsProactiveEventMessage,
  WsTaskCancelledMessage,
  WsTaskCompletedMessage,
  WsTaskDispatchedMessage,
  WsTaskFailedMessage,
  WsTaskProgressMessage,
} from './types';

export class MuseHubClient extends EventEmitter {
  private config: Required<SessionManagerConfig>;
  private sessionToken: string | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private isRunning = false;
  private registeredTools: ToolDefinition[] = [];
  private activeTasksCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: SessionManagerConfig = {}) {
    super();
    this.config = {
      hubHttpUrl: config.hubHttpUrl || 'http://127.0.0.1:19840',
      hubWsUrl: config.hubWsUrl || 'ws://127.0.0.1:19840/ws',
      appId: config.appId || 'thinkrail.session-manager',
      appName: config.appName || 'ThinkRail 会话与任务管理器',
      appVersion: config.appVersion || '1.1.0',
      keywords: config.keywords ?? ['thinkrail', 'session', '会话', '任务', '工作区', 'pi'],
      thinkrailWsUrl: config.thinkrailWsUrl ?? 'ws://127.0.0.1:24242/ws',
      observationIntervalMs: config.observationIntervalMs ?? 5000,
      appDescription:
        config.appDescription ||
        '查询 ThinkRail 真实项目、工作区、会话、Agent运行状态与任务计划进度，并推送桌面宠物通知。用户询问ThinkRail在跑什么任务、有哪些会话、当前进度时使用。',
      secret: config.secret || 'muse-session-manager-secret-2026',
      heartbeatIntervalMs: config.heartbeatIntervalMs || 20000,
      reconnectIntervalMs: config.reconnectIntervalMs || 3000,
    };
  }

  public getSessionToken(): string | null {
    return this.sessionToken;
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  public setActiveTasksCount(count: number): void {
    this.activeTasksCount = count;
  }

  /**
   * Register tools and metadata with Muse Local Agent Hub HTTP API
   */
  public async register(tools: ToolDefinition[]): Promise<HubRegisterResponse> {
    this.registeredTools = tools;
    const manifest: AppManifest = {
      appId: this.config.appId,
      name: this.config.appName,
      version: this.config.appVersion,
      description: this.config.appDescription,
      secret: this.config.secret,
      tools,
      keywords: this.config.keywords,
    };

    const registerUrl = `${this.config.hubHttpUrl}/api/v1/register`;
    try {
      const response = await fetch(registerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(manifest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Hub registration failed (${response.status}): ${errorText}`
        );
      }

      const resJson = (await response.json()) as HubRegisterResponse;
      if (resJson.ok && resJson.data?.sessionToken) {
        this.sessionToken = resJson.data.sessionToken;
        this.emit('registered', resJson.data);
      } else {
        throw new Error(resJson.error || 'Unknown error during registration');
      }

      return resJson;
    } catch (err) {
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Connect to Hub's WebSocket event bus
   */
  public connectWs(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    return new Promise((resolve, reject) => {
      const wsUrl = `${this.config.hubWsUrl}?appId=${encodeURIComponent(
        this.config.appId
      )}&secret=${encodeURIComponent(this.config.secret)}`;

      try {
        const ws = new WebSocket(wsUrl);
        this.ws = ws;

        ws.onopen = () => {
          this.emit('connected');
          this.startHeartbeat();
          resolve();
        };

        ws.onmessage = (event: MessageEvent) => {
          try {
            const rawData =
              typeof event.data === 'string'
                ? event.data
                : event.data.toString();
            const message = JSON.parse(rawData) as IncomingHubMessage;
            this.handleIncomingMessage(message);
          } catch (err) {
            this.emit('error', new Error(`Failed to parse WS message: ${err}`));
          }
        };

        ws.onerror = (err) => {
          this.emit('ws_error', err);
        };

        ws.onclose = (event: CloseEvent) => {
          this.emit('disconnected', { code: event.code, reason: event.reason });
          this.stopHeartbeat();
          this.ws = null;
          if (this.isRunning) {
            this.scheduleReconnect();
          }
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleIncomingMessage(message: IncomingHubMessage): void {
    switch (message.type) {
      case 'task.dispatched':
        this.emit('task.dispatched', message as WsTaskDispatchedMessage);
        break;
      case 'task.cancelled':
        this.emit('task.cancelled', message as WsTaskCancelledMessage);
        break;
      case 'task.approval_required':
        this.emit('task.approval_required', message);
        break;
      default:
        this.emit('message', message);
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.isRunning) return;
      try {
        await this.register(this.registeredTools);
        await this.connectWs();
      } catch {
        this.scheduleReconnect();
      }
    }, this.config.reconnectIntervalMs);
  }

  /**
   * Start periodic heartbeat to Muse Hub
   */
  public startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.config.heartbeatIntervalMs);
  }

  public stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  public async sendHeartbeat(): Promise<boolean> {
    if (!this.sessionToken) return false;
    const heartbeatUrl = `${this.config.hubHttpUrl}/api/v1/heartbeat`;

    try {
      const response = await fetch(heartbeatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.sessionToken}`,
          'X-App-Id': this.config.appId,
        },
        body: JSON.stringify({
          status: 'active',
          activeTasks: this.activeTasksCount,
        }),
      });

      if (!response.ok) {
        return false;
      }

      const resJson = (await response.json()) as HubHeartbeatResponse;
      return !!resJson.ok && !!resJson.data?.online;
    } catch {
      return false;
    }
  }

  /**
   * Send real-time task progress back to Muse Hub
   */
  public sendProgress(
    taskId: string,
    payload: {
      percentage: number;
      message: string;
      currentStep?: string;
      stepIndex?: number;
      totalSteps?: number;
    }
  ): boolean {
    if (!this.isConnected()) return false;

    const frame: WsTaskProgressMessage = {
      type: 'task.progress',
      taskId,
      payload: {
        percentage: Math.min(100, Math.max(0, Math.round(payload.percentage))),
        message: payload.message,
        currentStep: payload.currentStep,
        stepIndex: payload.stepIndex,
        totalSteps: payload.totalSteps,
      },
    };

    this.ws?.send(JSON.stringify(frame));
    return true;
  }

  /**
   * Send task completed event with result back to Muse Hub
   */
  public sendCompleted(taskId: string, result: unknown): boolean {
    if (!this.isConnected()) return false;

    const frame: WsTaskCompletedMessage = {
      type: 'task.completed',
      taskId,
      payload: { result },
    };

    this.ws?.send(JSON.stringify(frame));
    return true;
  }

  /**
   * Send task failed event back to Muse Hub
   */
  public sendFailed(taskId: string, error: string, details?: unknown): boolean {
    if (!this.isConnected()) return false;

    const frame: WsTaskFailedMessage = {
      type: 'task.failed',
      taskId,
      payload: { error, details },
    };

    this.ws?.send(JSON.stringify(frame));
    return true;
  }

  /**
   * Send proactive pet bubble event to Muse desktop companion
   */
  public sendProactiveEvent(
    message: string,
    type: 'task.completed' | 'task.progress' | 'notification' | 'alert' = 'task.completed',
    metadata?: Record<string, unknown>
  ): boolean {
    if (!this.isConnected()) return false;

    const frame: WsProactiveEventMessage = {
      type: 'event',
      payload: {
        type,
        message,
        metadata,
      },
    };

    this.ws?.send(JSON.stringify(frame));
    return true;
  }

  /**
   * Start the client lifecycle: register tools, open WS connection, and enable heartbeat
   */
  public async start(tools: ToolDefinition[]): Promise<void> {
    this.isRunning = true;
    await this.register(tools);
    await this.connectWs();
  }

  /**
   * Disconnect and shutdown cleanly
   */
  public async stop(): Promise<void> {
    this.isRunning = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.sessionToken) {
      try {
        await fetch(
          `${this.config.hubHttpUrl}/api/v1/register/${encodeURIComponent(
            this.config.appId
          )}`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Bearer ${this.sessionToken}`,
              'X-App-Id': this.config.appId,
            },
          }
        );
      } catch {
        // Ignore unregister errors during shutdown
      }
      this.sessionToken = null;
    }
  }
}
