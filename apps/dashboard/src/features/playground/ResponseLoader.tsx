import { ThinkingIndicator } from "#/components/ui/thinking-indicator";

/**
 * Work in progress for a capability that is not chat (an image, an embedding): the thinking glyph
 * and what is happening, the same indicator the chat waits with.
 */
export function ResponseLoader({
	words = ["Working on it"],
}: {
	words?: readonly string[];
}) {
	return (
		<div className="flex items-start py-1.5 text-base">
			<ThinkingIndicator words={words} />
		</div>
	);
}
