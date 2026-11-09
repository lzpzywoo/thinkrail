import {
	RiCheckLine as Check,
	RiExternalLinkLine as ExternalLink,
	RiGithubLine as GithubIcon,
	RiRefreshLine as RefreshCw,
} from "@remixicon/react";
import type { GithubAuthStatus } from "@thinkrail/contracts";
import { T, useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { useEffect, useState } from "react";
import { SettingsSection, useAppStore } from "@/store";
import { getTransport } from "@/transport";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsNotice } from "./SettingsNotice";

const GITHUB_REPO_URL = "https://github.com/JetBrains/thinkrail";

export function ThinkRailRepoSection({
	currentVersion,
	upstreamVersion,
}: {
	currentVersion?: string | null | undefined;
	upstreamVersion?: string | null | undefined;
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
							onClick={() => useAppStore.getState().setSettingsSection(SettingsSection.Updates)}
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

export function GithubSettings() {
	const t = useT();
	const [gh, setGh] = useState<GithubAuthStatus | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const hostUpdate = useAppStore((s) => s.hostUpdate);
	const hostAppVersion = useAppStore((s) => s.hostAppVersion);
	const currentVersion = hostUpdate?.currentVersion ?? hostAppVersion;
	const upstreamVersion = hostUpdate?.availableVersion;

	useEffect(() => {
		let cancelled = false;
		getTransport()
			.request("github.authStatus", {})
			.then((s) => !cancelled && setGh(s))
			.catch(() => !cancelled && setGh({ connected: false }));
		return () => {
			cancelled = true;
		};
	}, []);

	const refresh = async () => {
		setRefreshing(true);
		const load = async () => setGh(await getTransport().request("github.refresh", {}));
		await load()
			.catch(() => setGh({ connected: false }))
			.finally(() => setRefreshing(false));
	};

	const connected = gh?.connected ?? false;
	const refreshButton = (
		<Button
			variant="outline"
			size="m"
			iconLeft={RefreshCw}
			loading={refreshing}
			spinIcon
			data-testid="settings-gh-refresh"
			onClick={() => void refresh()}
		>
			{t("settings.github.refresh")}
		</Button>
	);

	return (
		<div data-testid="settings-github" className="flex flex-col gap-16">
			<ThinkRailRepoSection currentVersion={currentVersion} upstreamVersion={upstreamVersion} />

			<SettingsGroup
				title={t("settings.github.title")}
				description={t("settings.github.description")}
			>
				<div data-testid="settings-gh-status" data-connected={connected}>
					{connected ? (
						<div className="flex items-center gap-8 rounded-sm bg-control-bg px-12 py-8">
							<Check className="size-14 text-feedback-success" />
							<span className="tr-text-ui text-feedback-success">
								{t("settings.github.connected")}
							</span>
							{gh?.login ? (
								<span className="min-w-0 truncate text-text-muted tr-text-metadata">
									{gh.login}
								</span>
							) : null}
							<div className="ml-auto shrink-0">{refreshButton}</div>
						</div>
					) : (
						<SettingsNotice variant="warning" action={refreshButton}>
							<p>
								<T
									i18nKey="settings.github.notConnected"
									components={[<code key="command" className="tr-code-text" />]}
								/>
							</p>
						</SettingsNotice>
					)}
				</div>
			</SettingsGroup>
		</div>
	);
}
