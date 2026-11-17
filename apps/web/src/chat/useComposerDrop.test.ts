import { describe, expect, it } from "bun:test";
import { THINKRAIL_FILE_DRAG_MIME, type ThinkRailFileDragData } from "@thinkrail/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	hasFilePayload,
	insertReferencesIntoDraft,
	type UseComposerDropOptions,
	useComposerDrop,
} from "./useComposerDrop";

describe("insertReferencesIntoDraft", () => {
	it("returns original draft when items are empty", () => {
		const res = insertReferencesIntoDraft("existing text", 8, []);
		expect(res.nextDraft).toBe("existing text");
		expect(res.nextCaret).toBe(8);
	});

	it("inserts reference into empty draft with trailing space", () => {
		const res = insertReferencesIntoDraft("", 0, [{ path: "src/index.ts", kind: "file" }]);
		expect(res.nextDraft).toBe("@src/index.ts ");
		expect(res.nextCaret).toBe(14);
	});

	it("inserts directory reference with trailing slash", () => {
		const res = insertReferencesIntoDraft("", 0, [{ path: "src/components", kind: "dir" }]);
		expect(res.nextDraft).toBe("@src/components/ ");
	});

	it("preserves trailing slash if already present in directory", () => {
		const res = insertReferencesIntoDraft("", 0, [{ path: "src/components/", kind: "dir" }]);
		expect(res.nextDraft).toBe("@src/components/ ");
	});

	it("inserts with spaces between existing words", () => {
		const res = insertReferencesIntoDraft("hello world", 5, [
			{ path: "src/a.ts" },
			{ path: "src/b.ts" },
		]);
		expect(res.nextDraft).toBe("hello @src/a.ts @src/b.ts world");
		expect(res.nextCaret).toBe(25);
	});
});

describe("hasFilePayload", () => {
	it("returns false for null dataTransfer", () => {
		expect(hasFilePayload(null)).toBe(false);
	});

	it("returns false for plain text drag", () => {
		const dt = { types: ["text/plain"] } as unknown as DataTransfer;
		expect(hasFilePayload(dt)).toBe(false);
	});

	it("returns true for Files drag", () => {
		const dt = { types: ["Files"] } as unknown as DataTransfer;
		expect(hasFilePayload(dt)).toBe(true);
	});

	it("returns true for ThinkRail file drag", () => {
		const dt = { types: [THINKRAIL_FILE_DRAG_MIME] } as unknown as DataTransfer;
		expect(hasFilePayload(dt)).toBe(true);
	});

	it("processes ThinkRail internal file drag on drop", async () => {
		const inserted: any[] = [];
		let captured: ReturnType<typeof useComposerDrop> | undefined;
		function Harness() {
			captured = useComposerDrop({
				onInsertReferences: (items) => inserted.push(...items),
				onAddImages: () => {},
			});
			return null;
		}
		renderToStaticMarkup(createElement(Harness));

		let defaultPrevented = false;
		let propagationStopped = false;
		const fakeEvent = {
			defaultPrevented: false,
			preventDefault: () => {
				defaultPrevented = true;
			},
			stopPropagation: () => {
				propagationStopped = true;
			},
			dataTransfer: {
				types: [THINKRAIL_FILE_DRAG_MIME],
				getData: (type: string) =>
					type === THINKRAIL_FILE_DRAG_MIME
						? JSON.stringify({ workspaceId: "ws-1", path: "src/app.ts", kind: "file" })
						: "",
				files: [],
			},
		} as unknown as Parameters<NonNullable<typeof captured>["dropHandlers"]["onDrop"]>[0];

		await captured?.dropHandlers.onDrop(fakeEvent);
		expect(defaultPrevented).toBe(true);
		expect(propagationStopped).toBe(true);
		expect(inserted).toEqual([{ path: "src/app.ts", kind: "file" }]);
	});

	it("uploads non-image files and inserts reference", async () => {
		const inserted: any[] = [];
		const uploadedCalls: { wsId: string; fileName: string }[] = [];
		let captured: ReturnType<typeof useComposerDrop> | undefined;
		function Harness() {
			captured = useComposerDrop({
				workspaceId: "ws-99",
				onInsertReferences: (items) => inserted.push(...items),
				onAddImages: () => {},
				uploader: async (wsId, file) => {
					uploadedCalls.push({ wsId, fileName: file.name });
					return {
						workspaceId: wsId,
						path: `.thinkrail/context/attachments/${file.name}`,
						fileName: file.name,
						size: file.size,
					};
				},
			});
			return null;
		}
		renderToStaticMarkup(createElement(Harness));

		const testFile = new File(["content"], "document.pdf", { type: "application/pdf" });
		const fakeEvent = {
			defaultPrevented: false,
			preventDefault: () => {},
			stopPropagation: () => {},
			dataTransfer: {
				types: ["Files"],
				getData: () => "",
				files: [testFile],
			},
		} as unknown as Parameters<NonNullable<typeof captured>["dropHandlers"]["onDrop"]>[0];

		await captured?.dropHandlers.onDrop(fakeEvent);
		expect(uploadedCalls).toEqual([{ wsId: "ws-99", fileName: "document.pdf" }]);
		expect(inserted).toEqual([
			{ path: ".thinkrail/context/attachments/document.pdf", kind: "file" },
		]);
	});

	it("forwards image files directly to onAddImages", async () => {
		const addedImages: File[] = [];
		let captured: ReturnType<typeof useComposerDrop> | undefined;
		function Harness() {
			captured = useComposerDrop({
				workspaceId: "ws-99",
				onInsertReferences: () => {},
				onAddImages: (files) => addedImages.push(...files),
			});
			return null;
		}
		renderToStaticMarkup(createElement(Harness));

		const imgFile = new File(["data"], "photo.png", { type: "image/png" });
		const fakeEvent = {
			defaultPrevented: false,
			preventDefault: () => {},
			stopPropagation: () => {},
			dataTransfer: {
				types: ["Files"],
				getData: () => "",
				files: [imgFile],
			},
		} as unknown as Parameters<NonNullable<typeof captured>["dropHandlers"]["onDrop"]>[0];

		await captured?.dropHandlers.onDrop(fakeEvent);
		expect(addedImages).toEqual([imgFile]);
	});
});
