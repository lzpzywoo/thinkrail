import { CodedError } from "@thinkrail/shared/codedError";

let maintenance = false;
let pendingWork = 0;

export function hostUpdateRunning(): boolean {
	return maintenance;
}

export function assertHostWorkAllowed(): void {
	if (maintenance)
		throw new CodedError("HOST_UPDATE_RUNNING", "A host update is running. Please retry later.");
}

export async function withHostWork<T>(operation: () => Promise<T>): Promise<T> {
	assertHostWorkAllowed();
	pendingWork++;
	try {
		return await operation();
	} finally {
		pendingWork--;
	}
}

export function lockHostUpdate(busy: () => boolean, onRelease: () => void): () => void {
	assertHostWorkAllowed();
	if (pendingWork > 0 || busy())
		throw new CodedError(
			"HOST_UPDATE_BUSY",
			"AI work is still active. Please retry the host update later.",
		);
	maintenance = true;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		maintenance = false;
		onRelease();
	};
}
