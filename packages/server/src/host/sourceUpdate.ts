import { resolve } from "node:path";
import type { HostUpdateNotice, HostUpdateStatus } from "@thinkrail/contracts";
import { type SpawnSyncCaptured, spawnSyncCaptured } from "@thinkrail/shared/spawn";

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

export type GitRunner = (args: readonly string[], cwd: string) => SpawnSyncCaptured;

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
	spawnSyncCaptured(["git", ...args], { cwd, timeoutMs: 30_000 });

export const defaultProcessRunner: ProcessRunner = async (argv, options) => {
	const proc = Bun.spawn([...argv], {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdout: "pipe",
		stderr: "pipe",
	});

	let stdout = "";
	let stderr = "";

	const readStream = async (
		stream: ReadableStream<Uint8Array>,
		isError: boolean,
	): Promise<void> => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = decoder.decode(value);
				if (isError) {
					stderr += text;
				} else {
					stdout += text;
				}
				options.onOutput?.(text);
			}
		} finally {
			reader.releaseLock();
		}
	};

	await Promise.all([readStream(proc.stdout, false), readStream(proc.stderr, true)]);

	const exitCode = (await proc.exited) ?? 1;
	return { exitCode, stdout, stderr };
};

export function findRepoRoot(cwd?: string, gitRunner: GitRunner = defaultGitRunner): string {
	const dir = cwd ? resolve(cwd) : process.cwd();
	const res = gitRunner(["rev-parse", "--show-toplevel"], dir);
	if (!res.launched || res.exitCode !== 0) {
		throw new Error(`Not inside a git repository: ${res.stderr.trim() || "rev-parse failed"}`);
	}
	return res.stdout.trim().replace(/\\/g, "/");
}

export function checkWorkingTreeClean(
	repoRoot: string,
	gitRunner: GitRunner = defaultGitRunner,
): void {
	const res = gitRunner(["status", "--porcelain"], repoRoot);
	if (!res.launched || res.exitCode !== 0) {
		throw new Error(
			`Failed to check git working tree status: ${res.stderr.trim() || "unknown error"}`,
		);
	}
	if (res.stdout.trim().length > 0) {
		throw new Error(
			"Working tree has uncommitted changes. Please commit, stash, or revert them before updating.",
		);
	}
}

export function ensureUpstreamRemote(
	repoRoot: string,
	upstreamUrl: string = DEFAULT_UPSTREAM_URL,
	gitRunner: GitRunner = defaultGitRunner,
): void {
	const remotesResult = gitRunner(["remote", "-v"], repoRoot);
	if (!remotesResult.launched || remotesResult.exitCode !== 0) {
		throw new Error(
			`Failed to inspect git remotes: ${remotesResult.stderr.trim() || "unknown error"}`,
		);
	}

	const lines = remotesResult.stdout.split("\n");
	let hasUpstream = false;
	let currentUpstreamUrl: string | undefined;

	for (const line of lines) {
		const match = /^upstream\s+(\S+)\s+\((?:fetch|push)\)$/.exec(line.trim());
		if (match?.[1]) {
			hasUpstream = true;
			currentUpstreamUrl = match[1];
			break;
		}
	}

	if (!hasUpstream) {
		const addResult = gitRunner(["remote", "add", "upstream", upstreamUrl], repoRoot);
		if (!addResult.launched || addResult.exitCode !== 0) {
			throw new Error(
				`Failed to add git remote upstream (${upstreamUrl}): ${addResult.stderr.trim() || "unknown error"}`,
			);
		}
	} else if (currentUpstreamUrl !== upstreamUrl) {
		const setUrlResult = gitRunner(["remote", "set-url", "upstream", upstreamUrl], repoRoot);
		if (!setUrlResult.launched || setUrlResult.exitCode !== 0) {
			throw new Error(
				`Failed to update git remote upstream URL to ${upstreamUrl}: ${setUrlResult.stderr.trim() || "unknown error"}`,
			);
		}
	}
}

export function fetchUpstream(
	repoRoot: string,
	upstreamBranch: string = DEFAULT_UPSTREAM_BRANCH,
	gitRunner: GitRunner = defaultGitRunner,
): void {
	const res = gitRunner(["fetch", "upstream", upstreamBranch], repoRoot);
	if (!res.launched || res.exitCode !== 0) {
		throw new Error(
			`Failed to fetch from upstream/${upstreamBranch}: ${res.stderr.trim() || "unknown error"}`,
		);
	}
}

export function checkSourceUpdateAvailable(
	options: {
		repoRoot?: string;
		upstreamUrl?: string;
		upstreamBranch?: string;
		gitRunner?: GitRunner;
		autoFetch?: boolean;
	} = {},
): SourceUpdateCheckResult {
	const runner = options.gitRunner ?? defaultGitRunner;
	const repoRoot = options.repoRoot ?? findRepoRoot(undefined, runner);
	const upstreamUrl = options.upstreamUrl ?? DEFAULT_UPSTREAM_URL;
	const upstreamBranch = options.upstreamBranch ?? DEFAULT_UPSTREAM_BRANCH;

	ensureUpstreamRemote(repoRoot, upstreamUrl, runner);
	if (options.autoFetch !== false) {
		fetchUpstream(repoRoot, upstreamBranch, runner);
	}

	const headResult = runner(["rev-parse", "HEAD"], repoRoot);
	if (!headResult.launched || headResult.exitCode !== 0) {
		throw new Error(
			`Failed to resolve local HEAD commit: ${headResult.stderr.trim() || "unknown error"}`,
		);
	}
	const currentCommit = headResult.stdout.trim();

	const upstreamResult = runner(["rev-parse", `upstream/${upstreamBranch}`], repoRoot);
	if (!upstreamResult.launched || upstreamResult.exitCode !== 0) {
		throw new Error(
			`Failed to resolve upstream/${upstreamBranch} commit: ${upstreamResult.stderr.trim() || "unknown error"}`,
		);
	}
	const upstreamCommit = upstreamResult.stdout.trim();

	let updateAvailable = false;
	if (currentCommit !== upstreamCommit) {
		const revListResult = runner(
			["rev-list", "--count", `HEAD..upstream/${upstreamBranch}`],
			repoRoot,
		);
		if (revListResult.launched && revListResult.exitCode === 0) {
			const count = Number.parseInt(revListResult.stdout.trim(), 10);
			updateAvailable = !Number.isNaN(count) && count > 0;
		}
	}

	return {
		updateAvailable,
		currentCommit,
		upstreamCommit,
		currentShort: currentCommit.slice(0, 7),
		upstreamShort: upstreamCommit.slice(0, 7),
		channel: "source",
	};
}

export function pullUpstream(
	repoRoot: string,
	upstreamBranch: string = DEFAULT_UPSTREAM_BRANCH,
	gitRunner: GitRunner = defaultGitRunner,
): void {
	const res = gitRunner(["pull", "--ff-only", "upstream", upstreamBranch], repoRoot);
	if (!res.launched || res.exitCode !== 0) {
		throw new Error(
			`Failed to fast-forward merge from upstream/${upstreamBranch}: ${res.stderr.trim() || "Not possible to fast-forward"}`,
		);
	}
}

export interface ProcessRestartOptions {
	delayMs?: number;
	execPath?: string;
	argv?: readonly string[];
	cwd?: string;
	env?: Record<string, string | undefined>;
	exitCurrentProcess?: boolean;
}

export function scheduleProcessRestart(options: ProcessRestartOptions = {}): void {
	if (options.exitCurrentProcess === false || process.env.NODE_ENV === "test") {
		return;
	}

	const delay = options.delayMs ?? 1500;
	const execPath = options.execPath ?? process.execPath;
	const argv = options.argv ?? process.argv.slice(1);
	const cwd = options.cwd ?? process.cwd();
	const env = options.env ?? process.env;

	const launcherScript = `
const payload = JSON.parse(process.argv[1]);
setTimeout(() => {
	Bun.spawn(payload.cmd, {
		cwd: payload.cwd,
		env: payload.env,
		stdio: ["ignore", "ignore", "ignore"],
		detached: process.platform !== "win32",
	}).unref();
	process.exit(0);
}, ${delay});
`;

	const payload = JSON.stringify({
		cmd: [execPath, ...argv],
		cwd,
		env,
	});

	try {
		Bun.spawn([execPath, "-e", launcherScript, payload], {
			stdio: ["ignore", "ignore", "ignore"],
			detached: process.platform !== "win32",
		}).unref();
	} catch (err) {
		console.error("Failed to schedule process restart:", err);
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
	skipRestart?: boolean;
	restartDelayMs?: number;
}

export async function executeSourceUpdate(
	options: SourceUpdateOptions = {},
): Promise<SourceUpdateCheckResult> {
	const log = options.logger ?? (() => {});
	const progress = options.onProgress ?? (() => {});
	const runner = options.gitRunner ?? defaultGitRunner;
	const procRunner = options.processRunner ?? defaultProcessRunner;
	const repoRoot = options.repoRoot ?? findRepoRoot(undefined, runner);
	const upstreamUrl = options.upstreamUrl ?? DEFAULT_UPSTREAM_URL;
	const upstreamBranch = options.upstreamBranch ?? DEFAULT_UPSTREAM_BRANCH;

	progress("Checking working tree status...");
	log("Verifying git working tree is clean...");
	checkWorkingTreeClean(repoRoot, runner);

	progress("Configuring upstream remote...");
	log(`Ensuring upstream remote points to ${upstreamUrl}...`);
	ensureUpstreamRemote(repoRoot, upstreamUrl, runner);

	progress("Fetching latest code from upstream...");
	log(`Fetching from upstream/${upstreamBranch}...`);
	fetchUpstream(repoRoot, upstreamBranch, runner);

	const checkResult = checkSourceUpdateAvailable({
		repoRoot,
		upstreamUrl,
		upstreamBranch,
		gitRunner: runner,
		autoFetch: false,
	});

	progress("Pulling latest changes (fast-forward)...");
	log(`Pulling upstream/${upstreamBranch} with --ff-only...`);
	pullUpstream(repoRoot, upstreamBranch, runner);

	if (!options.skipInstall) {
		progress("Installing dependencies (bun install)...");
		log("Running bun install...");
		const installRes = await procRunner(["bun", "install"], {
			cwd: repoRoot,
			onOutput: (chunk) => log(chunk),
		});
		if (installRes.exitCode !== 0) {
			throw new Error(
				`Failed to install dependencies: ${installRes.stderr.trim() || `exit code ${installRes.exitCode}`}`,
			);
		}
	}

	if (!options.skipBuild) {
		progress("Building web UI (bun run build:web)...");
		log("Running bun run build:web...");
		const buildRes = await procRunner(["bun", "run", "build:web"], {
			cwd: repoRoot,
			onOutput: (chunk) => log(chunk),
		});
		if (buildRes.exitCode !== 0) {
			throw new Error(
				`Failed to build web UI: ${buildRes.stderr.trim() || `exit code ${buildRes.exitCode}`}`,
			);
		}
	}

	if (!options.skipRestart) {
		progress("Scheduling server restart...");
		log(`Scheduling server process restart in ${options.restartDelayMs ?? 1500}ms...`);
		scheduleProcessRestart({
			delayMs: options.restartDelayMs ?? 1500,
			cwd: repoRoot,
		});
	}

	progress("Update completed successfully.");
	log("ThinkRail source update complete!");
	return checkResult;
}

export interface SourceHostUpdate {
	intervalMs: number;
	check(): Promise<HostUpdateNotice | null>;
	run(): Promise<void>;
}

export function createSourceHostUpdate(options: SourceUpdateOptions = {}): SourceHostUpdate {
	return {
		intervalMs: DEFAULT_CHECK_INTERVAL_MS,
		check: async () => {
			try {
				const res = checkSourceUpdateAvailable(options);
				const status: HostUpdateStatus = res.updateAvailable ? "available" : "idle";
				return {
					currentVersion: `main@${res.currentShort}`,
					availableVersion: `main@${res.upstreamShort}`,
					channel: "source",
					status,
				};
			} catch {
				return null;
			}
		},
		run: async () => {
			await executeSourceUpdate(options);
		},
	};
}
