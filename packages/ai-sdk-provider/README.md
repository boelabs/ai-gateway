# @boelabs/ai-sdk-provider

[AI SDK](https://ai-sdk.dev) provider for [Boelabs AI Gateway](https://boelabs.com/docs/ai-gateway):
one provider for text (Responses or Chat Completions), embeddings, images, transcription, speech,
reranking, video and the gateway's model catalog.

Gateway models are public names an operator chooses (`general`, `fast`). Generic providers decide
what to send from the model name, so they drop settings such as `reasoning` for those names, and they
lose the provider state the gateway returns between turns. This provider sends every setting as given,
lets the gateway's parameter policy decide, and round-trips that state.

Requires AI SDK 7 (`ai@7`, provider specification `v4`) and Node.js 22+, Bun, or another runtime with
`fetch`.

## Install

```bash
npm install @boelabs/ai-sdk-provider ai
```

## Usage

```bash
export BOELABS_AI_GATEWAY_URL="https://ai.example.com"
export BOELABS_AI_GATEWAY_API_KEY="your-virtual-key"
```

```ts
import { boelabsGateway } from "@boelabs/ai-sdk-provider";
import { streamText } from "ai";

const result = streamText({
  model: boelabsGateway("general"),
  prompt: "Why is the sky blue?",
  reasoning: "high",
});

for await (const delta of result.textStream) {
  process.stdout.write(delta);
}
```

Explicit settings:

```ts
import { createBoelabsGateway } from "@boelabs/ai-sdk-provider";

const gateway = createBoelabsGateway({
  baseURL: "https://ai.example.com", // `/v1` is added when missing
  apiKey: process.env.GATEWAY_KEY,
  textApi: "chat", // default: "responses"
});
```

## Models

| Method | Gateway endpoint | AI SDK function |
|---|---|---|
| `boelabsGateway(id)`, `languageModel(id)` | `/v1/responses` (or `/v1/chat/completions` with `textApi: "chat"`) | `generateText`, `streamText` |
| `responses(id)` | `/v1/responses` | `generateText`, `streamText` |
| `chat(id)` | `/v1/chat/completions` | `generateText`, `streamText` |
| `embedding(id)` | `/v1/embeddings` | `embed`, `embedMany` |
| `image(id)` | `/v1/images/generations`, `/v1/images/edits` | `generateImage` |
| `transcription(id)` | `/v1/audio/transcriptions` | `experimental_transcribe` |
| `speech(id)` | `/v1/audio/speech` | `generateSpeech` |
| `reranking(id)` | `/v1/rerank` | `rerank` |
| `video(id)` | `/v1/videos` | `experimental_generateVideo` |
| `models.list()`, `models.get(id)`, `models.deployments(id)` | `/v1/models` | none |

## Provider options

Gateway options go under `providerOptions.boelabsGateway`:

```ts
await generateText({
  model: boelabsGateway("general"),
  prompt: "Draft the reply.",
  providerOptions: {
    boelabsGateway: {
      reasoningEffort: "medium", // none … max, snapped by the gateway
      reasoningSummary: "detailed",
      serviceMode: "flex", // sent as `general:flex`
      cache: { ttl: 600 }, // x-unified-cache
      routingMetadata: true, // providerMetadata.boelabsGateway.routing
      promptCacheKey: "tenant-42:support-v3",
    },
  },
});
```

Every model type takes `cache`, `routingMetadata`, `requestId`, `serviceMode` and `extraBody`. Each
model type also has its own options; see the documentation.

## Documentation

Full guide, option tables and examples for every model type:
[boelabs.com/docs/ai-gateway/ai-sdk](https://boelabs.com/docs/ai-gateway/ai-sdk).

## License

MIT
