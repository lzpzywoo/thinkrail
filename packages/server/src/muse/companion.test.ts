import { afterEach, describe, expect, it } from "bun:test";
import { bootHost } from "../host/boot";
import { MuseCompanion, startMuseCompanion } from "./companion";
import type { AppManifest } from "./types";

describe("MuseCompanion & Server Boot Integration", () => {
	let cleanup: (() => Promise<void>) | null = null;

	afterEach(async () => {
		if (cleanup) {
			await cleanup();
			cleanup = null;
		}
	});

	it("handles unreachable Muse Hub gracefully with retry timer without throwing", async () => {
		// Port 19899 is guaranteed unreachable
		const companion = new MuseCompanion({
			thinkrailWsUrl: "ws://127.0.0.1:24242/ws",
			hubHttpUrl: "http://127.0.0.1:19899",
			hubWsUrl: "ws://127.0.0.1:19899/ws",
			reconnectIntervalMs: 100,
			observationIntervalMs: 5000,
		});

		// Calling start should not throw
		expect(() => companion.start()).not.toThrow();
		expect(companion.isConnected()).toBe(false);

		// Stopping should clean up all timers without error
		await companion.stop();
		expect(companion.isConnected()).toBe(false);
	});

	it("registers tools and exploration endpoints when Hub server is online", async () => {
		let registeredManifest: AppManifest | null = null;
		const hubServer = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/api/v1/register" && req.method === "POST") {
					return req.json().then((body) => {
						registeredManifest = body as AppManifest;
						return new Response(
							JSON.stringify({
								ok: true,
								data: {
									sessionToken: "mock-token-12345",
									hubVersion: 1,
									heartbeatTimeoutMs: 75000,
								},
							}),
							{ headers: { "Content-Type": "application/json" } },
						);
					});
				}
				if (url.pathname === "/ws") {
					if (hubServer.upgrade(req)) return;
					return new Response("Upgrade failed", { status: 400 });
				}
				return new Response("Not found", { status: 404 });
			},
			websocket: {
				message() {},
				open() {},
				close() {},
			},
		});

		const port = hubServer.port;
		const companion = startMuseCompanion({
			thinkrailWsUrl: "ws://127.0.0.1:24242/ws",
			hubHttpUrl: `http://127.0.0.1:${port}`,
			hubWsUrl: `ws://127.0.0.1:${port}/ws`,
			heartbeatIntervalMs: 5000,
		});

		cleanup = async () => {
			await companion.stop();
			hubServer.stop();
		};

		// Wait briefly for async registration
		for (let i = 0; i < 20; i++) {
			if (registeredManifest) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		const manifest = registeredManifest as AppManifest | null;
		expect(manifest).not.toBeNull();
		expect(manifest?.appId).toBe("thinkrail.session-manager");
		expect(manifest?.exploration).toBeDefined();

		const tools = manifest?.tools || [];
		const toolIds = tools.map((t) => t.toolId);
		expect(toolIds).toContain("software_overview");
		expect(toolIds).toContain("software_discover");
		expect(toolIds).toContain("software_read");
		expect(toolIds).toContain("list_projects");
		expect(toolIds).toContain("list_sessions");

		await companion.stop();
		cleanup = null;
		hubServer.stop();
	});

	it("bootHost launches companion when enableMuseHub is true and stops on shutdown", async () => {
		const booted = await bootHost({
			port: 0,
			host: "127.0.0.1",
			portMode: "free",
			enableMuseHub: true,
		});

		cleanup = async () => {
			await booted.server.shutdown();
		};

		expect(booted.museCompanion).toBeDefined();
		expect(booted.museCompanion instanceof MuseCompanion).toBe(true);

		// Shutdown should stop both server and companion cleanly
		await booted.server.shutdown();
		cleanup = null;
	});

	it("bootHost omits companion when enableMuseHub is false", async () => {
		const booted = await bootHost({
			port: 0,
			host: "127.0.0.1",
			portMode: "free",
			enableMuseHub: false,
		});

		cleanup = async () => {
			await booted.server.shutdown();
		};

		expect(booted.museCompanion).toBeUndefined();
		await booted.server.shutdown();
		cleanup = null;
	});
});
