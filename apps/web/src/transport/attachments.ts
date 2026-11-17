import {
	ATTACHMENT_UPLOAD_HEADER,
	ATTACHMENTS_ROUTE,
	isUploadedAttachmentResult,
	type UploadedAttachmentResult,
} from "@thinkrail/contracts";
import { hostUrl } from "./fonts";

export async function uploadAttachment(
	workspaceId: string,
	file: File,
): Promise<UploadedAttachmentResult> {
	const url = hostUrl(
		`${ATTACHMENTS_ROUTE}${encodeURIComponent(workspaceId)}/${encodeURIComponent(file.name)}`,
	);
	const response = await fetch(url, {
		method: "PUT",
		headers: { [ATTACHMENT_UPLOAD_HEADER.name]: ATTACHMENT_UPLOAD_HEADER.value },
		body: file,
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(text || `attachment upload failed with HTTP ${response.status}`);
	}
	const result: unknown = await response.json().catch(() => null);
	if (isUploadedAttachmentResult(result)) return result;
	throw new Error("invalid attachment upload response");
}
