import {
	THINKRAIL_FILE_DRAG_MIME,
	isThinkRailFileDragData,
	type UploadedAttachmentResult,
} from "@thinkrail/contracts";
import { type ClipboardEvent, type DragEvent, useCallback, useRef, useState } from "react";
import { uploadAttachment } from "../transport";

export interface FileReferenceItem {
	path: string;
	kind?: "dir" | "file" | undefined;
}

export function insertReferencesIntoDraft(
	currentDraft: string,
	caretPosition: number,
	items: FileReferenceItem[],
): { nextDraft: string; nextCaret: number } {
	if (items.length === 0) return { nextDraft: currentDraft, nextCaret: caretPosition };

	const before = currentDraft.slice(0, caretPosition);
	const after = currentDraft.slice(caretPosition);

	const needLeadingSpace = before.length > 0 && !before.endsWith(" ") && !before.endsWith("\n");
	const needTrailingSpace =
		after.length === 0 || (!after.startsWith(" ") && !after.startsWith("\n"));

	const formatted = items
		.map((item) =>
			item.kind === "dir"
				? item.path.endsWith("/")
					? `@${item.path}`
					: `@${item.path}/`
				: `@${item.path}`,
		)
		.join(" ");

	const insert = `${needLeadingSpace ? " " : ""}${formatted}${needTrailingSpace ? " " : ""}`;
	const nextDraft = `${before}${insert}${after}`;
	const nextCaret = before.length + insert.length;

	return { nextDraft, nextCaret };
}

export function hasFilePayload(dt: DataTransfer | null): boolean {
	if (!dt) return false;
	const types = Array.from(dt.types);
	return types.includes("Files") || types.includes(THINKRAIL_FILE_DRAG_MIME);
}

export interface UseComposerDropOptions {
	workspaceId?: string | undefined;
	onInsertReferences: (items: FileReferenceItem[]) => void;
	onAddImages: (files: File[]) => void;
	onUploadError?: ((fileName: string) => void) | undefined;
	uploader?: ((workspaceId: string, file: File) => Promise<UploadedAttachmentResult>) | undefined;
}

export interface UseComposerDropResult {
	isDraggingOver: boolean;
	uploadingFiles: string[];
	onPaste: (e: ClipboardEvent<HTMLElement>) => void;
	dropHandlers: {
		onDragEnter: (e: DragEvent<HTMLElement>) => void;
		onDragOver: (e: DragEvent<HTMLElement>) => void;
		onDragLeave: (e: DragEvent<HTMLElement>) => void;
		onDrop: (e: DragEvent<HTMLElement>) => void;
	};
}

export function useComposerDrop({
	workspaceId,
	onInsertReferences,
	onAddImages,
	onUploadError,
	uploader,
}: UseComposerDropOptions): UseComposerDropResult {
	const [isDraggingOver, setIsDraggingOver] = useState(false);
	const [uploadingFiles, setUploadingFiles] = useState<string[]>([]);
	const dragCounterRef = useRef(0);

	const onDragEnter = useCallback((e: DragEvent<HTMLElement>) => {
		if (!hasFilePayload(e.dataTransfer)) return;
		e.preventDefault();
		dragCounterRef.current += 1;
		setIsDraggingOver(true);
	}, []);

	const onDragOver = useCallback((e: DragEvent<HTMLElement>) => {
		if (!hasFilePayload(e.dataTransfer)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
	}, []);

	const onDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
		if (!hasFilePayload(e.dataTransfer)) return;
		e.preventDefault();
		dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
		if (dragCounterRef.current === 0) {
			setIsDraggingOver(false);
		}
	}, []);

	const onDrop = useCallback(
		async (e: DragEvent<HTMLElement>) => {
			if (!hasFilePayload(e.dataTransfer)) return;
			e.preventDefault();
			e.stopPropagation();
			dragCounterRef.current = 0;
			setIsDraggingOver(false);

			const rawThinkRail = e.dataTransfer.getData(THINKRAIL_FILE_DRAG_MIME);
			if (rawThinkRail) {
				try {
					const data: unknown = JSON.parse(rawThinkRail);
					if (isThinkRailFileDragData(data)) {
						onInsertReferences([{ path: data.path, kind: data.kind }]);
						return;
					}
				} catch {}
			}

			const files = Array.from(e.dataTransfer.files);
			if (files.length === 0) return;

			const imageFiles = files.filter((f) => f.type.startsWith("image/"));
			const otherFiles = files.filter((f) => !f.type.startsWith("image/"));

			if (imageFiles.length > 0) {
				onAddImages(imageFiles);
			}

			if (otherFiles.length > 0) {
				if (!workspaceId) return;
				const uploadFn = uploader ?? uploadAttachment;
				const names = otherFiles.map((f) => f.name);
				setUploadingFiles((prev) => [...prev, ...names]);

				try {
					const settled = await Promise.allSettled(
						otherFiles.map((file) => uploadFn(workspaceId, file)),
					);
					const items: FileReferenceItem[] = [];
					for (let i = 0; i < settled.length; i++) {
						const result = settled[i];
						if (result?.status === "fulfilled") {
							items.push({ path: result.value.path, kind: "file" });
						} else {
							onUploadError?.(otherFiles[i]?.name ?? "file");
						}
					}
					if (items.length > 0) {
						onInsertReferences(items);
					}
				} finally {
					setUploadingFiles((prev) => prev.filter((name) => !names.includes(name)));
				}
			}
		},
		[onAddImages, onInsertReferences, onUploadError, uploader, workspaceId],
	);

	const onPaste = useCallback(
		async (e: ClipboardEvent<HTMLElement>) => {
			const files = Array.from(e.clipboardData.files);
			if (files.length === 0) return;

			const imageFiles = files.filter((f) => f.type.startsWith("image/"));
			const otherFiles = files.filter((f) => !f.type.startsWith("image/"));

			if (imageFiles.length > 0) {
				e.preventDefault();
				onAddImages(imageFiles);
			}

			if (otherFiles.length > 0 && workspaceId) {
				e.preventDefault();
				const uploadFn = uploader ?? uploadAttachment;
				const names = otherFiles.map((f) => f.name);
				setUploadingFiles((prev) => [...prev, ...names]);

				try {
					const settled = await Promise.allSettled(
						otherFiles.map((file) => uploadFn(workspaceId, file)),
					);
					const items: FileReferenceItem[] = [];
					for (let i = 0; i < settled.length; i++) {
						const result = settled[i];
						if (result?.status === "fulfilled") {
							items.push({ path: result.value.path, kind: "file" });
						} else {
							onUploadError?.(otherFiles[i]?.name ?? "file");
						}
					}
					if (items.length > 0) {
						onInsertReferences(items);
					}
				} finally {
					setUploadingFiles((prev) => prev.filter((name) => !names.includes(name)));
				}
			}
		},
		[onAddImages, onInsertReferences, onUploadError, uploader, workspaceId],
	);

	return {
		isDraggingOver,
		uploadingFiles,
		onPaste,
		dropHandlers: {
			onDragEnter,
			onDragOver,
			onDragLeave,
			onDrop,
		},
	};
}
