/**
 * Tags on the dashboard's `'use cache'` entries, shared so the feature that writes the data can
 * expire the one that caches it without the two importing each other.
 *
 * `PUBLIC_MODELS` tags the playground's copy of `GET /v1/models`; every deployment write expires it,
 * so a model added, edited, toggled or deleted shows up there on the next visit.
 */
export const CACHE_TAGS = {
	PUBLIC_MODELS: "gateway:public-models",
} as const;
