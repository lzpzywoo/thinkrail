import {
	RiCloseLine as Close,
	RiEyeLine as Eye,
	RiEyeOffLine as EyeOff,
	RiAddLine as Plus,
	RiRadarLine as Radar,
} from "@remixicon/react";
import type { CustomModelConfig, CustomOpenAiProviderInput } from "@thinkrail/contracts";
import { t as translate, useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { ToggleSegment } from "@thinkrail/ui/toggle-segment";
import { cn } from "@thinkrail/ui/utils";
import { useEffect, useState } from "react";
import { toast } from "@/store";
import { errorText, getTransport } from "@/transport";

const INPUT_CLASS =
	"w-full min-w-0 rounded-sm border border-control-border-default bg-control-bg px-12 py-6 tr-text-ui text-text-default outline-none transition-colors placeholder:text-text-muted focus-visible:border-control-border-active disabled:border-control-disabled-border disabled:bg-control-disabled-bg disabled:text-control-disabled-text";

export interface CustomOpenAiDialogProps {
	existingProviderId?: string | undefined;
	onClose: () => void;
	onSaved?: ((providerId: string) => void) | undefined;
}

export function CustomOpenAiDialog({
	existingProviderId,
	onClose,
	onSaved,
}: CustomOpenAiDialogProps) {
	const t = useT();
	const [name, setName] = useState("");
	const [id, setId] = useState("");
	const [idTouched, setIdTouched] = useState(false);
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [showApiKey, setShowApiKey] = useState(false);
	const [hasExistingKey, setHasExistingKey] = useState(false);
	const [api, setApi] = useState<"openai-completions" | "openai-responses">("openai-completions");
	const [models, setModels] = useState<CustomModelConfig[]>([]);
	const [newModelId, setNewModelId] = useState("");
	const [probing, setProbing] = useState(false);
	const [probedModels, setProbedModels] = useState<string[] | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const isEditing = Boolean(existingProviderId);

	useEffect(() => {
		if (!existingProviderId) return;
		let cancelled = false;
		void getTransport()
			.request("provider.custom.list", {})
			.then((res) => {
				if (cancelled) return;
				const match = res.providers.find((p) => p.id === existingProviderId);
				if (match) {
					setName(match.name);
					setId(match.id);
					setBaseUrl(match.baseUrl);
					setApi(match.api);
					setModels(match.models);
					setHasExistingKey(match.hasApiKey);
				}
			})
			.catch((err) => {
				if (!cancelled) setError(errorText(err));
			});
		return () => {
			cancelled = true;
		};
	}, [existingProviderId]);

	const handleNameChange = (val: string) => {
		setName(val);
		if (!isEditing && !idTouched) {
			setId(
				val
					.trim()
					.toLowerCase()
					.replace(/[^a-z0-9_-]/g, "-"),
			);
		}
	};

	const addModel = (modelId: string) => {
		const trimmed = modelId.trim();
		if (!trimmed) return;
		if (models.some((m) => m.id === trimmed)) return;
		setModels((prev) => [...prev, { id: trimmed, name: trimmed }]);
	};

	const removeModel = (modelId: string) => {
		setModels((prev) => prev.filter((m) => m.id !== modelId));
	};

	const probeModels = async () => {
		const cleanBase = baseUrl.trim();
		if (!/^https?:\/\//i.test(cleanBase)) {
			setError(t("panels.customOpenAi.baseUrlHint"));
			return;
		}

		setProbing(true);
		setError(null);
		try {
			const res = await getTransport().request("provider.custom.probe", {
				baseUrl: cleanBase,
				apiKey: apiKey.trim() || undefined,
			});
			setProbedModels(res.models);
			if (res.models.length > 0) {
				toast.success(translate("panels.customOpenAi.probeSuccess", { count: res.models.length }));
			} else {
				toast.info(translate("panels.customOpenAi.probeEmpty"));
			}
		} catch (err) {
			setError(errorText(err, translate("panels.customOpenAi.probeFailed")));
		} finally {
			setProbing(false);
		}
	};

	const addAllProbed = () => {
		if (!probedModels) return;
		for (const m of probedModels) {
			addModel(m);
		}
	};

	const canSave =
		name.trim().length > 0 &&
		id.trim().length > 0 &&
		/^https?:\/\//i.test(baseUrl.trim()) &&
		models.length > 0 &&
		!saving;

	const handleSave = async () => {
		if (!canSave) return;
		setSaving(true);
		setError(null);
		try {
			const payload: CustomOpenAiProviderInput = {
				id: id.trim(),
				name: name.trim(),
				baseUrl: baseUrl.trim(),
				apiKey: apiKey.trim() || undefined,
				api,
				models,
			};
			const res = await getTransport().request("provider.custom.save", { provider: payload });
			toast.success(translate("panels.customOpenAi.saveSuccess"));
			onSaved?.(res.providerId);
			onClose();
		} catch (err) {
			setError(errorText(err, translate("panels.customOpenAi.saveFailed")));
		} finally {
			setSaving(false);
		}
	};

	const apiOptions = [
		{ id: "openai-completions", label: t("panels.customOpenAi.apiCompletions") },
		{ id: "openai-responses", label: t("panels.customOpenAi.apiResponses") },
	] as const;

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				data-testid="custom-openai-dialog"
				className="max-h-[85vh] max-w-[36rem] gap-16 overflow-y-auto"
			>
				<DialogHeader>
					<DialogTitle>
						{isEditing ? t("panels.customOpenAi.titleEdit") : t("panels.customOpenAi.titleAdd")}
					</DialogTitle>
					<DialogDescription>{t("panels.customOpenAi.description")}</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-16 py-4">
					{error ? (
						<div
							data-testid="custom-openai-error"
							role="alert"
							className="rounded-sm border border-border-default bg-control-bg p-8 tr-text-metadata text-feedback-error"
						>
							{error}
						</div>
					) : null}

					<div className="flex flex-col gap-6">
						<label htmlFor="custom-provider-name" className="tr-title-compact text-text-default">
							{t("panels.customOpenAi.nameLabel")}
						</label>
						<input
							id="custom-provider-name"
							type="text"
							value={name}
							onChange={(e) => handleNameChange(e.target.value)}
							placeholder={t("panels.customOpenAi.namePlaceholder")}
							aria-label={t("panels.customOpenAi.nameLabel")}
							data-testid="custom-provider-name"
							className={INPUT_CLASS}
						/>
					</div>

					<div className="flex flex-col gap-6">
						<label htmlFor="custom-provider-id" className="tr-title-compact text-text-default">
							{t("panels.customOpenAi.idLabel")}
						</label>
						<input
							id="custom-provider-id"
							type="text"
							value={id}
							disabled={isEditing}
							onChange={(e) => {
								setIdTouched(true);
								setId(e.target.value);
							}}
							placeholder={t("panels.customOpenAi.idPlaceholder")}
							aria-label={t("panels.customOpenAi.idLabel")}
							data-testid="custom-provider-id"
							className={INPUT_CLASS}
						/>
					</div>

					<div className="flex flex-col gap-6">
						<label
							htmlFor="custom-provider-base-url"
							className="tr-title-compact text-text-default"
						>
							{t("panels.customOpenAi.baseUrlLabel")}
						</label>
						<input
							id="custom-provider-base-url"
							type="text"
							value={baseUrl}
							onChange={(e) => setBaseUrl(e.target.value)}
							placeholder={t("panels.customOpenAi.baseUrlPlaceholder")}
							aria-label={t("panels.customOpenAi.baseUrlLabel")}
							data-testid="custom-provider-base-url"
							className={INPUT_CLASS}
						/>
						<span className="tr-text-metadata text-text-muted">
							{t("panels.customOpenAi.baseUrlHint")}
						</span>
					</div>

					<div className="flex flex-col gap-6">
						<label htmlFor="custom-provider-api-key" className="tr-title-compact text-text-default">
							{t("panels.customOpenAi.apiKeyLabel")}
						</label>
						<div className="relative">
							<input
								id="custom-provider-api-key"
								type={showApiKey ? "text" : "password"}
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder={
									hasExistingKey && !apiKey
										? t("panels.customOpenAi.apiKeyOptional")
										: t("panels.customOpenAi.apiKeyPlaceholder")
								}
								aria-label={t("panels.customOpenAi.apiKeyLabel")}
								data-testid="custom-provider-api-key"
								className={cn(INPUT_CLASS, "pr-24")}
							/>
							<div className="absolute top-1/2 right-4 -translate-y-1/2">
								<IconButton
									icon={showApiKey ? EyeOff : Eye}
									label={
										showApiKey
											? t("panels.customOpenAi.hideApiKey")
											: t("panels.customOpenAi.showApiKey")
									}
									onClick={() => setShowApiKey((v) => !v)}
								/>
							</div>
						</div>
					</div>

					<div className="flex flex-col gap-6">
						<span className="tr-title-compact text-text-default">
							{t("panels.customOpenAi.apiTypeLabel")}
						</span>
						<div className="flex flex-wrap items-center gap-4">
							{apiOptions.map((opt) => (
								<ToggleSegment
									key={opt.id}
									testid={`custom-provider-api-${opt.id}`}
									label={opt.label}
									active={api === opt.id}
									onClick={() => setApi(opt.id)}
								/>
							))}
						</div>
					</div>

					<div className="flex flex-col gap-8">
						<div className="flex items-center justify-between">
							<span className="tr-title-compact text-text-default">
								{t("panels.customOpenAi.modelsLabel")}
							</span>
							<Button
								variant="ghost"
								size="s"
								iconLeft={Radar}
								loading={probing}
								spinIcon
								data-testid="custom-provider-probe"
								onClick={() => void probeModels()}
							>
								{probing ? t("panels.customOpenAi.probing") : t("panels.customOpenAi.probeModels")}
							</Button>
						</div>

						{probedModels && probedModels.length > 0 ? (
							<div className="flex flex-col gap-6 rounded-sm border border-border-muted bg-container-workspace-bg p-8">
								<div className="flex items-center justify-between">
									<span className="tr-text-metadata text-text-muted">
										{t("panels.customOpenAi.probeSuccess", {
											count: probedModels.length,
										})}
									</span>
									<Button
										variant="ghost"
										size="s"
										data-testid="custom-provider-add-all-probed"
										onClick={addAllProbed}
									>
										{t("panels.customOpenAi.addAllProbed")}
									</Button>
								</div>
								<div className="flex flex-wrap gap-4">
									{probedModels.map((mId) => {
										const alreadyAdded = models.some((m) => m.id === mId);
										return (
											<button
												key={mId}
												type="button"
												disabled={alreadyAdded}
												onClick={() => addModel(mId)}
												className={cn(
													"rounded-full border px-8 py-2 tr-text-metadata transition-colors",
													alreadyAdded
														? "border-border-muted bg-control-disabled-bg text-text-muted cursor-default"
														: "border-primary-muted bg-primary-subtle text-primary hover:bg-control-soft-primary-bg-hovered",
												)}
											>
												{mId}
											</button>
										);
									})}
								</div>
							</div>
						) : null}

						<div className="flex items-center gap-8">
							<input
								type="text"
								value={newModelId}
								onChange={(e) => setNewModelId(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										addModel(newModelId);
										setNewModelId("");
									}
								}}
								placeholder={t("panels.customOpenAi.modelPlaceholder")}
								aria-label={t("panels.customOpenAi.modelPlaceholder")}
								data-testid="custom-provider-model-input"
								className={INPUT_CLASS}
							/>
							<Button
								variant="outline"
								size="m"
								iconLeft={Plus}
								disabled={!newModelId.trim()}
								data-testid="custom-provider-add-model"
								onClick={() => {
									addModel(newModelId);
									setNewModelId("");
								}}
							>
								{t("panels.customOpenAi.addModel")}
							</Button>
						</div>

						{models.length === 0 ? (
							<span className="tr-text-metadata text-feedback-error">
								{t("panels.customOpenAi.noModels")}
							</span>
						) : (
							<div data-testid="custom-provider-models-list" className="flex flex-wrap gap-6 pt-4">
								{models.map((m) => (
									<div
										key={m.id}
										className="flex items-center gap-4 rounded-full border border-border-default bg-container-elevated-bg py-2 pr-4 pl-8 tr-text-metadata text-text-default"
									>
										<span>{m.name || m.id}</span>
										<IconButton
											icon={Close}
											label={t("common.remove")}
											onClick={() => removeModel(m.id)}
										/>
									</div>
								))}
							</div>
						)}
					</div>
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						size="m"
						disabled={saving}
						data-testid="custom-provider-cancel"
						onClick={onClose}
					>
						{t("common.cancel")}
					</Button>
					<Button
						variant="primary"
						size="m"
						disabled={!canSave}
						loading={saving}
						data-testid="custom-provider-save"
						onClick={() => void handleSave()}
					>
						{t("common.save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
