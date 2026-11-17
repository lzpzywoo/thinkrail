import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	checkSourceUpdateAvailable,
	checkWorkingTreeClean,
	createSourceHostUpdate,
	defaultGitRunner,
	executeSourceUpdate,
	findRepoRoot,
	type GitRunner,
} from "./sourceUpdate";

const fixtures: string[] = [];
afterEach(() => {
	for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function commit(cwd: string, file: string, content: string): string {
	writeFileSync(join(cwd, file), content);
	git(cwd, "add", file);
	git(cwd, "commit", "-m", file);
	return git(cwd, "rev-parse", "HEAD");
}

function fixture(conflict = false) {
	const root = mkdtempSync(join(tmpdir(), "thinkrail-source-update-"));
	fixtures.push(root);
	const upstream = join(root, "official");
	const fork = join(root, "fork");
	mkdirSync(upstream);
	git(upstream, "init");
	git(upstream, "symbolic-ref", "HEAD", "refs/heads/main");
	for (const [name, value] of [
		["user.name", "Source Update Test"],
		["user.email", "source-update@example.invalid"],
		["commit.gpgSign", "false"],
		["core.autocrlf", "false"],
	] as const) {
		git(upstream, "config", name, value);
	}
	commit(upstream, "shared.txt", "base\n");
	git(root, "-c", "core.autocrlf=false", "clone", upstream, fork);
	for (const [name, value] of [
		["user.name", "Source Update Test"],
		["user.email", "source-update@example.invalid"],
		["commit.gpgSign", "false"],
		["core.autocrlf", "false"],
	] as const) {
		git(fork, "config", name, value);
	}
	const local = commit(fork, conflict ? "shared.txt" : "fork.txt", "fork feature\n");
	const remote = commit(upstream, conflict ? "shared.txt" : "official.txt", "official feature\n");
	return { fork, upstream, local, remote, options: { repoRoot: fork, upstreamUrl: upstream } };
}

describe("source update with disposable repositories", () => {
	test("checking fetches without changing fork files or HEAD; updating preserves both histories", async () => {
		const { fork, upstream, local, remote, options } = fixture();
		const host = createSourceHostUpdate({ ...options, skipInstall: true, skipBuild: true });
		expect(host.restartRequired).toBe(true);
		expect((await host.check())?.status).toBe("available");
		expect(git(fork, "rev-parse", "HEAD")).toBe(local);
		expect(git(fork, "status", "--porcelain")).toBe("");
		expect(existsSync(join(fork, "official.txt"))).toBe(false);
		await host.run();
		expect(git(fork, "rev-parse", "HEAD^1")).toBe(local);
		expect(git(fork, "rev-parse", "HEAD^2")).toBe(remote);
		expect(readFileSync(join(fork, "fork.txt"), "utf8")).toBe("fork feature\n");
		expect(readFileSync(join(fork, "official.txt"), "utf8")).toBe("official feature\n");
		expect(git(upstream, "rev-parse", "HEAD")).toBe(remote);
		expect((await host.check())?.status).toBe("idle");
	});

	test("merge uses the fetched oid even if the remote tracking ref changes during the run", async () => {
		const { fork, local, remote, options } = fixture();
		const calls: string[][] = [];
		const runner: GitRunner = async (args, cwd) => {
			calls.push([...args]);
			if (args[0] === "merge") git(fork, "update-ref", "refs/remotes/upstream/main", local);
			return defaultGitRunner(args, cwd);
		};
		await executeSourceUpdate({
			...options,
			gitRunner: runner,
			skipInstall: true,
			skipBuild: true,
		});
		expect(calls.filter((args) => args[0] === "fetch")).toHaveLength(1);
		expect(calls.find((args) => args[0] === "merge")).toEqual([
			"merge",
			"--no-edit",
			"--no-ff",
			remote,
		]);
		expect(git(fork, "rev-parse", "HEAD^2")).toBe(remote);
	});

	test("conflict aborts the merge and restores the clean original fork without running build steps", async () => {
		const { fork, local, options } = fixture(true);
		const calls: string[][] = [];
		await expect(
			executeSourceUpdate({
				...options,
				processRunner: async (argv) => {
					calls.push([...argv]);
					return { exitCode: 0, stdout: "", stderr: "" };
				},
			}),
		).rejects.toMatchObject({ code: "SOURCE_UPDATE_CONFLICT" });
		expect(git(fork, "rev-parse", "HEAD")).toBe(local);
		expect(git(fork, "status", "--porcelain")).toBe("");
		expect(readFileSync(join(fork, "shared.txt"), "utf8")).toBe("fork feature\n");
		expect(existsSync(join(fork, ".git", "MERGE_HEAD"))).toBe(false);
		expect(calls).toEqual([]);
	});

	test("dirty worktree blocks before fetch or merge", async () => {
		const { fork, local, options } = fixture();
		writeFileSync(join(fork, "untracked.txt"), "keep me");
		await expect(executeSourceUpdate(options)).rejects.toMatchObject({
			code: "SOURCE_UPDATE_DIRTY",
		});
		expect(git(fork, "rev-parse", "HEAD")).toBe(local);
		expect(git(fork, "remote")).toBe("origin");
		expect(readFileSync(join(fork, "untracked.txt"), "utf8")).toBe("keep me");
	});

	test.each(["MERGE_HEAD", "rebase-merge", "rebase-apply"])(
		"existing %s blocks even with a clean status",
		async (state) => {
			const { fork, local } = fixture();
			const path = join(fork, ".git", state);
			if (state === "MERGE_HEAD") writeFileSync(path, `${local}\n`);
			else mkdirSync(path);
			expect(git(fork, "status", "--porcelain")).toBe("");
			await expect(checkWorkingTreeClean(fork)).rejects.toMatchObject({
				code: "SOURCE_UPDATE_DIRTY",
			});
			expect(existsSync(path)).toBe(true);
		},
	);

	test("a mismatched upstream is reported without rewriting it", async () => {
		const { fork, upstream, options } = fixture();
		git(fork, "remote", "add", "upstream", upstream);
		const host = createSourceHostUpdate({
			...options,
			upstreamUrl: "https://example.invalid/other.git",
		});
		await expect(host.check()).rejects.toMatchObject({ code: "SOURCE_UPDATE_FAILED" });
		expect(git(fork, "remote", "get-url", "upstream")).toBe(upstream);
	});

	test("build failure rejects with a classified error and never starts a restart process", async () => {
		const { options } = fixture();
		const calls: string[][] = [];
		const steps: string[] = [];
		const host = createSourceHostUpdate({
			...options,
			onProgress: (step) => steps.push(step),
			processRunner: async (argv) => {
				calls.push([...argv]);
				return {
					exitCode: argv.includes("build:web") ? 1 : 0,
					stdout: "",
					stderr: "private raw diagnostic",
				};
			},
		});
		await expect(host.run()).rejects.toMatchObject({
			code: "SOURCE_UPDATE_FAILED",
			message: "Building web UI failed. The running service has not been restarted.",
		});
		expect(calls).toEqual([
			["bun", "install"],
			["bun", "run", "build:web"],
		]);
		expect(steps).not.toContain("Update completed successfully.");
		expect(steps.some((step) => /restart/i.test(step))).toBe(false);
	});

	test("default discovery starts at application source rather than the opened project", async () => {
		let startingDirectory = "";
		const runner: GitRunner = async (_args, cwd) => {
			startingDirectory = cwd;
			return { launched: true, exitCode: 0, timedOut: false, stdout: "D:\\app\n", stderr: "" };
		};
		expect(await findRepoRoot(undefined, runner)).toBe("D:/app");
		expect(resolve(startingDirectory)).toBe(resolve(import.meta.dir));
	});

	test("fetch failures are classified without leaking subprocess diagnostics", async () => {
		const { options } = fixture();
		const runner: GitRunner = (args, cwd) =>
			args[0] === "fetch"
				? Promise.resolve({
						launched: true,
						exitCode: 1,
						timedOut: false,
						stdout: "",
						stderr: "secret",
					})
				: defaultGitRunner(args, cwd);
		await expect(
			checkSourceUpdateAvailable({ ...options, gitRunner: runner }),
		).rejects.toMatchObject({
			code: "SOURCE_UPDATE_FAILED",
			message: "Source update Git operation failed (fetch).",
		});
	});
});
