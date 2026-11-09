import { describe, expect, test } from "bun:test";
import type { SpawnSyncCaptured } from "@thinkrail/shared/spawn";
import {
	checkSourceUpdateAvailable,
	checkWorkingTreeClean,
	createSourceHostUpdate,
	DEFAULT_CHECK_INTERVAL_MS,
	DEFAULT_UPSTREAM_BRANCH,
	DEFAULT_UPSTREAM_URL,
	ensureUpstreamRemote,
	executeSourceUpdate,
	fetchUpstream,
	findRepoRoot,
	type GitRunner,
	type ProcessRunner,
	pullUpstream,
} from "./sourceUpdate";

function createMockGitRunner(responses: Record<string, Partial<SpawnSyncCaptured>>): {
	runner: GitRunner;
	calls: string[][];
} {
	const calls: string[][] = [];
	const runner: GitRunner = (args, _cwd) => {
		calls.push([...args]);
		const key = args.join(" ");
		const matched = responses[key] ?? {
			launched: true,
			exitCode: 0,
			stdout: "",
			stderr: "",
		};
		return {
			launched: matched.launched ?? true,
			exitCode: matched.exitCode ?? 0,
			stdout: matched.stdout ?? "",
			stderr: matched.stderr ?? "",
		};
	};
	return { runner, calls };
}

describe("sourceUpdate", () => {
	test("findRepoRoot parses rev-parse output", () => {
		const { runner } = createMockGitRunner({
			"rev-parse --show-toplevel": { stdout: "D:\\work\\repo\n" },
		});
		expect(findRepoRoot("D:\\work", runner)).toBe("D:/work/repo");
	});

	test("findRepoRoot throws when not inside a git repo", () => {
		const { runner } = createMockGitRunner({
			"rev-parse --show-toplevel": { exitCode: 128, stderr: "fatal: not a git repository" },
		});
		expect(() => findRepoRoot("D:\\work", runner)).toThrow("Not inside a git repository");
	});

	test("checkWorkingTreeClean passes when status is empty", () => {
		const { runner } = createMockGitRunner({
			"status --porcelain": { stdout: "" },
		});
		expect(() => checkWorkingTreeClean("/repo", runner)).not.toThrow();
	});

	test("checkWorkingTreeClean throws when dirty files exist", () => {
		const { runner } = createMockGitRunner({
			"status --porcelain": { stdout: " M packages/server/src/dev.ts\n" },
		});
		expect(() => checkWorkingTreeClean("/repo", runner)).toThrow(
			"Working tree has uncommitted changes",
		);
	});

	test("ensureUpstreamRemote adds upstream when missing", () => {
		const { runner, calls } = createMockGitRunner({
			"remote -v": { stdout: "origin https://github.com/fork/thinkrail.git (fetch)\n" },
			[`remote add upstream ${DEFAULT_UPSTREAM_URL}`]: { exitCode: 0 },
		});
		ensureUpstreamRemote("/repo", DEFAULT_UPSTREAM_URL, runner);
		expect(calls).toEqual([
			["remote", "-v"],
			["remote", "add", "upstream", DEFAULT_UPSTREAM_URL],
		]);
	});

	test("ensureUpstreamRemote updates upstream url when different", () => {
		const { runner, calls } = createMockGitRunner({
			"remote -v": { stdout: "upstream https://github.com/old/thinkrail.git (fetch)\n" },
			[`remote set-url upstream ${DEFAULT_UPSTREAM_URL}`]: { exitCode: 0 },
		});
		ensureUpstreamRemote("/repo", DEFAULT_UPSTREAM_URL, runner);
		expect(calls).toEqual([
			["remote", "-v"],
			["remote", "set-url", "upstream", DEFAULT_UPSTREAM_URL],
		]);
	});

	test("fetchUpstream executes git fetch upstream <branch>", () => {
		const { runner, calls } = createMockGitRunner({
			[`fetch upstream ${DEFAULT_UPSTREAM_BRANCH}`]: { exitCode: 0 },
		});
		fetchUpstream("/repo", DEFAULT_UPSTREAM_BRANCH, runner);
		expect(calls).toEqual([["fetch", "upstream", DEFAULT_UPSTREAM_BRANCH]]);
	});

	test("checkSourceUpdateAvailable detects newer commit", () => {
		const { runner } = createMockGitRunner({
			"remote -v": { stdout: `upstream ${DEFAULT_UPSTREAM_URL} (fetch)\n` },
			"fetch upstream main": { exitCode: 0 },
			"rev-parse HEAD": { stdout: "344aafcb0b56902e5fc87834059a353d54ca8892\n" },
			"rev-parse upstream/main": { stdout: "1aba63011e81a5a05d705aacd6965f17a34dd576\n" },
			"rev-list --count HEAD..upstream/main": { stdout: "20\n" },
		});
		const result = checkSourceUpdateAvailable({
			repoRoot: "/repo",
			gitRunner: runner,
		});
		expect(result.updateAvailable).toBe(true);
		expect(result.currentShort).toBe("344aafc");
		expect(result.upstreamShort).toBe("1aba630");
		expect(result.channel).toBe("source");
	});

	test("checkSourceUpdateAvailable detects up-to-date commit", () => {
		const { runner } = createMockGitRunner({
			"remote -v": { stdout: `upstream ${DEFAULT_UPSTREAM_URL} (fetch)\n` },
			"fetch upstream main": { exitCode: 0 },
			"rev-parse HEAD": { stdout: "1aba63011e81a5a05d705aacd6965f17a34dd576\n" },
			"rev-parse upstream/main": { stdout: "1aba63011e81a5a05d705aacd6965f17a34dd576\n" },
		});
		const result = checkSourceUpdateAvailable({
			repoRoot: "/repo",
			gitRunner: runner,
		});
		expect(result.updateAvailable).toBe(false);
	});

	test("pullUpstream performs fast-forward merge", () => {
		const { runner, calls } = createMockGitRunner({
			"pull --ff-only upstream main": { exitCode: 0 },
		});
		pullUpstream("/repo", "main", runner);
		expect(calls).toEqual([["pull", "--ff-only", "upstream", "main"]]);
	});

	test("executeSourceUpdate runs through full update lifecycle", async () => {
		const { runner } = createMockGitRunner({
			"status --porcelain": { stdout: "" },
			"remote -v": { stdout: `upstream ${DEFAULT_UPSTREAM_URL} (fetch)\n` },
			"fetch upstream main": { exitCode: 0 },
			"rev-parse HEAD": { stdout: "344aafcb0b56902e5fc87834059a353d54ca8892\n" },
			"rev-parse upstream/main": { stdout: "1aba63011e81a5a05d705aacd6965f17a34dd576\n" },
			"rev-list --count HEAD..upstream/main": { stdout: "5\n" },
			"pull --ff-only upstream main": { exitCode: 0 },
		});

		const procCalls: string[][] = [];
		const mockProcRunner: ProcessRunner = async (argv) => {
			procCalls.push([...argv]);
			return { exitCode: 0, stdout: "ok", stderr: "" };
		};

		const steps: string[] = [];
		const result = await executeSourceUpdate({
			repoRoot: "/repo",
			gitRunner: runner,
			processRunner: mockProcRunner,
			onProgress: (s) => steps.push(s),
			skipRestart: true,
		});

		expect(result.updateAvailable).toBe(true);
		expect(procCalls).toEqual([
			["bun", "install"],
			["bun", "run", "build:web"],
		]);
		expect(steps).toContain("Checking working tree status...");
		expect(steps).toContain("Pulling latest changes (fast-forward)...");
		expect(steps).toContain("Installing dependencies (bun install)...");
		expect(steps).toContain("Building web UI (bun run build:web)...");
		expect(steps).toContain("Update completed successfully.");
	});

	test("createSourceHostUpdate check() returns notice when update available and idle when up to date", async () => {
		const { runner } = createMockGitRunner({
			"remote -v": { stdout: `upstream ${DEFAULT_UPSTREAM_URL} (fetch)\n` },
			"fetch upstream main": { exitCode: 0 },
			"rev-parse HEAD": { stdout: "344aafcb0b56902e5fc87834059a353d54ca8892\n" },
			"rev-parse upstream/main": { stdout: "1aba63011e81a5a05d705aacd6965f17a34dd576\n" },
			"rev-list --count HEAD..upstream/main": { stdout: "1\n" },
		});
		const hostUpdate = createSourceHostUpdate({
			repoRoot: "/repo",
			gitRunner: runner,
		});
		expect(hostUpdate.intervalMs).toBe(DEFAULT_CHECK_INTERVAL_MS);
		const notice = await hostUpdate.check();
		expect(notice).toEqual({
			currentVersion: "main@344aafc",
			availableVersion: "main@1aba630",
			channel: "source",
			status: "available",
		});

		const { runner: runnerUpToDate } = createMockGitRunner({
			"remote -v": { stdout: `upstream ${DEFAULT_UPSTREAM_URL} (fetch)\n` },
			"fetch upstream main": { exitCode: 0 },
			"rev-parse HEAD": { stdout: "344aafcb0b56902e5fc87834059a353d54ca8892\n" },
			"rev-parse upstream/main": { stdout: "344aafcb0b56902e5fc87834059a353d54ca8892\n" },
			"rev-list --count HEAD..upstream/main": { stdout: "0\n" },
		});
		const hostUpdateUpToDate = createSourceHostUpdate({
			repoRoot: "/repo",
			gitRunner: runnerUpToDate,
		});
		const upToDateNotice = await hostUpdateUpToDate.check();
		expect(upToDateNotice).toEqual({
			currentVersion: "main@344aafc",
			availableVersion: "main@344aafc",
			channel: "source",
			status: "idle",
		});
	});
});
