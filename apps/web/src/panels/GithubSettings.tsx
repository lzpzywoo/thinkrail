import {
	RiCheckLine as Check,
	RiExternalLinkLine as ExternalLink,
	RiGithubLine as GithubIcon,
	RiRefreshLine as RefreshCw,
} from "@remixicon/react";
import type { GithubAuthStatus } from "@thinkrail/contracts";
import { T, useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { SkeletonRows } from "@thinkrail/ui/skeleton";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { SettingsSection, useAppStore } from "@/store";
import { getTransport } from "@/transport";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsNotice } from "./SettingsNotice";

const GITHUB_REPO_URL = "https://github.com/JetBrains/thinkrail";

export function ThinkRailRepoSection({
	currentVersion,
	upstreamVersion,
	onCheckUpdates,
}: {
	currentVersion?: string | null | undefined;
	upstreamVersion?: string | null | undefined;
	onCheckUpdates: () => void;
}) {
	const t = useT();

	return (
		<SettingsGroup
			title={t("settings.github.repo.cardTitle")}
			description={t("settings.github.repo.cardDescription")}
		>
			<div
				data-testid="settings-gh-repo"
				className="flex flex-col gap-8 rounded-sm bg-control-bg p-12"
			>
				<div className="flex items-center justify-between gap-8">
					<div className="flex items-center gap-8">
						<GithubIcon className="size-16 text-text-default shrink-0" />
						<span className="tr-title-compact text-text-default">
							{t("settings.github.repo.name")}
						</span>
					</div>
					<div className="flex items-center gap-8">
						<Button
							variant="outline"
							size="m"
							data-testid="settings-gh-check-updates"
							onClick={onCheckUpdates}
						>
							{t("settings.github.repo.checkUpdates")}
						</Button>
						<a
							href={GITHUB_REPO_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-4 text-primary hover:underline tr-text-ui"
						>
							<span>{t("settings.github.repo.openRepo")}</span>
							<ExternalLink className="size-14" />
						</a>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-12 border-border-default border-t pt-8">
					{currentVersion ? (
						<span
							className="text-text-muted tr-text-metadata"
							data-testid="settings-gh-repo-current"
						>
							{t("settings.github.repo.currentVersion", { version: currentVersion })}
						</span>
					) : null}
					{upstreamVersion ? (
						<span
							className="text-text-muted tr-text-metadata"
							data-testid="settings-gh-repo-upstream"
						>
							{t("settings.github.repo.upstreamVersion", { version: upstreamVersion })}
						</span>
					) : null}
				</div>
			</div>
		</SettingsGroup>
	);
}

let lastStatus: GithubAuthStatus | null = null;

export interface GithubProbe {
	status: GithubAuthStatus | null;
	failed: boolean;
	pending: number | null;
}

export type GithubProbeEvent =
	| { type: "start"; id: number }
	| { type: "answer"; id: number; status: GithubAuthStatus }
	| { type: "reject"; id: number };

export function githubProbe(probe: GithubProbe, event: GithubProbeEvent): GithubProbe {
	if (event.type === "start") return { ...probe, pending: event.id };
	if (event.id !== probe.pending) return probe;
	return event.type === "answer"
		? { status: event.status, failed: false, pending: null }
		: { ...probe, failed: true, pending: null };
}

export function GithubSettings() {
	const [probe, dispatch] = useReducer(githubProbe, {
		status: lastStatus,
		failed: false,
		pending: null,
	});
	const requests = useRef(0);
	const hostUpdate = useAppStore((s) => s.hostUpdate);
	const hostAppVersion = useAppStore((s) => s.hostAppVersion);
	const currentVersion = hostUpdate?.currentVersion ?? hostAppVersion;
	const upstreamVersion = hostUpdate?.availableVersion;

	const run = useCallback((method: "github.authStatus" | "github.refresh") => {
		const id = ++requests.current;
		dispatch({ type: "start", id });
		getTransport()
			.request(method, {})
			.then(
				(status) => dispatch({ type: "answer", id, status }),
				() => dispatch({ type: "reject", id }),
			);
	}, []);

	useEffect(() => run("github.authStatus"), [run]);

	useEffect(() => {
		if (probe.status) lastStatus = probe.status;
	}, [probe.status]);

	return (
		<div className="flex flex-col gap-16">
			<ThinkRailRepoSection
				currentVersion={currentVersion}
				upstreamVersion={upstreamVersion}
				onCheckUpdates={() => useAppStore.getState().setSettingsSection(SettingsSection.Updates)}
			/>
			<GithubStatusView
				status={probe.status}
				checking={probe.pending !== null}
				failed={probe.failed}
				onRefresh={() => run("github.refresh")}
			/>
		</div>
	);
}

export function GithubStatusView({
	status,
	checking,
	failed,
	onRefresh,
}: {
	status: GithubAuthStatus | null;
	checking: boolean;
	failed: boolean;
	onRefresh: () => void;
}) {
	const t = useT();
	const refreshButton = (
		<Button
			variant="outline"
			size="m"
			iconLeft={RefreshCw}
			loading={checking}
			spinIcon
			data-testid="settings-gh-refresh"
			onClick={onRefresh}
		>
			{t("settings.github.refresh")}
		</Button>
	);

	return (
		<div data-testid="settings-github" className="flex flex-col">
			<SettingsGroup
				title={t("settings.github.title")}
				description={t("settings.github.description")}
			>
				<div data-testid="settings-gh-status" data-connected={status?.connected}>
					{status?.connected ? (
						<div className="flex items-center gap-8 rounded-sm bg-control-bg px-12 py-8">
							<Check className="size-14 text-feedback-success" />
							<span className="tr-text-ui text-feedback-success">
								{t("settings.github.connected")}
							</span>
							{status.login ? (
								<span className="min-w-0 truncate text-text-muted tr-text-metadata">
									{status.login}
								</span>
							) : null}
							<div className="ml-auto shrink-0">{refreshButton}</div>
						</div>
					) : status ? (
						<SettingsNotice variant="warning" action={refreshButton}>
							<p>
								<T
									i18nKey="settings.github.notConnected"
									components={[<code key="command" className="tr-code-text" />]}
								/>
							</p>
						</SettingsNotice>
					) : failed ? (
						<SettingsNotice variant="error" action={refreshButton}>
							<p>{t("settings.github.checkFailed")}</p>
						</SettingsNotice>
					) : (
						<SkeletonRows rows={1} label={t("settings.github.checking")} />
					)}
				</div>
			</SettingsGroup>
		</div>
	);
}
