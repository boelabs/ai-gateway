import type { BoelabsGatewayProviderSettings } from "./boelabs-gateway-provider.ts";
import { createBoelabsGateway } from "./boelabs-gateway-provider.ts";

export interface RecordedRequest {
	url: string;
	method: string;
	headers: Headers;
	body: unknown;
	form: FormData | undefined;
}

type Reply = Response | ((request: RecordedRequest) => Response);

/** A provider whose fetch answers from a queue and records every request. */
export function mockGateway(
	replies: Reply[],
	settings: Omit<BoelabsGatewayProviderSettings, "fetch"> = {},
) {
	const requests: RecordedRequest[] = [];
	const queue = [...replies];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const type = request.headers.get("content-type") ?? "";
		let body: unknown;
		let form: FormData | undefined;
		if (type.includes("application/json")) {
			body = await request.json();
		} else if (type.includes("multipart/form-data")) {
			form = await request.formData();
		}
		const recorded: RecordedRequest = {
			url: request.url,
			method: request.method,
			headers: request.headers,
			body,
			form,
		};
		requests.push(recorded);
		const reply = queue.shift();
		if (reply === undefined) {
			throw new Error(`Unexpected request to ${request.url}`);
		}
		return typeof reply === "function" ? reply(recorded) : reply;
	};
	const provider = createBoelabsGateway({
		baseURL: "https://gateway.test",
		...("apiKey" in settings ? {} : { apiKey: "sk-test" }),
		...settings,
		fetch: fetch as typeof globalThis.fetch,
	});
	return { provider, requests };
}

export function json(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		...init,
		headers: {
			"content-type": "application/json",
			"x-request-id": "req_123",
			...init.headers,
		},
	});
}

export function sse(events: unknown[]): Response {
	const body = `${events
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join("")}data: [DONE]\n\n`;
	return new Response(body, {
		headers: { "content-type": "text/event-stream", "x-request-id": "req_456" },
	});
}
