import type { SessionStepDefinition, ToolDefinition } from './types';

export const SESSION_MANAGER_TOOLS: ToolDefinition[] = [
  {
    toolId: 'create_and_run_session',
    name: '创建并执行会话任务',
    description:
      '创建一个包含多个子步骤的后台长耗时会话任务，执行过程中会实时向 Muse 反馈各步骤进度百分比、日志并在完成时弹出宠物气泡提醒',
    category: 'action',
    riskLevel: 'write-safe',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '会话或任务的名称（如：数据批量处理、工程代码扫描）',
        },
        taskType: {
          type: 'string',
          enum: ['data_pipeline', 'code_inspection', 'batch_download', 'custom'],
          description: '任务类型模板，默认为 data_pipeline',
        },
        stepCount: {
          type: 'number',
          description: '执行步骤数量（建议 3-6 步）',
        },
        stepDurationMs: {
          type: 'number',
          description: '每步骤模拟耗时毫秒数（默认 1000ms）',
        },
      },
      required: ['name'],
    },
  },
  {
    toolId: 'query_session_progress',
    name: '查询会话进度与详情',
    description:
      '根据会话 ID（sessionId）或关联的任务 ID 查询当前会话的最新执行百分比、当前步骤状态以及执行日志',
    category: 'query',
    riskLevel: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '目标会话的 ID（例如：sess_xxxx_yyyy）',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    toolId: 'list_sessions',
    name: '查看所有会话列表',
    description: '获取当前已注册和执行的全部会话清单，可按运行状态筛选',
    category: 'query',
    riskLevel: 'read-only',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['all', 'running', 'completed', 'failed', 'cancelled'],
          description: '状态筛选条件，默认 all',
        },
        limit: {
          type: 'number',
          description: '最多返回数量，默认 20',
        },
      },
    },
  },
  {
    toolId: 'cancel_session',
    name: '取消或中断会话',
    description: '中断并取消正在执行的会话任务，释放执行资源',
    category: 'action',
    riskLevel: 'write-safe',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '要取消的会话 ID',
        },
        reason: {
          type: 'string',
          description: '取消原因说明',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    toolId: 'send_pet_bubble',
    name: '发送桌面宠物气泡提醒',
    description: '直接在 Muse 桌面宠物上方弹出一则气泡提示文字',
    category: 'action',
    riskLevel: 'write-safe',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '要显示的提醒文本内容',
        },
        type: {
          type: 'string',
          enum: ['task.completed', 'notification', 'alert'],
          description: '事件类型',
        },
      },
      required: ['message'],
    },
  },
];

/**
 * Pipeline generator helpers for simulated and real workloads
 */
export function buildPipelineSteps(
  taskType: string = 'data_pipeline',
  stepCount: number = 4,
  stepDurationMs: number = 800
): SessionStepDefinition[] {
  const count = Math.max(2, Math.min(10, stepCount));

  if (taskType === 'code_inspection') {
    const titles = [
      '代码静态语法与规范检查 (Biome/ESLint)',
      '类型系统与模块边界依赖审查 (TypeScript & Seams)',
      '运行核心单元测试与覆盖率统计 (Test Runner)',
      '安全漏洞与第三方依赖合规扫描 (Audit)',
      '生成综合代码质量报告与优化建议',
    ];

    return titles.slice(0, count).map((title, idx) => ({
      id: `step_inspect_${idx + 1}`,
      title,
      weight: 1,
      execute: async (ctx) => {
        const subSteps = 5;
        for (let s = 1; s <= subSteps; s++) {
          if (ctx.isCancelled()) return;
          const pct = Math.round((s / subSteps) * 100);
          ctx.reportProgress(pct, `${title} - 处理中 (${pct}%)...`);
          await new Promise((r) => setTimeout(r, stepDurationMs / subSteps));
        }
        return { step: idx + 1, title, status: 'ok', checkedCount: (idx + 1) * 42 };
      },
    }));
  }

  if (taskType === 'batch_download') {
    const titles = [
      '解析下载源地址与建立握手连接',
      '分块拉取数据资源流 (Chunk 1-4)',
      '分块拉取数据资源流 (Chunk 5-8)',
      '完整性哈希校验 (SHA256 Checksum)',
      '解压并部署文件至目标目录',
    ];

    return titles.slice(0, count).map((title, idx) => ({
      id: `step_dl_${idx + 1}`,
      title,
      weight: 1,
      execute: async (ctx) => {
        const subSteps = 4;
        for (let s = 1; s <= subSteps; s++) {
          if (ctx.isCancelled()) return;
          const pct = Math.round((s / subSteps) * 100);
          ctx.reportProgress(pct, `${title} - 传输速率 12.4 MB/s (${pct}%)...`);
          await new Promise((r) => setTimeout(r, stepDurationMs / subSteps));
        }
        return { step: idx + 1, title, downloadedBytes: (idx + 1) * 1024 * 1024 };
      },
    }));
  }

  // Default: data_pipeline
  const defaultTitles = [
    '连接数据源并抽取原始数据集',
    '数据清洗、类型转换与缺失值填充',
    '特征提取与计算聚合指标',
    '数据质量校验与多维度审计',
    '生成最终汇总数据集并持久化',
  ];

  return defaultTitles.slice(0, count).map((title, idx) => ({
    id: `step_data_${idx + 1}`,
    title,
    weight: 1,
    execute: async (ctx) => {
      const subSteps = 5;
      for (let s = 1; s <= subSteps; s++) {
        if (ctx.isCancelled()) return;
        const pct = Math.round((s / subSteps) * 100);
        ctx.reportProgress(pct, `${title} - 处理批次 ${s}/${subSteps} (${pct}%)`);
        await new Promise((r) => setTimeout(r, stepDurationMs / subSteps));
      }
      return { step: idx + 1, title, recordsProcessed: (idx + 1) * 250 };
    },
  }));
}
