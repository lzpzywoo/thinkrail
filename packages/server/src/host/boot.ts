import { CodedError } from "@thinkrail/shared/codedError";
import { findFreePort } from "@thinkrail/shared/freePort";
import { resolveShellEnv } from "@thinkrail/shared/shellEnv";
import { reportError } from "../analytics";
import { initializeJbcentralRuntime } from "../auth";
import { applyHostEnvironment } from "../environment";
import { initLogging, logger } from "../log";
import { type MuseCompanion, startMuseCompanion } from "../muse";
import { installCrashLog } from "./crashLog";
import { type CreateServerOptions, createServer, type RunningServer } from "./server";
import { createSourceRestart, isSourceWatchMode } from "./sourceRestart";

export interface BootHostOptions {
	port: number;
	host: string;
	portMode: "exact" | "free";
	staticDir?: string;
	projectPath?: string;
	appVersion?: string;
	analytics?: CreateServerOptions["analytics"];
	hostUpdate?: CreateServerOptions["hostUpdate"];
	verbose?: boolean;
	resolveShellEnv?: boolean;
	enableMuseHub?: boolean;
}

const log = logger("host");

export interface BootedHost {
	readonly server: RunningServer;
	readonly port: number;
	readonly requested: number;
	readonly museCompanion?: MuseCompanion;
}

function attachProcessSignals(server: RunningServer): RunningServer {
	let signalExit = false;
	const detachSignals = () => {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	};
	const stop = (): void => {
		detachSignals();
		server.stop();
	};
	const shutdown = (): Promise<void> => {
		detachSignals();
		return server.shutdown();
	};
	const onSignal = (): void => {
		if (signalExit) return;
		signalExit = true;
		void shutdown().finally(() => process.exit(0));
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	return {
		get port() {
			return server.port;
		},
		startAttributionClaim: () => server.startAttributionClaim(),
		stop,
		shutdown,
	};
}

export async function bootHost(options: BootHostOptions): Promise<BootedHost> {
	const shellEnv = options.resolveShellEnv ? resolveShellEnv() : undefined;
	await initLogging({
		...(options.verbose ? { level: "debug" as const } : {}),
		...(options.appVersion ? { appVersion: options.appVersion } : {}),
	});
	installCrashLog(options.appVersion);
	await shellEnv;
	applyHostEnvironment();
	await initializeJbcentralRuntime();

	const requested = options.port;
	const port =
		options.portMode === "free" ? await findFreePort(requested, options.host) : requested;
	let restart: (() => Promise<void>) | undefined;
	let hostUpdate = options.hostUpdate;
	if (hostUpdate?.restartRequired) {
		if (isSourceWatchMode()) {
			log.warn(
				"Source updates are disabled under --watch/--hot: use bun run dev without watch, or stop the host and run bun run update:source, then restart manually.",
			);
			hostUpdate = undefined;
		} else {
			const afterRun = hostUpdate.afterRun;
			hostUpdate = {
				...hostUpdate,
				afterRun: async () => {
					await afterRun?.();
					if (!restart) throw new Error("Source restart lifecycle is not ready");
					try {
						await restart();
					} catch (error) {
						log.error("Source update restart failed; restart the host manually", error);
						throw new CodedError(
							"SOURCE_UPDATE_RESTART_FAILED",
							"Source update restart failed. Restart the host manually.",
						);
					}
				},
			};
		}
	}
	const running = await createServer({
		port,
		host: options.host,
		...(options.staticDir ? { staticDir: options.staticDir } : {}),
		...(options.projectPath ? { projectPath: options.projectPath } : {}),
		...(options.appVersion ? { appVersion: options.appVersion } : {}),
		...(options.analytics ? { analytics: options.analytics } : {}),
		...(hostUpdate ? { hostUpdate } : {}),
	});

	let companion: MuseCompanion | undefined;
	const shouldStartMuse =
		options.enableMuseHub ??
		(process.env.NODE_ENV !== "test" &&
			process.env.THINKRAIL_MUSE_HUB !== "false" &&
			process.env.THINKRAIL_MUSE_HUB !== "0");

	if (shouldStartMuse) {
		const hostAddr = options.host === "0.0.0.0" ? "127.0.0.1" : options.host;
		companion = startMuseCompanion({
			thinkrailWsUrl: `ws://${hostAddr}:${running.port}/ws`,
			hubHttpUrl: process.env.MUSE_HUB_URL,
			hubWsUrl: process.env.MUSE_HUB_WS_URL,
			secret: process.env.MUSE_HUB_SECRET,
		});
	}

	const wrappedRunning: RunningServer = {
		get port() {
			return running.port;
		},
		startAttributionClaim: () => running.startAttributionClaim(),
		stop: () => {
			if (companion) void companion.stop();
			running.stop();
		},
		shutdown: async () => {
			if (companion) await companion.stop();
			await running.shutdown();
		},
	};

	const server = attachProcessSignals(wrappedRunning);
	if (hostUpdate?.restartRequired) {
		restart = createSourceRestart({ shutdown: () => server.shutdown(), port: server.port });
	}
	log.info(`listening on port ${server.port}`);
	return {
		server,
		port: server.port,
		requested,
		...(companion ? { museCompanion: companion } : {}),
	};
}

export function reportDesktopError(error: unknown, scope: string): void {
	reportError(error, { source: "desktop", handled: true, scope });
}
