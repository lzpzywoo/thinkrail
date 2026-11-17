import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	ATTACHMENT_UPLOAD_HEADER,
	ATTACHMENTS_ROUTE,
	type UploadedAttachmentResult,
} from "@thinkrail/contracts";
import { uploadAttachment } from "./attachments";
import { initTransport } from "./wireTransport";

describe("uploadAttachment", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		(globalThis as unknown as { location: unknown }).location = new URL("http://localhost:3000");
		initTransport();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("sends PUT request with attachment upload header and returns result", async () => {
		let capturedUrl = "";
		let capturedMethod = "";
		let capturedHeaders: HeadersInit | undefined;
		let capturedBody: unknown;

		const expected: UploadedAttachmentResult = {
			workspaceId: "ws-123",
			path: ".thinkrail/context/attachments/test.txt",
			fileName: "test.txt",
			size: 11,
		};

		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedMethod = init?.method ?? "";
			capturedHeaders = init?.headers;
			capturedBody = init?.body;
			return new Response(JSON.stringify(expected), { status: 200 });
		}) as unknown as typeof fetch;

		const file = new File(["hello world"], "test.txt", { type: "text/plain" });
		const result = await uploadAttachment("ws-123", file);

		expect(capturedUrl).toBe(`http://localhost:3000${ATTACHMENTS_ROUTE}ws-123/test.txt`);
		expect(capturedMethod).toBe("PUT");
		expect((capturedHeaders as Record<string, string>)[ATTACHMENT_UPLOAD_HEADER.name]).toBe(
			ATTACHMENT_UPLOAD_HEADER.value,
		);
		expect(capturedBody).toBe(file);
		expect(result).toEqual(expected);
	});

	it("throws an error when HTTP request fails", async () => {
		globalThis.fetch = (async () => {
			return new Response("payload too large", { status: 413 });
		}) as unknown as typeof fetch;

		const file = new File(["data"], "test.txt");
		await expect(uploadAttachment("ws-123", file)).rejects.toThrow("payload too large");
	});
});
