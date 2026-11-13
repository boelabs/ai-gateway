import { Component, memo, type ComponentProps, type ReactNode } from "react";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { Block, Streamdown } from "streamdown";
import { math } from "@streamdown/math";

import {
	ArrowSquareOutIcon as IconExternalLink,
	SpinnerGapIcon as IconLoader2,
	DownloadSimpleIcon as IconDownload,
	ArrowsOutIcon as IconMaximize,
	ArrowCounterClockwiseIcon as IconRotate2,
	MagnifyingGlassMinusIcon as IconZoomOut,
	MagnifyingGlassPlusIcon as IconZoomIn,
	CheckIcon as IconCheck,
	CopyIcon as IconCopy,
	XIcon as IconX,
} from "@phosphor-icons/react/dist/ssr";

const plugins = { math };
const icons: ComponentProps<typeof Streamdown>["icons"] = {
	CheckIcon: IconCheck,
	CopyIcon: IconCopy,
	DownloadIcon: IconDownload,
	ExternalLinkIcon: IconExternalLink,
	Loader2Icon: IconLoader2,
	Maximize2Icon: IconMaximize,
	RotateCcwIcon: IconRotate2,
	XIcon: IconX,
	ZoomInIcon: IconZoomIn,
	ZoomOutIcon: IconZoomOut,
};

export class MarkdownBoundary extends Component<
	{ children: ReactNode; text: string },
	{ failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? (
			<div className="w-full min-w-0">
				<p className="mb-2 text-xs text-fg-muted" role="status">
					Formatting could not load. Showing the original text.
				</p>
				<pre className="font-mono text-sm wrap-break-word whitespace-pre-wrap">
					{this.props.text}
				</pre>
			</div>
		) : (
			this.props.children
		);
	}
}

function MarkdownBlock({ dir, ...props }: ComponentProps<typeof Block>) {
	if (!props.content?.trim()) {
		return null;
	}
	return (
		<div className="playground-markdown-block min-w-0" dir={dir}>
			<Block {...props} />
		</div>
	);
}
const components: ComponentProps<typeof Streamdown>["components"] = {
	pre: (props) => <MarkdownCodeBlock {...props} />,
	img: ({ alt }) => (
		<span className="text-fg-muted">[Image: {alt ?? "external image"}]</span>
	),
	a: ({ href, children }) => (
		<a
			className="text-primary underline underline-offset-2 hover:opacity-80"
			href={href}
			rel="noopener noreferrer"
			target="_blank"
		>
			{children}
		</a>
	),
};

export const Markdown = memo(function MarkdownBody({
	text,
	streaming = false,
	compact = false,
}: {
	text: string;
	streaming?: boolean;
	/**
	 * Secondary text at the surrounding size (a step in the process panel). An answer reads at the
	 * body size, 16px on a 24px line, like the reader's own message.
	 */
	compact?: boolean;
}) {
	return (
		<MarkdownBoundary text={text}>
			<Streamdown
				BlockComponent={MarkdownBlock}
				className={`playground-markdown w-full min-w-0 wrap-break-word ${compact ? "leading-relaxed" : "text-base leading-6"}`}
				components={components}
				controls={false}
				dir="auto"
				icons={icons}
				isAnimating={streaming}
				mode="streaming"
				plugins={plugins}
				skipHtml
			>
				{text}
			</Streamdown>
		</MarkdownBoundary>
	);
});
