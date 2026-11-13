import { MessageAttachments } from "./MessageAttachments";
import { MessageLoading, ProcessRow } from "./Process";
import { answerOf, settleSteps } from "./steps";
import { ArrowCounterClockwiseIcon as IconRotate2 } from "@phosphor-icons/react/dist/ssr";
import type { PlaygroundMessage } from "./transport";
import { ResponseDetails } from "./ResponseDetails";
import { ErrorNote } from "#/components/ui/page";
import { Button } from "#/components/ui/button";
import { Status } from "#/components/ui/status";
import { Markdown } from "./Markdown";

import {
	MESSAGE_ACTION_ICON,
	MESSAGE_ACTION,
	CopyAction,
	UserBubble,
} from "./MessageParts";

/** Whether a streamed part has anything to show yet; until one does, the loader stands in. */
function hasVisibleOutput(part: PlaygroundMessage["parts"][number]): boolean {
	// A step takes the loader's line over: the process row shows it, on the same glyph.
	if (
		part.type === "reasoning" ||
		part.type === "dynamic-tool" ||
		part.type.startsWith("tool-")
	) {
		return true;
	}
	return part.type === "text" ? Boolean(part.text) : part.type === "file";
}

export function Conversation({
	messages,
	busy,
	error,
	onCopy,
	onRegenerate,
}: {
	messages: PlaygroundMessage[];
	busy: boolean;
	/**
	 * Why the last response failed, shown inside the turn it belongs to rather than as a bar across
	 * the page: the failure is that answer, and the message's own regenerate button is the retry.
	 */
	error?: string;
	onCopy: (text: string) => Promise<void>;
	onRegenerate: (messageId: string) => void;
}) {
	const displayMessages: PlaygroundMessage[] =
		busy && messages.at(-1)?.role !== "assistant"
			? [
					...messages,
					{
						id: "pending-response",
						role: "assistant",
						parts: [],
						metadata: { state: "streaming" },
					},
				]
			: messages;
	const groups = groupMessages(displayMessages);
	const isStreaming = (message: PlaygroundMessage) =>
		message.metadata?.state === "streaming" ||
		(busy && message.id === messages.at(-1)?.id);
	// A request that failed before the first chunk leaves no assistant turn to hang the note on.
	const failed = displayMessages.at(-1);
	const failedId =
		error && failed?.role === "assistant" ? failed.id : undefined;
	return (
		<div className="mx-auto flex w-full flex-col gap-10 pb-8 sm:max-w-2xl xl:max-w-3xl">
			{groups.map((group) => (
				<section
					aria-label="Conversation turn"
					className="flex w-full flex-col gap-4 px-4 last:min-h-[calc(var(--transcript-height,0px)-3.5rem)]"
					key={group[0].id}
				>
					{group.map((message) => (
						<article
							aria-label={`${message.role === "user" ? "You" : "Assistant"} message`}
							className={
								message.role === "user"
									? "group/message ml-auto flex min-h-17 w-full max-w-[90%] flex-col items-end gap-1"
									: "group/message flex min-h-17 w-full min-w-0 flex-col gap-2"
							}
							key={message.id}
						>
							{message.metadata?.state === "stopped" ? (
								<div className="mb-1 text-xs text-fg-muted">
									<Status tone="muted">Stopped</Status>
								</div>
							) : null}
							{message.role === "user" ? (
								<MessageAttachments
									files={message.parts.flatMap((part, partIndex) =>
										part.type === "file"
											? [{ ...part, id: `${message.id}-file-${partIndex}` }]
											: [],
									)}
								/>
							) : null}
							{message.role === "assistant" &&
							isStreaming(message) &&
							!message.parts.some(hasVisibleOutput) ? (
								<MessageLoading />
							) : null}
							{message.role === "assistant" ? (
								<AnswerProcess live={isStreaming(message)} message={message} />
							) : null}
							{message.parts.map((part, partIndex) => {
								if (part.type === "text" && !part.text) {
									return null;
								}
								const key = `${message.id}-${part.type}-${partIndex}`;
								if (part.type === "text") {
									return message.role === "user" ? (
										<UserBubble
											hasAttachments={message.parts.some(
												(entry) => entry.type === "file",
											)}
											key={key}
											text={part.text}
										/>
									) : (
										<Markdown
											key={key}
											streaming={isStreaming(message)}
											text={part.text}
										/>
									);
								}
								// Reasoning is a step: the process row above the answer opens it.
								if (part.type === "reasoning") {
									return null;
								}
								if (part.type === "file" && message.role !== "user") {
									return (
										<div className="my-2" key={key}>
											{part.mediaType.startsWith("image/") &&
											part.url.startsWith("data:image/") ? (
												// biome-ignore lint/performance/noImgElement: a data:/blob: attachment URL, which next/image has nothing to optimise
												<img
													alt={part.filename ?? "Attached image"}
													className="max-h-64 max-w-full rounded-lg object-contain"
													src={part.url}
												/>
											) : (
												<span className="text-xs break-all">
													Attachment: {part.filename ?? part.mediaType}
												</span>
											)}
										</div>
									);
								}
								if (part.type === "source-url") {
									return (
										<a
											className="block text-xs text-primary underline"
											href={
												/^https?:\/\//u.test(part.url) ? part.url : undefined
											}
											key={key}
											rel="noopener noreferrer"
											target="_blank"
										>
											{part.title ?? part.url}
										</a>
									);
								}
								return null;
							})}
							{message.role === "user" ? (
								<div className="flex w-fit gap-1 self-end px-2 opacity-100 transition-opacity lg:opacity-0 lg:group-focus-within/message:opacity-100 lg:group-hover/message:opacity-100">
									<CopyAction
										label={
											message.role === "user" ? "Copy message" : "Copy response"
										}
										onCopy={onCopy}
										text={message.parts
											.filter((part) => part.type === "text")
											.map((part) => part.text)
											.join("\n")}
									/>
								</div>
							) : null}
							{message.id === failedId ? (
								<ErrorNote width="fit-content">{error}</ErrorNote>
							) : null}
							{message.role === "assistant" ? (
								// While the answer streams the actions keep their row, so nothing jumps when it
								// ends, but stay hidden: copy or regenerate on half an answer is nothing to offer.
								<div
									className={`mt-1 -ml-2 flex h-10 shrink-0 items-center gap-0.5 transition-[opacity,visibility] duration-200 lg:h-8 ${isStreaming(message) ? "invisible opacity-0" : "visible opacity-100"}`}
								>
									<CopyAction
										disabled={isStreaming(message)}
										label="Copy response"
										onCopy={onCopy}
										text={message.parts
											.filter((part) => part.type === "text")
											.map((part) => part.text)
											.join("\n")}
									/>
									{
										<Button
											aria-label="Regenerate response"
											className={MESSAGE_ACTION}
											disabled={busy || isStreaming(message)}
											mode="icon"
											onClick={() => onRegenerate(message.id)}
											size="sm"
											variant="ghost"
										>
											<IconRotate2
												aria-hidden
												className={MESSAGE_ACTION_ICON}
											/>
										</Button>
									}
									<ResponseDetails
										disabled={isStreaming(message) || !message.metadata}
										metrics={message.metadata ?? {}}
									/>
								</div>
							) : null}
						</article>
					))}
				</section>
			))}
			{error && !failedId ? (
				<section aria-label="Conversation turn" className="px-4">
					<ErrorNote width="fit-content">{error}</ErrorNote>
				</section>
			) : null}
		</div>
	);
}

/** The process row of an answer that took steps; nothing for one that went straight to text. */
function AnswerProcess({
	message,
	live,
}: {
	message: PlaygroundMessage;
	live: boolean;
}) {
	const answer = answerOf(message.parts);
	if (answer.steps.length === 0) {
		return null;
	}
	const interrupted =
		message.metadata?.state === "stopped" ||
		message.metadata?.state === "failed";
	return (
		<ProcessRow
			interrupted={interrupted}
			isLive={live}
			isWriting={live && answer.endsInText}
			messageId={message.id}
			steps={settleSteps(answer.steps, live, interrupted)}
		/>
	);
}

export function groupMessages(
	messages: PlaygroundMessage[],
): PlaygroundMessage[][] {
	const groups: PlaygroundMessage[][] = [];
	for (const message of messages) {
		const current = groups.at(-1);
		if (message.role === "user" || !current) {
			groups.push([message]);
		} else {
			current.push(message);
		}
	}
	return groups;
}
