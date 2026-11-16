import { MuseHubClient } from './hub-client';
import { ToolRouter } from './router';
import { SessionManager } from './session-manager';
import { SESSION_MANAGER_TOOLS, buildPipelineSteps } from './tools';
import type { SessionManagerConfig } from './types';

export * from './types';
export * from './hub-client';
export * from './session-manager';
export * from './tools';
export * from './router';

export async function createAndStartService(options: SessionManagerConfig = {}) {
  const hubClient = new MuseHubClient(options);
  const sessionManager = new SessionManager(hubClient);
  const router = new ToolRouter(sessionManager, hubClient);

  console.log('🚀 正在启动 Muse 会话与任务管理服务...');
  console.log(`📡 目标 Muse Local Agent Hub: ${options.hubHttpUrl || 'http://127.0.0.1:19840'}`);
  console.log(`🆔 App ID: ${options.appId || 'com.muse.session-manager'}`);

  hubClient.on('registered', (data) => {
    console.log(`✅ 成功向 Muse Hub 注册！Session Token: ${data.sessionToken.substring(0, 16)}...`);
  });

  hubClient.on('connected', () => {
    console.log('🔌 WebSocket 已连接至 Muse Local Agent Hub 事件总线');
    console.log(`🛠️ 已注册 ${SESSION_MANAGER_TOOLS.length} 个工具，可在 Muse 对话中随时调用：`);
    for (const tool of SESSION_MANAGER_TOOLS) {
      console.log(`   - [${tool.riskLevel}] ${tool.toolId}: ${tool.name} (${tool.description})`);
    }
  });

  hubClient.on('disconnected', ({ code, reason }) => {
    console.log(`⚠️ 与 Muse Hub WebSocket 断开连接 (code: ${code}, reason: ${reason || 'none'})，将尝试重连...`);
  });

  hubClient.on('error', (err) => {
    console.error(`❌ Muse Hub Client 错误:`, err.message || err);
  });

  sessionManager.on('step_progress', ({ sessionId, step, overallProgress }) => {
    console.log(
      `📊 [会话进度] ${sessionId} | 整体进度: ${overallProgress}% | 步骤: ${step.title} (${step.progress}%) - ${step.message || ''}`
    );
  });

  sessionManager.on('session_completed', (session) => {
    console.log(`🎉 [会话完成] ${session.id} (${session.name}) 全部步骤已完成！`);
  });

  sessionManager.on('session_failed', (session) => {
    console.error(`❌ [会话失败] ${session.id} (${session.name}) 执行出错: ${session.error}`);
  });

  sessionManager.on('session_cancelled', (session) => {
    console.warn(`🛑 [会话取消] ${session.id} (${session.name}) 已取消`);
  });

  return { hubClient, sessionManager, router };
}

// CLI entrypoint
if (import.meta.main || process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  const args = process.argv.slice(2);
  const isDemo = args.includes('--demo');
  const hubUrl = process.env.MUSE_HUB_URL || 'http://127.0.0.1:19840';
  const hubWsUrl = process.env.MUSE_HUB_WS_URL || 'ws://127.0.0.1:19840/ws';
  const secret = process.env.MUSE_HUB_SECRET || 'muse-session-secret-2026';

  createAndStartService({
    hubHttpUrl: hubUrl,
    hubWsUrl: hubWsUrl,
    secret,
  })
    .then(async ({ hubClient, sessionManager }) => {
      try {
        await hubClient.start(SESSION_MANAGER_TOOLS);
        console.log('✨ 服务已就绪，正在监听来自 Muse / Luna 的任务分派...');

        if (isDemo) {
          console.log('\n--- 正在运行本地演示任务 ---');
          const demoSession = sessionManager.createSession({
            name: '演示工作流: 代码与静态质量多维分析',
            steps: buildPipelineSteps('code_inspection', 4, 1000),
            autoStart: true,
          });
          console.log(`已创建演示会话: ${demoSession.id}`);
        }
      } catch (err: any) {
        console.warn(`⚠️ 无法连接至 Muse Hub (${err.message})。`);
        console.warn('💡 提示：如果 Muse Pet 尚未启动，服务将在后台静默等待并支持离线会话管理。');
      }

      const shutdown = async () => {
        console.log('\n🛑 正在停止 Muse 会话管理服务...');
        await hubClient.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err) => {
      console.error('Fatal error during startup:', err);
      process.exit(1);
    });
}
