import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTree } from "jsonc-parser";
import {
	deleteCustomOpenAiProvider,
	isCustomOpenAiProviderNode,
	listCustomOpenAiProviders,
	probeCustomOpenAiModels,
	sanitizeProviderId,
	saveCustomOpenAiProvider,
	setCustomProviderPublisher,
} from "./customOpenAi";
import { configurePiRuntime } from "./piRuntime";

let directory: string;
let modelsFile: string;
let priorAgentDir: string | undefined;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "thinkrail-custom-openai-"));
	modelsFile = join(directory, "models.json");
	priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = directory;
});

afterEach(() => {
	setCustomProviderPublisher(null);
	configurePiRuntime(null);
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	rmSync(directory, { recursive: true, force: true });
});

describe("customOpenAi helpers", () => {
	test("sanitizeProviderId formats IDs correctly", () => {
		expect(sanitizeProviderId("DeepSeek V3")).toBe("deepseek-v3");
		expect(sanitizeProviderId(" My_Custom-API ")).toBe("my_custom-api");
		expect(sanitizeProviderId("foo@bar#baz")).toBe("foo-bar-baz");
	});

	test("isCustomOpenAiProviderNode checks baseUrl property", () => {
		expect(isCustomOpenAiProviderNode(undefined)).toBe(false);
		const parsed = parseTree('{"baseUrl": "https://api.openai.com/v1"}');
		expect(isCustomOpenAiProviderNode(parsed)).toBe(true);
		const nonCustom = parseTree('{"name": "test"}');
		expect(isCustomOpenAiProviderNode(nonCustom)).toBe(false);
	});
});

describe("customOpenAi CRUD", () => {
	test("listCustomOpenAiProviders returns empty when file is missing", () => {
		expect(listCustomOpenAiProviders()).toEqual([]);
	});

	test("saveCustomOpenAiProvider writes new provider and masks apiKey in list", async () => {
		let published = false;
		setCustomProviderPublisher(() => {
			published = true;
		});

		const result = await saveCustomOpenAiProvider({
			id: "deepseek",
			name: "DeepSeek",
			baseUrl: "https://api.deepseek.com/v1",
			apiKey: "sk-secret-123",
			api: "openai-completions",
			models: [
				{
					id: "deepseek-chat",
					name: "DeepSeek V3",
					contextWindow: 64000,
					maxTokens: 8192,
					reasoning: false,
					input: ["text"],
				},
				{
					id: "deepseek-reasoner",
					name: "DeepSeek R1",
					reasoning: true,
				},
			],
		});

		expect(result.providerId).toBe("deepseek");
		expect(published).toBe(true);

		const savedRaw = JSON.parse(readFileSync(modelsFile, "utf8"));
		expect(savedRaw.providers.deepseek.apiKey).toBe("sk-secret-123");
		expect(savedRaw.providers.deepseek.baseUrl).toBe("https://api.deepseek.com/v1");
		expect(savedRaw.providers.deepseek.models.length).toBe(2);

		const summaries = listCustomOpenAiProviders();
		expect(summaries.length).toBe(1);
		expect(summaries[0].id).toBe("deepseek");
		expect(summaries[0].name).toBe("DeepSeek");
		expect(summaries[0].hasApiKey).toBe(true);
		expect(summaries[0].models[0].id).toBe("deepseek-chat");
		expect(summaries[0].models[1].id).toBe("deepseek-reasoner");
	});

	test("saving without apiKey preserves existing apiKey in models.json", async () => {
		await saveCustomOpenAiProvider({
			id: "moonshot",
			name: "Moonshot",
			baseUrl: "https://api.moonshot.cn/v1",
			apiKey: "sk-moonshot-original",
			models: [{ id: "moonshot-v1-8k" }],
		});

		// Update without apiKey
		await saveCustomOpenAiProvider({
			id: "moonshot",
			name: "Moonshot AI",
			baseUrl: "https://api.moonshot.cn/v1",
			models: [{ id: "moonshot-v1-8k" }, { id: "moonshot-v1-32k" }],
		});

		const savedRaw = JSON.parse(readFileSync(modelsFile, "utf8"));
		expect(savedRaw.providers.moonshot.name).toBe("Moonshot AI");
		expect(savedRaw.providers.moonshot.apiKey).toBe("sk-moonshot-original");
		expect(savedRaw.providers.moonshot.models.length).toBe(2);
	});

	test("deleteCustomOpenAiProvider removes provider from models.json", async () => {
		await saveCustomOpenAiProvider({
			id: "temp-provider",
			name: "Temp",
			baseUrl: "https://api.temp.com/v1",
			models: [{ id: "m1" }],
		});

		expect(listCustomOpenAiProviders().length).toBe(1);

		let published = false;
		setCustomProviderPublisher(() => {
			published = true;
		});

		await deleteCustomOpenAiProvider("temp-provider");

		expect(published).toBe(true);
		expect(listCustomOpenAiProviders().length).toBe(0);
	});
});

describe("probeCustomOpenAiModels", () => {
	test("probes models from remote /models endpoint", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			expect(url).toBe("https://api.example.com/v1/models");
			expect((init?.headers as Record<string, string>)?.authorization).toBe("Bearer test-key");
			return new Response(
				JSON.stringify({
					data: [{ id: "model-b" }, { id: "model-a" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}) as typeof fetch;

		try {
			const res = await probeCustomOpenAiModels("https://api.example.com/v1/", "test-key");
			expect(res.models).toEqual(["model-a", "model-b"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
