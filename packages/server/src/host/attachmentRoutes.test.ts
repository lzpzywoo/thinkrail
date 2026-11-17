import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ATTACHMENT_UPLOAD_HEADER,
	ATTACHMENTS_ROUTE,
	type UploadedAttachmentResult,
} from "@thinkrail/contracts";
import { WORKSPACE_ATTACHMENTS_DIR } from "@thinkrail/shared/paths";
import { saveWorkspaces } from "../persistence";
import { serveAttachmentUpload } from "./attachmentRoutes";

const saved = {
	THINKRAIL_DATA_DIR: process.env.THINKRAIL_DATA_DIR,
};
const UPLOAD_HEADER = { [ATTACHMENT_UPLOAD_HEADER.name]: ATTACHMENT_UPLOAD_HEADER.value };
let tempDir: string;
let repoDir: string;
const wsId = "test-ws-1";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "thinkrail-attach-test-"));
	process.env.THINKRAIL_DATA_DIR = join(tempDir, "data");
	repoDir = join(tempDir, "repo");
	mkdirSync(repoDir, { recursive: true });
	saveWorkspaces([
		{
			id: wsId,
			projectId: "proj-1",
			name: "Test Workspace",
			kind: "chat",
			worktreePath: repoDir,
			createdAt: Date.now(),
		},
	]);
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function upload(
	pathname: string,
	body: BodyInit | null,
	headers: Record<string, string> = UPLOAD_HEADER,
	method = "PUT",
): Promise<Response> {
	return serveAttachmentUpload(
		new Request(`http://127.0.0.1${pathname}`, {
			method,
			...(body !== null ? { body } : {}),
			headers,
		}),
		pathname,
	);
}

test("an upload without the header is forbidden with 403", async () => {
	const res = await upload(`${ATTACHMENTS_ROUTE}${wsId}/doc.txt`, "hello", {});
	expect(res.status).toBe(403);
});

test("a non-PUT request is rejected with 405", async () => {
	const res = await upload(`${ATTACHMENTS_ROUTE}${wsId}/doc.txt`, null, UPLOAD_HEADER, "GET");
	expect(res.status).toBe(405);
});

test("an invalid path or missing segments returns 400", async () => {
	expect((await upload(`${ATTACHMENTS_ROUTE}${wsId}`, "hello")).status).toBe(400);
	expect((await upload(`${ATTACHMENTS_ROUTE}${wsId}/`, "hello")).status).toBe(400);
	expect((await upload(`${ATTACHMENTS_ROUTE}unknown/`, "hello")).status).toBe(400);
});

test("an unknown workspace returns 404", async () => {
	const res = await upload(`${ATTACHMENTS_ROUTE}nonexistent/doc.txt`, "hello");
	expect(res.status).toBe(404);
});

test("invalid filenames like dot, dotdot or device names return 400", async () => {
	expect((await upload(`${ATTACHMENTS_ROUTE}${wsId}/.`, "hello")).status).toBe(400);
	expect((await upload(`${ATTACHMENTS_ROUTE}${wsId}/..`, "hello")).status).toBe(400);
	expect((await upload(`${ATTACHMENTS_ROUTE}${wsId}/NUL`, "hello")).status).toBe(400);
	expect((await upload(`${ATTACHMENTS_ROUTE}${wsId}/CON.txt`, "hello")).status).toBe(400);
});

test("a valid file is stored under .thinkrail/context/attachments/ and returns metadata", async () => {
	const content = "File content here";
	const res = await upload(`${ATTACHMENTS_ROUTE}${wsId}/sample.pdf`, content);
	expect(res.status).toBe(200);

	const json = (await res.json()) as UploadedAttachmentResult;
	expect(json.workspaceId).toBe(wsId);
	expect(json.fileName).toBe("sample.pdf");
	expect(json.path).toBe(`${WORKSPACE_ATTACHMENTS_DIR}/sample.pdf`);
	expect(json.size).toBe(content.length);

	const filePath = join(repoDir, WORKSPACE_ATTACHMENTS_DIR, "sample.pdf");
	expect(existsSync(filePath)).toBe(true);
	expect(readFileSync(filePath, "utf-8")).toBe(content);
});

test("collision generates a unique suffix", async () => {
	const res1 = await upload(`${ATTACHMENTS_ROUTE}${wsId}/note.txt`, "first");
	expect(res1.status).toBe(200);
	const json1 = (await res1.json()) as UploadedAttachmentResult;
	expect(json1.fileName).toBe("note.txt");

	const res2 = await upload(`${ATTACHMENTS_ROUTE}${wsId}/note.txt`, "second");
	expect(res2.status).toBe(200);
	const json2 = (await res2.json()) as UploadedAttachmentResult;
	expect(json2.fileName).toBe("note-1.txt");
	expect(json2.path).toBe(`${WORKSPACE_ATTACHMENTS_DIR}/note-1.txt`);

	const filePath1 = join(repoDir, WORKSPACE_ATTACHMENTS_DIR, "note.txt");
	const filePath2 = join(repoDir, WORKSPACE_ATTACHMENTS_DIR, "note-1.txt");
	expect(readFileSync(filePath1, "utf-8")).toBe("first");
	expect(readFileSync(filePath2, "utf-8")).toBe("second");
});

test("rejects when Content-Length header is oversized", async () => {
	const res = await upload(`${ATTACHMENTS_ROUTE}${wsId}/huge.bin`, "data", {
		...UPLOAD_HEADER,
		"Content-Length": String(200 * 1024 * 1024),
	});
	expect(res.status).toBe(413);
});
