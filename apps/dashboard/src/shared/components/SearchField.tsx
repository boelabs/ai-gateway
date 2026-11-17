"use client";

import { useDebouncedValue } from "#/shared/lib/useDebouncedValue.ts";
import {
	MagnifyingGlassIcon as IconSearch,
	XIcon as IconX,
} from "@phosphor-icons/react/dist/ssr";
import { useEffect, useEffectEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { cn } from "#/shared/lib/classes";

/**
 * A search's share of a list toolbar: a 9rem start on a phone and 12rem from 40rem up, growing
 * with the row. Also for a search's loading ghost, so the fallback draws the same toolbar.
 */
export const SEARCH_WIDTH =
	"min-w-0 flex-[1_1_9rem] @min-[40rem]:flex-[1_1_12rem]";

/**
 * A list's search box, Billete's: it asks once the operator pauses (300 ms), and a clear button
 * empties it. `value` is what the list searches now; the box keeps what is being typed.
 *
 * The gateway searches, not the browser: these tables are one page of a much longer list, so the
 * term goes into the URL, the loader sends it, and the result is a page of matches from the whole
 * table.
 */
export function SearchField({
	value,
	onSearch,
	placeholder = "Search",
	label,
	className,
}: {
	value: string;
	onSearch: (value: string) => void;
	placeholder?: string;
	label: string;
	/** Its width: by default the list toolbar's (`SEARCH_WIDTH`). */
	className?: string;
}) {
	const [text, setText] = useState(value);
	// The URL changed from elsewhere (back, a link, clearing filters): the box follows it.
	const [seen, setSeen] = useState(value);
	if (value !== seen) {
		setSeen(value);
		if (value !== text.trim()) {
			setText(value);
		}
	}
	const settled = useDebouncedValue(text.trim(), 300);
	// Only a pause in typing searches; a new `value` from outside does not echo back.
	const search = useEffectEvent((next: string) => {
		if (next !== value) {
			onSearch(next);
		}
	});
	useEffect(() => search(settled), [settled]);

	return (
		<div className={cn("relative", SEARCH_WIDTH, className)}>
			<IconSearch
				aria-hidden
				className="pointer-events-none absolute start-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground"
			/>
			<Input
				aria-label={label}
				// Billete's input group: the text starts 8px after the icon.
				className="ps-8 pe-8"
				maxLength={100}
				onValueChange={setText}
				placeholder={placeholder}
				type="search"
				value={text}
			/>
			{text ? (
				<Button
					aria-label="Clear search"
					className="absolute end-1 top-1/2 z-10 -translate-y-1/2"
					mode="icon"
					onClick={() => {
						setText("");
						onSearch("");
					}}
					size="xs"
					type="button"
					variant="ghost"
				>
					<IconX aria-hidden className="size-3.5" />
				</Button>
			) : null}
		</div>
	);
}
