import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSourceRestart, isSourceWatchMode, type SourceRestartLaunch } from "./sourceRestart";

describe("source restart lifecycle", () => {
	test("awaits graceful shutdown, relaunches the host with its bound port, then exits once", async () => {
		const events: string[] = [];
		let finishShutdown = () => {};
		const shutdown = new Promise<void>((resolve) => {
			finishShutdown = resolve;
		});
		let launched: SourceRestartLaunch | undefined;
		const restart = createSourceRestart({
			port: 24317,
			execPath: "C:\\Program Files\\Bun\\bun.exe",
			execArgv: ["--preload", "C:\\tools\\preload.ts"],
			argv: ["bun", "C:\\thinkrail\\apps\\cli\\src\\index.ts", "../my project", "--port", "24242"],
			cwd: "C:\\work\\other-project",
			env: { PATH: "original path", THINKRAIL_RESTART_PORT: "24242" },
			shutdown: async () => {
				events.push("shutdown");
				await shutdown;
				events.push("closed");
			},
			launch: async (options) => {
				events.push("spawn");
				launched = options;
			},
			exit: (code) => {
				events.push(`exit:${code}`);
			},
		});
		const result = restart();
		expect(restart()).toBe(result);
		expect(events).toEqual(["shutdown"]);
		finishShutdown();
		await result;
		expect(events).toEqual(["shutdown", "closed", "spawn", "exit:0"]);
		expect(launched).toEqual({
			execPath: "C:\\Program Files\\Bun\\bun.exe",
			args: [
				"--preload",
				"C:\\tools\\preload.ts",
				"C:\\thinkrail\\apps\\cli\\src\\index.ts",
				"../my project",
				"--port",
				"24242",
			],
			cwd: "C:\\work\\other-project",
			env: { PATH: "original path", THINKRAIL_RESTART_PORT: "24317" },
		});
		expect(launched?.args.join(" ")).not.toContain("update-source");
	});

	test("shutdown failure never spawns or exits", async () => {
		const events: string[] = [];
		const restart = createSourceRestart({
			port: 24242,
			shutdown: async () => {
				throw new Error("shutdown failed");
			},
			launch: async () => {
				events.push("spawn");
			},
			exit: () => {
				events.push("exit");
			},
		});
		await expect(restart()).rejects.toThrow("shutdown failed");
		expect(events).toEqual([]);
	});

	test("spawn failure is surfaced and does not exit", async () => {
		let exited = false;
		const restart = createSourceRestart({
			port: 24242,
			shutdown: async () => {},
			launch: async () => {
				throw new Error("ENOENT");
			},
			exit: () => {
				exited = true;
			},
		});
		await expect(restart()).rejects.toThrow("ENOENT");
		expect(exited).toBe(false);
	});

	test("detects direct Bun watch and hot flags without matching unrelated arguments", () => {
		for (const flag of ["--watch", "--hot", "--watch=always", "--hot=always"]) {
			expect(isSourceWatchMode(["--preload", "fixture.ts", flag])).toBe(true);
		}
		expect(isSourceWatchMode(["--preload", "watch.ts"])).toBe(false);
	});
});

test("dev supervisor relaunches a disposable fixture only on its explicit shutdown request", async () => {
	const dir = await mkdtemp(join(tmpdir(), "thinkrail-supervisor-"));
	const entry = join(dir, "fixture.ts");
	const lifecycle = new URL("./sourceRestart.ts", import.meta.url).href;
	await writeFile(
		entry,
		`
import { createSourceRestart } from ${JSON.stringify(lifecycle)};
console.log(JSON.stringify({ port: process.env.THINKRAIL_RESTART_PORT ?? null, args: process.argv.slice(2), cwd: process.cwd() }));
console.error("fixture stderr");
if (!process.env.THINKRAIL_RESTART_PORT) {
  await createSourceRestart({ port: 24319, shutdown: async () => { console.log("shutdown complete"); } })();
} else process.exit(0);
`,
	);
	const env = { ...process.env };
	delete env.THINKRAIL_RESTART_PORT;
	const child = Bun.spawn(
		[
			process.execPath,
			fileURLToPath(new URL("./sourceRestart.ts", import.meta.url)),
			entry,
			"project with spaces",
		],
		{
			cwd: dir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(0);
		const lines = stdout.trim().split(/\r?\n/);
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			port: null,
			args: ["project with spaces"],
			cwd: dir,
		});
		expect(lines[1]).toBe("shutdown complete");
		expect(JSON.parse(lines[2] ?? "")).toEqual({
			port: "24319",
			args: ["project with spaces"],
			cwd: dir,
		});
		expect(stderr.match(/fixture stderr/g)).toHaveLength(2);
	} finally {
		child.kill();
		await rm(dir, { recursive: true, force: true });
	}
}, 10000);
