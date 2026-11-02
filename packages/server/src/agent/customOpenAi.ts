import type {
	CustomModelConfig,
	CustomOpenAiProviderInput,
	CustomOpenAiProviderSummary,
} from "@thinkrail/contracts";
import { applyEdits, findNodeAtLocation, modify, type Node, parseTree } from "jsonc-parser";
import {
	EMPTY_CONFIG,
	FORMATTING,
	modelsPath,
	PARSE,
	parseConfig,
	readSource,
	writeModelsFile,
} from "./modelContext";
import {
	activatePiRuntimeGeneration,
	getPiRuntimeGeneration,
	preparePiRuntimeGeneration,
} from "./piRuntime";

let publishCustomChange: (() => void) | null = null;

export function setCustomProviderPublisher(publisher: (() => void) | null): void {
	publishCustomChange = publisher;
}

export function sanitizeProviderId(id: string): string {
	return id
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "-");
}

export function isCustomOpenAiProviderNode(node: Node | undefined): boolean {
	if (node?.type !== "object") return false;
	const baseUrlNode = findNodeAtLocation(node, ["baseUrl"]);
	return baseUrlNode?.type === "string" && baseUrlNode.value.length > 0;
}

export function listCustomOpenAiProviders(): CustomOpenAiProviderSummary[] {
	const source = readSource(modelsPath());
	const root = parseConfig(source);
	if (!root) return [];
	const providersNode = findNodeAtLocation(root, ["providers"]);
	if (providersNode?.type !== "object" || !providersNode.children) return [];

	const result: CustomOpenAiProviderSummary[] = [];

	for (const propNode of providersNode.children) {
		if (propNode.type !== "property" || propNode.children?.length !== 2) continue;
		const id = propNode.children[0].value;
		const valNode = propNode.children[1];
		if (!isCustomOpenAiProviderNode(valNode)) continue;

		const nameNode = findNodeAtLocation(valNode, ["name"]);
		const baseUrlNode = findNodeAtLocation(valNode, ["baseUrl"]);
		const apiNode = findNodeAtLocation(valNode, ["api"]);
		const apiKeyNode = findNodeAtLocation(valNode, ["apiKey"]);
		const modelsNode = findNodeAtLocation(valNode, ["models"]);

		const models: CustomModelConfig[] = [];
		if (modelsNode?.type === "array" && modelsNode.children) {
			for (const mNode of modelsNode.children) {
				if (mNode.type !== "object") continue;
				const mId = findNodeAtLocation(mNode, ["id"])?.value;
				if (typeof mId !== "string" || !mId) continue;
				const mName = findNodeAtLocation(mNode, ["name"])?.value;
				const contextWindow = findNodeAtLocation(mNode, ["contextWindow"])?.value;
				const maxTokens = findNodeAtLocation(mNode, ["maxTokens"])?.value;
				const reasoning = findNodeAtLocation(mNode, ["reasoning"])?.value;
				const inputNode = findNodeAtLocation(mNode, ["input"]);
				const input =
					inputNode?.type === "array"
						? (inputNode.children?.map((c) => c.value).filter(Boolean) as ("text" | "image")[])
						: undefined;

				models.push({
					id: mId,
					...(typeof mName === "string" ? { name: mName } : {}),
					...(typeof contextWindow === "number" ? { contextWindow } : {}),
					...(typeof maxTokens === "number" ? { maxTokens } : {}),
					...(typeof reasoning === "boolean" ? { reasoning } : {}),
					...(input ? { input } : {}),
				});
			}
		}

		result.push({
			id,
			name: typeof nameNode?.value === "string" ? nameNode.value : id,
			baseUrl: typeof baseUrlNode?.value === "string" ? baseUrlNode.value : "",
			api: apiNode?.value === "openai-responses" ? "openai-responses" : "openai-completions",
			hasApiKey: typeof apiKeyNode?.value === "string" && apiKeyNode.value.length > 0,
			models,
		});
	}

	return result;
}

export async function saveCustomOpenAiProvider(
	input: CustomOpenAiProviderInput,
): Promise<{ providerId: string }> {
	const id = sanitizeProviderId(input.id);
	if (!id) throw new Error("Provider ID must be non-empty and alphanumeric.");
	const name = input.name.trim();
	if (!name) throw new Error("Provider name is required.");
	const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(baseUrl)) {
		throw new Error("Base URL must start with http:// or https://");
	}
	if (!input.models || input.models.length === 0) {
		throw new Error("At least one model must be configured for this provider.");
	}

	const path = modelsPath();
	const source = readSource(path);
	const bom = source?.startsWith("﻿") ? "﻿" : "";
	let currentText = source === undefined ? EMPTY_CONFIG : source.slice(bom.length);

	let apiKeyToSave = input.apiKey?.trim();
	if (!apiKeyToSave && source) {
		const root = parseTree(source.replace(/^﻿/, ""), [], PARSE);
		const existingKey = root && findNodeAtLocation(root, ["providers", id, "apiKey"])?.value;
		if (typeof existingKey === "string" && existingKey.length > 0) {
			apiKeyToSave = existingKey;
		}
	}

	const providerEntry = {
		name,
		baseUrl,
		...(apiKeyToSave ? { apiKey: apiKeyToSave } : {}),
		api: input.api === "openai-responses" ? "openai-responses" : "openai-completions",
		models: input.models.map((m) => {
			const mId = m.id.trim();
			if (!mId) throw new Error("Model ID cannot be empty.");
			return {
				id: mId,
				name: m.name?.trim() || mId,
				...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
				...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
				...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
				...(Array.isArray(m.input) ? { input: m.input } : {}),
			};
		}),
	};

	currentText = applyEdits(
		currentText,
		modify(currentText, ["providers", id], providerEntry, FORMATTING),
	);

	writeModelsFile(path, bom + currentText);

	const currentGen = await getPiRuntimeGeneration();
	const prepared = await preparePiRuntimeGeneration(currentGen.additionalExtensionPaths);
	if (prepared.outcome === "prepared") {
		activatePiRuntimeGeneration(prepared.generation);
	}

	publishCustomChange?.();

	return { providerId: id };
}

export async function deleteCustomOpenAiProvider(providerId: string): Promise<void> {
	const id = sanitizeProviderId(providerId);
	const path = modelsPath();
	const source = readSource(path);
	if (!source) return;

	const bom = source.startsWith("﻿") ? "﻿" : "";
	let currentText = source.slice(bom.length);

	currentText = applyEdits(
		currentText,
		modify(currentText, ["providers", id], undefined, FORMATTING),
	);

	writeModelsFile(path, bom + currentText);

	const currentGen = await getPiRuntimeGeneration();
	const prepared = await preparePiRuntimeGeneration(currentGen.additionalExtensionPaths);
	if (prepared.outcome === "prepared") {
		activatePiRuntimeGeneration(prepared.generation);
	}

	publishCustomChange?.();
}

export async function probeCustomOpenAiModels(
	baseUrl: string,
	apiKey?: string,
): Promise<{ models: string[] }> {
	const cleanBase = baseUrl.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(cleanBase)) {
		throw new Error("Base URL must start with http:// or https://");
	}

	const url = `${cleanBase}/models`;
	const headers: Record<string, string> = {};
	if (apiKey && apiKey.trim().length > 0) {
		headers.authorization = `Bearer ${apiKey.trim()}`;
	}

	const signal = AbortSignal.timeout(5000);
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		throw new Error(`Probe failed with status ${response.status} (${response.statusText})`);
	}

	const body = (await response.json()) as {
		data?: unknown;
		models?: unknown;
	};

	const list = Array.isArray(body?.data)
		? body.data
		: Array.isArray(body)
			? body
			: Array.isArray(body?.models)
				? body.models
				: [];

	const ids = new Set<string>();
	for (const item of list) {
		if (typeof item === "string" && item.length > 0) {
			ids.add(item);
		} else if (
			item &&
			typeof item === "object" &&
			"id" in item &&
			typeof (item as { id: unknown }).id === "string"
		) {
			const idStr = (item as { id: string }).id;
			if (idStr.length > 0) ids.add(idStr);
		}
	}

	return { models: [...ids].sort((a, b) => a.localeCompare(b)) };
}
