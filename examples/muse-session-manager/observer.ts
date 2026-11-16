import type { MuseHubClient } from './hub-client';
import type { RealSession, RealSessionSource } from './thinkrail-reader';

export class ThinkRailObserver {
  private previous: Map<string, string> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private polling = false;

  constructor(
    private reader: RealSessionSource,
    private hub: MuseHubClient,
    private intervalMs = 5000,
    private reportError: (error: unknown) => void = () => {},
  ) {}

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      if (!this.hub.isConnected()) {
        this.previous = undefined;
        return;
      }
      const { sessions } = await this.reader.list({ limit: 100 });
      if (!this.hub.isConnected()) {
        this.previous = undefined;
        return;
      }
      const next = new Map<string, string>();
      for (const session of sessions) {
        const signature = JSON.stringify([session.status, session.completionId, session.state.runId, session.planProgress, session.currentTasks]);
        next.set(session.sessionId, signature);
        if (!this.previous || this.previous.get(session.sessionId) === signature) continue;
        this.hub.sendProactiveEvent(this.message(session), 'notification', {
          source: 'thinkrail',
          sessionId: session.sessionId,
          status: session.status,
          planProgress: session.planProgress,
        });
      }
      this.previous = next;
    } catch (error) {
      this.previous = undefined;
      this.reportError(error);
    } finally {
      this.polling = false;
    }
  }

  private message(session: RealSession) {
    const progress = session.planProgress.percentage;
    return `ThinkRail「${session.name}」状态: ${session.status}；${progress === null ? '尚无任务计划' : `计划进度 ${session.planProgress.done}/${session.planProgress.total} (${progress}%)`}${session.currentTasks.length ? `；当前任务: ${session.currentTasks.map((task) => task.title).join('、')}` : ''}`.slice(0, 1000);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      await this.poll();
      if (this.running) this.timer = setTimeout(tick, this.intervalMs);
    };
    void tick();
  }

  stop() {
    this.running = false;
    this.previous = undefined;
    if (this.timer) clearTimeout(this.timer);
  }
}
