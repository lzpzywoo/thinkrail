import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostUpdateNotice } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import type { SpawnSyncCaptured } from "@thinkrail/shared/spawn";

export const DEFAULT_UPSTREAM_URL = "https://github.com/JetBrains/thinkrail.git";
export const DEFAULT_UPSTREAM_BRANCH = "main";
export const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface SourceUpdateCheckResult {
	updateAvailable: boolean;
	currentCommit: string;
	upstreamCommit: string;
	currentShort: string;
	upstreamShort: string;
	channel: "source";
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<SpawnSyncCaptured>;
export interface ProcessRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}
export type ProcessRunner = (
	argv: readonly string[],
	options: {
		cwd: string;
		env?: Record<string, string | undefined>;
		onOutput?: (chunk: string) => void;
	},
) => Promise<ProcessRunResult>;

export const defaultGitRunner: GitRunner = (args, cwd) =>
	new Promise((resolveResult) => {
		execFile(
			"git",
			[...args],
			{
				cwd,
				timeout: 60_000,
				maxBuffer: 4 * 1024 * 1024,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
			},
			(error, stdout, stderr) =>
				resolveResult({
					launched: !error || typeof error.code === "number",
					exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
					timedOut: error?.killed === true && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
					stdout,
					stderr,
				}),
		);
	});

export const defaultProcessRunner: ProcessRunner = async (argv, options) => {
	const proc = Bun.spawn([...argv], {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let output = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
				output += text;
				if (text) options.onOutput?.(text);
				if (done) return output;
			}
		} finally {
			reader.releaseLock();
		}
	};
	const [stdout, stderr, exitCode] = await Promise.all([
		read(proc.stdout),
		read(proc.stderr),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
};

async function git(args: readonly string[], cwd: string, runner: GitRunner): Promise<string> {
	let result: SpawnSyncCaptured;
	try {
		result = await runner(args, cwd);
	} catch {
		throw new CodedError(
			"SOURCE_UPDATE_FAILED",
			`Source update Git operation failed (${args[0]}).`,
		);
	}
	if (result.launched && result.exitCode === 0) return result.stdout.trim();
	throw new CodedError("SOURCE_UPDATE_FAILED", `Source update Git operation failed (${args[0]}).`);
}

export async function findRepoRoot(
	cwd?: string,
	gitRunner: GitRunner = defaultGitRunner,
): Promise<string> {
	const dir = cwd ? resolve(cwd) : dirname(fileURLToPath(import.meta.url));
	return (await git(["rev-parse", "--show-toplevel"], dir, gitRunner)).replace(/\\/g, "/");
}

export async function checkWorkingTreeClean(
	repoRoot: string,
	gitRunner: GitRunner = defaultGitRunner,
): Promise<void> {
	for (const state of [
		"MERGE_HEAD",
		"rebase-merge",
		"rebase-apply",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"sequencer",
	]) {
		const path = await git(["rev-parse", "--git-path", state], repoRoot, gitRunner);
		if (existsSync(isAbsolute(path) ? path : resolve(repoRoot, path))) {
			throw new CodedError(
				"SOURCE_UPDATE_DIRTY",
				"Finish or abort the existing Git operation before updating.",
			);
		}
	}
	if (await git(["status", "--porcelain", "--untracked-files=all"], repoRoot, gitRunner)) {
		throw new CodedError(
			"SOURCE_UPDATE_DIRTY",
			"Working tree has uncommitted changes. Commit or stash them before updating.",
		);
	}
}

export async function ensureUpstreamRemote(
	repoRoot: string,
	upstreamUrl: string = DEFAULT_UPSTREAM_URL,
	gitRunner: GitRunner = defaultGitRunner,
): Promise<void> {
	const remotes = await git(["remote"], repoRoot, gitRunner);
	if (!remotes.split(/\r?\n/).includes("upstream")) {
		await git(["remote", "add", "upstream", upstreamUrl], repoRoot, gitRunner);
		return;
	}
	const url = await git(["remote", "get-url", "upstream"], repoRoot, gitRunner);
	if (url !== upstreamUrl) {
		throw new CodedError(
			"SOURCE_UPDATE_FAILED",
			"The upstream remote URL does not match the configured source update repository. Correct it manually before checking or updating.",
		);
	}
}

export async function fetchUpstream(
	repoRoot: string,
	upstreamBranch: string = DEFAULT_UPSTREAM_BRANCH,
	gitRunner: GitRunner = defaultGitRunner,
): Promise<string> {
	const trackingRef = `refs/remotes/upstream/${upstreamBranch}`;
	await git(
		["fetch", "--no-tags", "upstream", `refs/heads/${upstreamBranch}:${trackingRef}`],
		repoRoot,
		gitRunner,
	);
	return git(["rev-parse", "--verify", `${trackingRef}^{commit}`], repoRoot, gitRunner);
}

export async function checkSourceUpdateAvailable(
	options: {
		repoRoot?: string;
		upstreamUrl?: string;
		upstreamBranch?: string;
		gitRunner?: GitRunner;
		autoFetch?: boolean;
	} = {},
): Promise<SourceUpdateCheckResult> {
	const runner = options.gitRunner ?? defaultGitRunner;
	const repoRoot = options.repoRoot ?? (await findRepoRoot(undefined, runner));
	const branch = options.upstreamBranch ?? DEFAULT_UPSTREAM_BRANCH;
	await ensureUpstreamRemote(repoRoot, options.upstreamUrl, runner);
	const upstreamCommit =
		options.autoFetch === false
			? await git(
					["rev-parse", "--verify", `refs/remotes/upstream/${branch}^{commit}`],
					repoRoot,
					runner,
				)
			: await fetchUpstream(repoRoot, branch, runner);
	const currentCommit = await git(["rev-parse", "HEAD"], repoRoot, runner);
	const count = await git(
		["rev-list", "--count", `${currentCommit}..${upstreamCommit}`],
		repoRoot,
		runner,
	);
	return {
		updateAvailable: Number(count) > 0,
		currentCommit,
		upstreamCommit,
		currentShort: currentCommit.slice(0, 7),
		upstreamShort: upstreamCommit.slice(0, 7),
		channel: "source",
	};
}

export async function pullUpstream(
	repoRoot: string,
	upstreamBranch: string = DEFAULT_UPSTREAM_BRANCH,
	gitRunner: GitRunner = defaultGitRunner,
	fetchedCommit?: string,
): Promise<void> {
	await checkWorkingTreeClean(repoRoot, gitRunner);
	const commit = fetchedCommit ?? (await fetchUpstream(repoRoot, upstreamBranch, gitRunner));
	try {
		await git(["merge", "--no-edit", "--no-ff", commit], repoRoot, gitRunner);
	} catch (error) {
		const mergePath = await git(["rev-parse", "--git-path", "MERGE_HEAD"], repoRoot, gitRunner);
		if (existsSync(isAbsolute(mergePath) ? mergePath : resolve(repoRoot, mergePath))) {
			let conflicts: string;
			try {
				conflicts = await git(["diff", "--name-only", "--diff-filter=U"], repoRoot, gitRunner);
			} finally {
				await git(["merge", "--abort"], repoRoot, gitRunner);
			}
			if (conflicts)
				throw new CodedError(
					"SOURCE_UPDATE_CONFLICT",
					"Upstream conflicts with local commits. The merge was aborted; resolve the conflict manually before updating.",
				);
		}
		throw error;
	}
}

export interface SourceUpdateOptions {
	repoRoot?: string;
	upstreamUrl?: string;
	upstreamBranch?: string;
	gitRunner?: GitRunner;
	processRunner?: ProcessRunner;
	logger?: (message: string) => void;
	onProgress?: (step: string) => void;
	skipInstall?: boolean;
	skipBuild?: boolean;
}

export async function executeSourceUpdate(
	options: SourceUpdateOptions = {},
): Promise<SourceUpdateCheckResult> {
	try {
		const runner = options.gitRunner ?? defaultGitRunner;
		const repoRoot = options.repoRoot ?? (await findRepoRoot(undefined, runner));
		const progress = options.onProgress ?? (() => {});
		const log = options.logger ?? (() => {});
		progress("Checking working tree status...");
		await checkWorkingTreeClean(repoRoot, runner);
		progress("Fetching latest code from upstream...");
		const result = await checkSourceUpdateAvailable({ ...options, repoRoot });
		progress("Merging upstream while preserving local commits...");
		await pullUpstream(repoRoot, options.upstreamBranch, runner, result.upstreamCommit);
		const processRunner = options.processRunner ?? defaultProcessRunner;
		for (const [skip, argv, label] of [
			[options.skipInstall, ["bun", "install"], "Installing dependencies"],
			[options.skipBuild, ["bun", "run", "build:web"], "Building web UI"],
		] as const) {
			if (skip) continue;
			progress(`${label}...`);
			const res = await processRunner(argv, { cwd: repoRoot, onOutput: log });
			if (res.exitCode !== 0)
				throw new CodedError(
					"SOURCE_UPDATE_FAILED",
					`${label} failed. The running service has not been restarted.`,
				);
		}
		progress("Update completed successfully.");
		return result;
	} catch (error) {
		if (error instanceof CodedError) throw error;
		throw new CodedError(
			"SOURCE_UPDATE_FAILED",
			"Source update failed. The running service has not been restarted.",
		);
	}
}

export interface SourceHostUpdate {
	intervalMs: number;
	restartRequired: true;
	check(): Promise<HostUpdateNotice | null>;
	run(): Promise<void>;
}

export function createSourceHostUpdate(options: SourceUpdateOptions = {}): SourceHostUpdate {
	return {
		intervalMs: DEFAULT_CHECK_INTERVAL_MS,
		restartRequired: true,
		check: async () => {
			const res = await checkSourceUpdateAvailable(options);
			const branch = options.upstreamBranch ?? DEFAULT_UPSTREAM_BRANCH;
			return {
				currentVersion: `${branch}@${res.currentShort}`,
				availableVersion: `${branch}@${res.upstreamShort}`,
				channel: "source",
				status: res.updateAvailable ? "available" : "idle",
			};
		},
		run: async () => {
			await executeSourceUpdate(options);
		},
	};
}
