import { EXPLORATION_TOOLS } from "./thinkrail-software-exploration";
import type { SessionStepDefinition, ToolDefinition } from "./types";

export { EXPLORATION_TOOLS };

export const SESSION_MANAGER_TOOLS: ToolDefinition[] = [
	{
		toolId: "list_projects",
		name: "查看ThinkRail项目列表",
		description:
			"当用户询问“ThinkRail有哪些项目”“查看ThinkRail项目”“列出项目”时调用本工具。直接读取真实项目目录，返回项目ID、名称、关闭标记和最近打开时间，不扫描会话或TODO。用户只问项目时请使用list_projects。",
		category: "query",
		riskLevel: "read-only",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		toolId: "create_and_run_session",
		name: "创建并执行演示会话任务",
		description:
			"仅创建内存模拟演示流程，用于测试Muse进度反馈；不会执行真实ThinkRail代码检查、下载或数据处理。用户明确要求演示任务时调用。",
		category: "action",
		riskLevel: "write-safe",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "会话或任务的名称（如：数据批量处理、工程代码扫描）",
				},
				taskType: {
					type: "string",
					enum: ["data_pipeline", "code_inspection", "batch_download", "custom"],
					description: "任务类型模板，默认为 data_pipeline",
				},
				stepCount: {
					type: "number",
					description: "执行步骤数量（建议 3-6 步）",
				},
				stepDurationMs: {
					type: "number",
					description: "每步骤模拟耗时毫秒数（默认 1000ms）",
				},
			},
			required: ["name"],
		},
	},
	{
		toolId: "query_session_progress",
		name: "查询会话进度与详情",
		description:
			"当用户询问ThinkRail某个会话的任务进度时，按sessionId、完整会话标题或唯一工作区名称查询真实运行状态与TODO步骤。planProgress是计划完成比例；无计划时百分比为null。source=demo仅查询演示任务。",
		category: "query",
		riskLevel: "read-only",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description:
						"真实ThinkRail会话ID（建议从list_sessions获取）、完整会话标题或唯一工作区名称",
				},
				source: { type: "string", enum: ["thinkrail", "demo"], default: "thinkrail" },
			},
			required: ["sessionId"],
		},
	},
	{
		toolId: "list_sessions",
		name: "查看所有会话列表",
		description:
			"获取ThinkRail当前各项目、工作区的真实会话任务清单与运行状态。当用户询问“ThinkRail在跑什么任务”“有哪些会话”“当前进度”时调用。默认source=thinkrail，source=demo仅返回内存演示任务。recent按工作区最近活动排序。用户仅询问有哪些项目时应使用list_projects，避免扫描会话。",
		category: "query",
		riskLevel: "read-only",
		inputSchema: {
			type: "object",
			properties: {
				status: {
					type: "string",
					enum: [
						"all",
						"active",
						"recent",
						"running",
						"needs_input",
						"idle",
						"completed",
						"failed",
						"cancelled",
						"interrupted",
					],
					description: "状态筛选条件，默认 all",
				},
				limit: {
					type: "number",
					description: "最多返回数量，默认20，最大100",
					minimum: 1,
					maximum: 100,
				},
				source: { type: "string", enum: ["thinkrail", "demo"], default: "thinkrail" },
			},
		},
	},
	{
		toolId: "cancel_session",
		name: "取消或中断会话",
		description:
			"仅取消本服务创建的内存演示会话，不会中断真实ThinkRail会话或Agent。用户要求停止演示任务时调用。",
		category: "action",
		riskLevel: "write-safe",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "要取消的会话 ID",
				},
				reason: {
					type: "string",
					description: "取消原因说明",
				},
			},
			required: ["sessionId"],
		},
	},
	{
		toolId: "send_pet_bubble",
		name: "发送桌面宠物气泡提醒",
		description:
			"直接在 Muse 桌面桌宠头顶弹出对话气泡。当外部长任务结束、报错或有重要进展时调用通知用户。",
		category: "action",
		riskLevel: "write-safe",
		inputSchema: {
			type: "object",
			properties: {
				message: {
					type: "string",
					description: "要展示给用户的气泡文本",
				},
				type: {
					type: "string",
					enum: ["notification", "task.completed", "alert"],
					description: "事件类型，默认为 notification",
				},
			},
			required: ["message"],
		},
	},
];

export const ALL_SESSION_MANAGER_TOOLS: ToolDefinition[] = [
	...EXPLORATION_TOOLS,
	...SESSION_MANAGER_TOOLS,
];

export function buildPipelineSteps(
	taskType: string,
	count = 4,
	stepDurationMs = 800,
): SessionStepDefinition[] {
	if (taskType === "code_inspection") {
		const titles = [
			"拉取项目代码库与分支工作区上下文",
			"执行 TypeScript 严格类型与接口检查",
			"代码规范 (Biome Lint) 与代码味道审计",
			"运行全套自动化测试套件与覆盖率统计",
			"打包前依赖项与资产构建完整性校验",
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
				return { step: idx + 1, title, status: "ok", checkedCount: (idx + 1) * 42 };
			},
		}));
	}

	if (taskType === "batch_download") {
		const titles = [
			"解析下载源地址与建立握手连接",
			"分块拉取数据资源流 (Chunk 1-4)",
			"分块拉取数据资源流 (Chunk 5-8)",
			"完整性哈希校验 (SHA256 Checksum)",
			"解压并部署文件至目标目录",
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

	const defaultTitles = [
		"连接数据源并抽取原始数据集",
		"数据清洗、类型转换与缺失值填充",
		"特征提取与计算聚合指标",
		"数据质量校验与多维度审计",
		"生成最终汇总数据集并持久化",
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
