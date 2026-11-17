import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
	ATTACHMENT_UPLOAD_HEADER,
	ATTACHMENTS_ROUTE,
	isWindowsDeviceName,
	type UploadedAttachmentResult,
} from "@thinkrail/contracts";
import { WORKSPACE_ATTACHMENTS_DIR } from "@thinkrail/shared/paths";
import { prepareArtifactsDestination, reconcileArtifacts } from "../artifacts";
import { loadWorkspaces } from "../persistence";

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const UPLOAD_PREFIX = ".upload-";

function plain(status: number, text: string, headers?: Record<string, string>): Response {
	return new Response(text, { status, ...(headers ? { headers } : {}) });
}

function decoded(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

async function writeCapped(
	path: string,
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<{ ok: boolean; size: number }> {
	const file = await open(path, "wx");
	try {
		let size = 0;
		for await (const chunk of body ?? []) {
			size += chunk.byteLength;
			if (size > maxBytes) return { ok: false, size };
			await file.write(chunk);
		}
		return { ok: true, size };
	} finally {
		await file.close();
	}
}

function sanitizeFileName(raw: string): string | null {
	const base = basename(raw).trim();
	if (!base || base === "." || base === ".." || isWindowsDeviceName(base)) return null;
	return base;
}

export async function serveAttachmentUpload(req: Request, pathname: string): Promise<Response> {
	if (req.method !== "PUT") {
		return plain(405, "method not allowed", { Allow: "PUT" });
	}
	if (req.headers.get(ATTACHMENT_UPLOAD_HEADER.name) !== ATTACHMENT_UPLOAD_HEADER.value) {
		return plain(403, "forbidden");
	}

	const remainder = pathname.slice(ATTACHMENTS_ROUTE.length);
	const slash = remainder.indexOf("/");
	if (slash <= 0) return plain(400, "invalid upload path");

	const rawWorkspaceId = remainder.slice(0, slash);
	const rawFileName = remainder.slice(slash + 1);

	const workspaceId = decoded(rawWorkspaceId);
	const fileName = decoded(rawFileName);

	if (!workspaceId || !fileName) return plain(400, "bad workspace or filename encoding");

	const workspace = loadWorkspaces().find((w) => w.id === workspaceId);
	if (!workspace) return plain(404, "workspace not found");

	const sanitized = sanitizeFileName(fileName);
	if (!sanitized) return plain(400, "invalid filename");

	const contentLength = Number(req.headers.get("Content-Length") ?? 0);
	if (contentLength > MAX_ATTACHMENT_BYTES) {
		return plain(413, "payload too large");
	}

	prepareArtifactsDestination(workspaceId, WORKSPACE_ATTACHMENTS_DIR);
	const targetDir = join(workspace.worktreePath, WORKSPACE_ATTACHMENTS_DIR);
	mkdirSync(targetDir, { recursive: true });

	const ext = extname(sanitized);
	const stem = ext ? sanitized.slice(0, -ext.length) : sanitized;
	let finalName = sanitized;
	let counter = 1;
	while (existsSync(join(targetDir, finalName))) {
		finalName = `${stem}-${counter}${ext}`;
		counter++;
	}

	const tempPath = join(targetDir, `${UPLOAD_PREFIX}${randomUUID()}`);
	try {
		const written = await writeCapped(tempPath, req.body, MAX_ATTACHMENT_BYTES);
		if (!written.ok) {
			try {
				rmSync(tempPath, { force: true });
			} catch {}
			return plain(413, "payload too large");
		}
		const finalPath = join(targetDir, finalName);
		renameSync(tempPath, finalPath);

		try {
			reconcileArtifacts(workspaceId);
		} catch {}

		const relPath = `${WORKSPACE_ATTACHMENTS_DIR}/${finalName}`;
		const result: UploadedAttachmentResult = {
			workspaceId,
			path: relPath,
			fileName: finalName,
			size: written.size,
		};
		return Response.json(result, { status: 200 });
	} catch (error) {
		try {
			rmSync(tempPath, { force: true });
		} catch {}
		const message = error instanceof Error ? error.message : "upload error";
		return plain(500, message);
	}
}
