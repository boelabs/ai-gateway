import { stringify } from "yaml";

const BANNER =
	"# GENERATED FILE - do not edit by hand.\n" +
	"# Source: src/openapi/*.ts. Regenerate with `bun run openapi:generate`.\n";

/**
 * The committed `openapi.yaml` text for a document. Shared by the generator and the drift test so the
 * two cannot disagree on how it is written.
 *
 * No anchors: the document reuses its shared `$ref` objects on every route, and as YAML aliases they
 * trip the 100-alias guard YAML parsers apply against resource exhaustion.
 */
export function renderOpenApiYaml(document: unknown): string {
	return (
		BANNER + stringify(document, { lineWidth: 0, aliasDuplicateObjects: false })
	);
}
