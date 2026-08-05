# Gemini provider handoff

## Current architecture

Before this change, `src/modules/ai/ai.module.ts` selected either `OpenAiService` or `MockAiProviderService` through the existing `AI_PROVIDER` token. Chat, summary, quiz, flashcard, retrieval, and embedding services already depended on that token; the public AI endpoints were `/ai/chat`, `/ai/summary`, `/ai/quiz-generator`, `/ai/flashcards`, and `/ai/sources`.

## Implemented architecture

`GeminiService` implements the existing `AiProvider` contract and is selected by default with `AI_PROVIDER=gemini`. It creates one `GoogleGenAI` client per Nest provider and uses `models.generateContent`/`models.embedContent` from `@google/genai`. Business services remain provider-agnostic.

Gemini requests use backend-only configuration, system instructions, JSON response MIME/schema for generated educational content, bounded retries for 429/timeout/5xx, and an AbortController-backed timeout. SDK failures are mapped to safe Nest HTTP exceptions and logs contain only provider/model/operation/type/status metadata.

## Configuration

Required for the default provider:

```dotenv
AI_PROVIDER=gemini
GEMINI_API_KEY=
GEMINI_MODEL=
GEMINI_EMBEDDING_MODEL=
AI_TIMEOUT_MS=60000
AI_MAX_RETRIES=2
```

`AI_API_KEY`, `AI_MODEL`, and `AI_EMBEDDING_MODEL` are compatible fallbacks only for Gemini. OpenAI variables are not used as Gemini fallbacks. See [`docs/gemini-setup.md`](../gemini-setup.md).

## Verification

- `npm.cmd install @google/genai`
- `npm.cmd run build`
- `npm.cmd test -- --runInBand`
- Frontend search confirmed no Gemini key or SDK.

No live Gemini request is required for unit tests, and no API key is stored in the repository.
