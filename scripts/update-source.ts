#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import { checkSourceUpdateAvailable, executeSourceUpdate, findRepoRoot } from "@thinkrail/server";

interface CliFlags {
	checkOnly: boolean;
	skipInstall: boolean;
	skipBuild: boolean;
	help: boolean;
}

const USAGE = `Usage: bun run update:source [options]

Fetch the latest ThinkRail source code from the official GitHub repository,
merge upstream while preserving local commits, install dependencies, and build the web UI.
Restart the running server manually after a successful update.

Options:
  --check-only     Check if updates are available without merging or building.
  --skip-install   Skip 'bun install' dependency installation.
  --skip-build     Skip 'bun run build:web' UI build.
  -h, --help       Show this help message.`;

function parseFlags(argv: readonly string[]): CliFlags {
	let checkOnly = false;
	let skipInstall = false;
	let skipBuild = false;
	let help = false;

	for (const arg of argv) {
		if (arg === "--check-only") checkOnly = true;
		else if (arg === "--skip-install") skipInstall = true;
		else if (arg === "--skip-build") skipBuild = true;
		else if (arg === "-h" || arg === "--help") help = true;
		else {
			console.error(`Unknown option: ${arg}\n`);
			console.error(USAGE);
			process.exit(1);
		}
	}

	return { checkOnly, skipInstall, skipBuild, help };
}

async function askRetry(): Promise<boolean> {
	if (!process.stdin.isTTY) return false;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question("\nWould you like to try again? (y/N): ");
		return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
	} finally {
		rl.close();
	}
}

async function run(): Promise<void> {
	const flags = parseFlags(Bun.argv.slice(2));

	if (flags.help) {
		console.log(USAGE);
		return;
	}

	const repoRoot = await findRepoRoot();

	if (flags.checkOnly) {
		console.log(
			"Checking for ThinkRail updates from official repository (https://github.com/JetBrains/thinkrail.git)...",
		);
		try {
			const status = await checkSourceUpdateAvailable({ repoRoot });
			console.log(`\nLocal commit:    main@${status.currentShort} (${status.currentCommit})`);
			console.log(`Upstream commit: main@${status.upstreamShort} (${status.upstreamCommit})`);
			if (status.updateAvailable) {
				console.log("\n[+] An update is available! Run `bun run update:source` to update.");
			} else {
				console.log("\n[*] ThinkRail is already up to date.");
			}
		} catch (err) {
			console.error(
				"\n[!] Failed to check for updates:",
				err instanceof Error ? err.message : String(err),
			);
			process.exit(1);
		}
		return;
	}

	const shouldRun = true;
	while (shouldRun) {
		console.log("\n=== ThinkRail Source Update ===");
		try {
			await executeSourceUpdate({
				repoRoot,
				skipInstall: flags.skipInstall,
				skipBuild: flags.skipBuild,
				logger: (msg) => {
					if (msg.trim().length > 0) process.stdout.write(`  ${msg.trim()}\n`);
				},
				onProgress: (step) => {
					console.log(`-> ${step}`);
				},
			});

			console.log(
				"\n[✓] Source update completed successfully! Restart the running server manually to use the update.",
			);
			return;
		} catch (err) {
			console.error("\n[✗] Update failed:", err instanceof Error ? err.message : String(err));
			console.log("To resolve issues:");
			console.log("  - If you have uncommitted changes: commit or stash them with `git stash`.");
			console.log(
				"  - If you have merge conflicts: reconcile your local branch with upstream/main.",
			);

			const retry = await askRetry();
			if (!retry) {
				console.log(
					"\nUpdate aborted. You can try again at any time by running: bun run update:source",
				);
				process.exit(1);
			}
		}
	}
}

await run();
