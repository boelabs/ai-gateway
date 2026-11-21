import { useSyncExternalStore } from "react";

const noSubscription = () => () => undefined;

/**
 * Today's date in UTC (`YYYY-MM-DD`), read in the browser only. A prerendered shell would freeze a
 * date read on the server into it, so there this is `undefined` and what depends on it waits for
 * hydration.
 */
export function useToday(): string | undefined {
	return useSyncExternalStore(
		noSubscription,
		() => new Date().toISOString().slice(0, 10),
		() => undefined,
	);
}
