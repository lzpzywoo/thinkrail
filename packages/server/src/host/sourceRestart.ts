import { spawn } from "node:child_process";

const RESTART_PORT = "THINKRAIL_RESTART_PORT";
const SUPERVISED = "THINKRAIL_SOURCE_SUPERVISED";

export function isSourceWatchMode(execArgv: readonly string[] = process.execArgv): boolean {
	return execArgv.some((arg) => /^(--watch|--hot)(=|$)/.test(arg));
}

export interface SourceRestartLaunch {
	execPath: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

interface SourceRestartOptions {
	shutdown(): Promise<void>;
	port: number;
	execPath?: string;
	argv?: readonly string[];
	execArgv?: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	launch?: (launch: SourceRestartLaunch) => Promise<void>;
	exit?: (code: number) => void;
}

async function launchReplacement(launch: SourceRestartLaunch): Promise<void> {
	if (process.env[SUPERVISED] === "1" && process.send) {
		await new Promise<void>((resolve, reject) => {
			process.send?.(
				{ type: "thinkrail-source-restart", port: launch.env[RESTART_PORT] },
				(error: Error | null) => {
					if (error) reject(error);
					else resolve();
				},
			);
		});
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const child = spawn(launch.execPath, launch.args, {
			cwd: launch.cwd,
			env: launch.env,
			stdio: "inherit",
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

export function createSourceRestart(options: SourceRestartOptions): () => Promise<void> {
	const launch: SourceRestartLaunch = {
		execPath: options.execPath ?? process.execPath,
		args: [...(options.execArgv ?? process.execArgv), ...(options.argv ?? process.argv).slice(1)],
		cwd: options.cwd ?? process.cwd(),
		env: { ...(options.env ?? process.env), [RESTART_PORT]: String(options.port) },
	};
	let restart: Promise<void> | undefined;
	return () => {
		restart ??= (async () => {
			await options.shutdown();
			await (options.launch ?? launchReplacement)(launch);
			(options.exit ?? process.exit)(0);
		})();
		return restart;
	};
}

async function supervise(entry: string, args: string[]): Promise<number> {
	let env: NodeJS.ProcessEnv = { ...process.env, [SUPERVISED]: "1" };
	let stopping = false;
	let child: ReturnType<typeof spawn> | undefined;
	const stop = () => {
		stopping = true;
		child?.kill("SIGTERM");
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	try {
		while (true) {
			let restartPort: string | undefined;
			child = spawn(process.execPath, [...process.execArgv, entry, ...args], {
				cwd: process.cwd(),
				env,
				stdio: ["inherit", "inherit", "inherit", "ipc"],
			});
			child.on("message", (message: unknown) => {
				if (
					typeof message === "object" &&
					message !== null &&
					"type" in message &&
					message.type === "thinkrail-source-restart" &&
					"port" in message &&
					typeof message.port === "string" &&
					/^\d+$/.test(message.port) &&
					Number(message.port) > 0 &&
					Number(message.port) <= 65535
				)
					restartPort = message.port;
			});
			const code = await new Promise<number>((resolve, reject) => {
				child?.once("error", reject);
				child?.once("exit", (code) => resolve(code ?? 1));
			});
			if (stopping || code !== 0 || !restartPort) return code;
			env = { ...env, [RESTART_PORT]: restartPort };
		}
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}

if (import.meta.main) {
	const [entry, ...args] = process.argv.slice(2);
	if (!entry) throw new Error("Source supervisor requires a host entrypoint");
	process.exit(await supervise(entry, args));
}
