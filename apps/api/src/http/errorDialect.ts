/** Every endpoint in the Messages family uses Anthropic's public error envelope. */
export function usesAnthropicErrorDialect(path: string): boolean {
	return path === "/v1/messages" || path.startsWith("/v1/messages/");
}

export type ErrorDialect =
	| "openai"
	| "anthropic"
	| "openrouter"
	| "google"
	| "typesafe";

/** The error envelope the public endpoint at `path` speaks; OpenAI's unless it mirrors another API. */
export function errorDialectFor(path: string): ErrorDialect {
	if (usesAnthropicErrorDialect(path)) {
		return "anthropic";
	}
	switch (path) {
		case "/v1/rerank":
			return "openrouter";
		case "/v1beta/decisions":
			return "google";
		case "/v1/systemone":
			return "typesafe";
		default:
			return "openai";
	}
}
