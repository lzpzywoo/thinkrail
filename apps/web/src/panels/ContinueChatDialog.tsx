import {
	RiAlertLine as Alert,
	RiArrowDownSLine as ChevronDown,
	RiFolderOpenLine as FolderOpen,
	RiAddLine as Plus,
} from "@remixicon/react";
import type { Workspace } from "@thinkrail/contracts";
import { t as translate, useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@thinkrail/ui/dropdown-menu";
import { useEffect, useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { selectContextRepoProject, selectRepoProjects, useAppStore } from "../store";
import { errorText, getTransport } from "../transport";
import { DEFAULT_PROJECT_PARENT, joinHostPath, projectFolderName } from "./CreateProjectDialog";
import {
	continueChatInNewProject,
	continueChatInWorkspace,
	supportsContinueInNewProject,
} from "./chatActions";

const PICK_TIMEOUT_MS = 30 * 60_000;
const FIELD_CLASS =
	"w-full min-w-0 rounded-sm border border-control-border-default bg-control-bg px-12 py-8 tr-text-ui text-text-default transition-colors placeholder:text-text-muted focus-visible:border-control-border-active focus-visible:focus-ring disabled:opacity-50";

type ContinueTargetSelection = { kind: "existing"; projectId: string } | { kind: "new" };

/** Continue a chat without a project: pick an open repository or create a new git-backed project to receive the agent's summary. */
export function ContinueChatDialog({
	chat,
	title,
	open,
	onOpenChange,
}: {
	chat: Workspace;
	title: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	const projects = useAppStore(useShallow(selectRepoProjects));
	const protocolVersion = useAppStore((s) => s.protocolVersion);
	const canCreateNewProject = supportsContinueInNewProject(protocolVersion);
	const [selection, setSelection] = useState<ContinueTargetSelection | null>(null);
	const [name, setName] = useState("");
	const [parent, setParent] = useState(DEFAULT_PROJECT_PARENT);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const labelId = useId();
	const valueId = useId();
	const nameId = useId();
	const parentId = useId();
	const visible = open && chat.deletionPending !== true;

	useEffect(() => {
		if (!open) return;
		const opened = useAppStore.getState();
		const initialProject =
			selectContextRepoProject(opened)?.id ?? selectRepoProjects(opened)[0]?.id ?? null;
		if (initialProject) {
			setSelection({ kind: "existing", projectId: initialProject });
		} else if (supportsContinueInNewProject(opened.protocolVersion)) {
			setSelection({ kind: "new" });
		} else {
			setSelection(null);
		}
		setName("");
		setParent(DEFAULT_PROJECT_PARENT);
		setBusy(false);
		setError(null);
	}, [open]);

	const isNewProject =
		canCreateNewProject &&
		(selection?.kind === "new" || (projects.length === 0 && selection === null));
	const selectedProject = isNewProject
		? null
		: (projects.find(
				(project) => project.id === (selection?.kind === "existing" ? selection.projectId : null),
			) ??
			projects[0] ??
			null);

	const folder = projectFolderName(name);
	const parentPath = parent.trim();
	const canSubmit = isNewProject
		? folder !== "" && parentPath !== "" && !busy
		: Boolean(selectedProject) && !busy;

	const browse = async () => {
		if (busy) return;
		try {
			const { path } = await getTransport().request(
				"dialog.selectDirectory",
				{},
				{ timeoutMs: PICK_TIMEOUT_MS },
			);
			if (path) setParent(path);
		} catch (err) {
			setError(errorText(err, translate("panels.createProject.pickFailed")));
		}
	};

	const confirm = async () => {
		if (!canSubmit) return;
		if (isNewProject) {
			setBusy(true);
			setError(null);
			try {
				await continueChatInNewProject(chat.id, {
					parentPath,
					name: folder,
					displayName: name.trim(),
				});
				setBusy(false);
				onOpenChange(false);
			} catch (err) {
				setBusy(false);
				setError(errorText(err, translate("panels.chats.continueFailed")));
			}
			return;
		}
		if (!selectedProject) return;
		setBusy(true);
		void continueChatInWorkspace(chat.id, selectedProject.id).finally(() => setBusy(false));
		onOpenChange(false);
	};

	return (
		<Dialog
			open={visible}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && busy) return;
				onOpenChange(nextOpen);
			}}
		>
			<DialogContent data-testid="continue-chat-dialog" className="max-w-[30rem] gap-12">
				<DialogHeader>
					<DialogTitle>{t("panels.chats.continueTitle", { name: title })}</DialogTitle>
					<DialogDescription>{t("panels.chats.continueDescription")}</DialogDescription>
				</DialogHeader>

				<form
					className="flex flex-col gap-12"
					onSubmit={(event) => {
						event.preventDefault();
						void confirm();
					}}
				>
					{projects.length === 0 && !canCreateNewProject ? (
						<p className="tr-text-ui text-text-muted">{t("panels.chats.continueNoProjects")}</p>
					) : (
						<div className="flex flex-col gap-4 tr-text-metadata text-text-muted">
							<span id={labelId}>{t("panels.chats.continueProject")}</span>
							<DropdownMenu>
								<DropdownMenuTrigger
									data-testid="continue-chat-project"
									aria-labelledby={`${labelId} ${valueId}`}
									disabled={busy}
									className="flex h-32 items-center justify-between gap-8 rounded-sm border border-control-border-default bg-control-bg px-8 tr-text-ui text-text-default hover:bg-control-bg-hovered focus-visible:focus-ring disabled:opacity-50"
								>
									<span id={valueId} className="flex min-w-0 items-center gap-6 truncate">
										{isNewProject ? (
											<>
												<Plus className="size-14 shrink-0 text-text-subtle" />
												<span className="truncate">{t("panels.chats.continueNewProject")}</span>
											</>
										) : (
											<span className="truncate">{selectedProject?.name ?? ""}</span>
										)}
									</span>
									<ChevronDown className="size-14 shrink-0 text-text-subtle" />
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start">
									{projects.map((project) => (
										<DropdownMenuItem
											key={project.id}
											data-testid="continue-chat-project-option"
											onSelect={() => {
												setSelection({ kind: "existing", projectId: project.id });
												setError(null);
											}}
										>
											{project.name}
										</DropdownMenuItem>
									))}
									{canCreateNewProject ? (
										<>
											{projects.length > 0 ? <DropdownMenuSeparator /> : null}
											<DropdownMenuItem
												data-testid="continue-chat-new-project-option"
												onSelect={() => {
													setSelection({ kind: "new" });
													setError(null);
												}}
											>
												<Plus className="size-14 shrink-0" />
												{t("panels.chats.continueNewProject")}
											</DropdownMenuItem>
										</>
									) : null}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					)}

					{isNewProject ? (
						<>
							<label htmlFor={nameId} className="flex flex-col gap-4">
								<span className="tr-title-compact text-text-default">
									{t("panels.createProject.name")}
								</span>
								<input
									id={nameId}
									data-testid="continue-chat-new-project-name"
									autoFocus
									autoComplete="off"
									spellCheck={false}
									disabled={busy}
									value={name}
									onChange={(event) => {
										setName(event.target.value);
										if (error) setError(null);
									}}
									placeholder={t("panels.createProject.namePlaceholder")}
									className={FIELD_CLASS}
								/>
							</label>

							<div className="flex flex-col gap-4">
								<label htmlFor={parentId} className="tr-title-compact text-text-default">
									{t("panels.createProject.location")}
								</label>
								<div className="flex gap-8">
									<input
										id={parentId}
										data-testid="continue-chat-new-project-parent"
										autoComplete="off"
										spellCheck={false}
										disabled={busy}
										value={parent}
										onChange={(event) => {
											setParent(event.target.value);
											if (error) setError(null);
										}}
										className={FIELD_CLASS}
									/>
									<Button
										type="button"
										variant="outline"
										size="l"
										iconLeft={FolderOpen}
										disabled={busy}
										data-testid="continue-chat-new-project-browse"
										onClick={() => void browse()}
									>
										{t("panels.createProject.browse")}
									</Button>
								</div>
								<span
									data-testid="continue-chat-new-project-path"
									className="truncate text-text-muted tr-text-metadata"
								>
									{folder ? joinHostPath(parentPath, folder) : t("panels.createProject.pathHint")}
								</span>
							</div>
						</>
					) : null}

					{error ? (
						<p
							data-testid="continue-chat-error"
							className="flex items-start gap-8 text-feedback-error tr-text-ui"
						>
							<Alert className="mt-2 size-16 shrink-0" />
							<span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
						</p>
					) : null}

					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							disabled={busy}
							onClick={() => onOpenChange(false)}
						>
							{t("common.cancel")}
						</Button>
						<Button type="submit" data-testid="continue-chat-confirm" disabled={!canSubmit}>
							{isNewProject
								? busy
									? t("panels.chats.continueCreating")
									: t("panels.chats.continueCreateConfirm")
								: t("panels.chats.continueConfirm")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
