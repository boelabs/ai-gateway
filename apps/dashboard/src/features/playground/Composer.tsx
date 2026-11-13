import { useComposerTextarea } from "./useComposerTextarea";
import { ComposerAttachments } from "./ComposerAttachments";
import { type ReactNode, useRef, useState } from "react";
import { useMobileComposer } from "./useMobileComposer";
import { GhostSkeleton } from "#/shared/components/Skeleton";
import { Button } from "#/components/ui/button";
import { ComposerView } from "./ComposerView";
import type { FileUIPart } from "ai";

import {
	SlidersHorizontalIcon as IconAdjustmentsHorizontal,
	SpinnerGapIcon as IconLoader2,
	SquareIcon as IconPlayerStop,
	BroomIcon as IconClear,
	ArrowUpIcon as IconArrowUp,
	PlusIcon as IconPlus,
} from "@phosphor-icons/react/dist/ssr";

export type DraftAttachment = FileUIPart & { id: string };

export function Composer({
	prompt,
	onPrompt,
	files,
	onRemove,
	onFiles,
	accepted,
	reading,
	busy,
	onSend,
	onStop,
	onSettings,
	onReset,
	modelPicker,
	placeholder = "Write a message...",
	showAttach = true,
	readOnly = false,
	canSend,
	loading = false,
}: {
	prompt: string;
	onPrompt: (value: string) => void;
	files: DraftAttachment[];
	onRemove: (id: string) => void;
	onFiles: (files: File[]) => void;
	accepted: string[];
	reading: boolean;
	busy: boolean;
	onSend: (event: React.FormEvent<HTMLFormElement>) => void;
	onStop: () => void;
	onSettings: () => void;
	onReset: () => void;
	/**
	 * The model this message will be sent to, picked here rather than in a header bar: it is part of
	 * writing the message, and it is the thing an operator changes most often.
	 */
	modelPicker?: ReactNode;
	/** What this capability is asking for — a message, a prompt, a query. */
	placeholder?: string;
	/**
	 * Whether attaching is a thing this capability can do at all. A chat model that happens to take
	 * no images still shows the clip, disabled, because another model would; embedding a file is not
	 * a thing anywhere, and a permanently dead button is worse than none.
	 */
	showAttach?: boolean;
	/** For a capability whose request is a file: there is nothing to type into the box. */
	readOnly?: boolean;
	/** Overrides "there is a draft" as the test for whether this composer can be sent. */
	canSend?: boolean;
	/**
	 * The playground's skeleton: the same box, with its controls ghosted where they stand. Nothing
	 * moves when the real composer replaces it.
	 */
	loading?: boolean;
}) {
	const ghost = (node: ReactNode) =>
		loading ? (
			<GhostSkeleton className="rounded-full">{node}</GhostSkeleton>
		) : (
			node
		);
	const input = useRef<HTMLInputElement>(null);
	const [dragging, setDragging] = useState(false);
	const dragDepth = useRef(0);
	const mobile = useMobileComposer();
	const { textarea, expanded, height, overflowY } = useComposerTextarea(
		prompt,
		mobile,
	);
	return (
		<form
			aria-label="Message composer"
			className="playground-composer relative isolate w-full"
			onDragEnter={(event) => {
				if (!event.dataTransfer.types.includes("Files")) {
					return;
				}
				event.preventDefault();
				dragDepth.current++;
				setDragging(true);
			}}
			onDragLeave={(event) => {
				event.preventDefault();
				if (--dragDepth.current <= 0) {
					setDragging(false);
				}
			}}
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes("Files")) {
					event.preventDefault();
				}
			}}
			onDrop={(event) => {
				event.preventDefault();
				dragDepth.current = 0;
				setDragging(false);
				if (!(reading || busy)) {
					onFiles(Array.from(event.dataTransfer.files));
				}
			}}
			onSubmit={onSend}
		>
			<input
				accept={accepted.join(",")}
				aria-label="Attach files"
				className="hidden"
				disabled={reading || busy || !accepted.length}
				multiple
				onChange={(event) => {
					onFiles(Array.from(event.target.files ?? []));
					event.target.value = "";
				}}
				ref={input}
				type="file"
			/>
			<ComposerView
				leftActions={
					showAttach
						? ghost(
								<Button
									aria-label="Attach files"
									className="composer-action"
									disabled={reading || busy || !accepted.length}
									mode="icon"
									onClick={() => input.current?.click()}
									size="sm"
									title={
										accepted.length
											? "Attach files"
											: "This model does not support attachments"
									}
									type="button"
									variant="ghost"
								>
									{reading ? (
										<IconLoader2
											aria-hidden
											className="size-5 animate-spin motion-reduce:animate-none"
										/>
									) : (
										<IconPlus aria-hidden className="size-5" weight="bold" />
									)}
								</Button>,
							)
						: null
				}
				onSurfaceClick={() => textarea.current?.focus()}
				rightActions={ghost(
					<Button
						aria-label={busy ? "Stop response" : "Send message"}
						className="composer-action composer-send"
						disabled={
							!busy &&
							(reading ||
								!(canSend ?? (prompt.trim().length > 0 || files.length > 0)))
						}
						mode="icon"
						onClick={busy ? onStop : undefined}
						size="sm"
						title={busy ? "Stop response" : "Send message"}
						type={busy ? "button" : "submit"}
					>
						{busy ? (
							<IconPlayerStop
								aria-hidden
								className="size-4"
								fill="currentColor"
							/>
						) : (
							<IconArrowUp aria-hidden className="size-5" weight="bold" />
						)}
					</Button>,
				)}
				state={expanded ? "expanded" : "compact"}
				supportingContent={
					// Under the box, not in it: the box is for writing, the row for what it is sent to.
					<div className="flex items-center justify-between gap-2 px-1 pt-2">
						{ghost(
							<Button
								className="rounded-full text-muted-foreground hover:text-foreground"
								onClick={onReset}
								size="sm"
								type="button"
								variant="ghost"
							>
								<IconClear aria-hidden />
								Clear
							</Button>,
						)}
						<div className="flex min-w-0 items-center gap-1">
							{modelPicker}
							{ghost(
								<Button
									aria-label="Settings"
									className="shrink-0 rounded-full text-muted-foreground hover:text-foreground"
									mode="icon"
									onClick={onSettings}
									title="Settings"
									type="button"
									variant="ghost"
								>
									<IconAdjustmentsHorizontal aria-hidden />
								</Button>,
							)}
						</div>
					</div>
				}
				textarea={
					<textarea
						aria-label="Message"
						className="mt-4 w-full min-w-0 resize-none bg-transparent pt-0 pb-4 align-bottom text-base leading-6.5 font-normal text-fg outline-none placeholder:truncate placeholder:text-fg-muted"
						dir="auto"
						onChange={(event) => onPrompt(event.target.value)}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								!event.shiftKey &&
								!event.nativeEvent.isComposing &&
								event.keyCode !== 229 &&
								!mobile
							) {
								event.preventDefault();
								if (!(busy || reading)) {
									event.currentTarget.form?.requestSubmit();
								}
							}
						}}
						onPaste={(event) => {
							const pasted = Array.from(event.clipboardData.files);
							if (pasted.length) {
								event.preventDefault();
								if (!(busy || reading)) {
									onFiles(pasted);
								}
							}
						}}
						placeholder={placeholder}
						readOnly={readOnly}
						ref={textarea}
						rows={1}
						style={{ height, overflowY }}
						value={prompt}
					/>
				}
				topSection={
					files.length ? (
						<ComposerAttachments files={files} onRemove={onRemove} />
					) : undefined
				}
				topSectionLayoutKey={files.map((file) => file.id).join(":")}
			/>
			{dragging ? (
				<div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center rounded-[26px] border-2 border-dashed border-primary bg-surface-2/95 text-sm text-fg">
					{accepted.length
						? "Drop files here"
						: "This model does not support attachments"}
				</div>
			) : null}
			<span className="sr-only" role="status">
				{reading ? "Reading attachments" : ""}
			</span>
		</form>
	);
}
