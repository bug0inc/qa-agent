# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **AWS Bedrock support**: Direct integration with AWS Bedrock for Claude models via the `bedrock/` provider prefix (e.g., `bedrock/claude-3-5-sonnet`). Supports AWS credential provider chain including environment variables, shared credentials file, IAM roles, and EC2 instance profiles. Requires `AWS_REGION` and appropriate AWS credentials. See [AWS Bedrock Support](#aws-bedrock-support) in README for details.
- **OpenCode Zen gateway support**: set `gateway: "opencodezen"` in `configure()` and provide `OPENCODEZEN_API_KEY` to route all model requests through [OpenCode Zen](https://opencode.ai/docs/ko/zen/) (`https://opencode.ai/zen/v1`), an OpenAI-compatible gateway with 30+ curated models including Claude, Gemini, GPT, Qwen, and more.
- **OpenAI Support**: Direct integration with OpenAI models via `@ai-sdk/openai` and `OPENAI_API_KEY`
- `maxRetries` option to `AssertionOptions` (default: `1`) to control how many times a failed assertion is retried with a fresh page snapshot and screenshot. Setting it to `0` disables retries.
- `onRetry` callback to `AssertionOptions` that fires before each retry, receiving the retry index and the full `AssertionResult` from the previous attempt for debugging flaky assertions.
- **CUA mode** (`configure({ ai: { mode: "cua" } })`): execute `runSteps` and `runUserFlow` through OpenAI's Responses API with the built-in `computer` tool. Screenshot-driven, coordinate-based actions via Playwright's `page.mouse` / `page.keyboard`. Requires `OPENAI_API_KEY` and `gateway: "none"`; Redis step caching is skipped in this mode because coordinate actions aren't portable across viewport sizes.
- `cua` model slot in `ModelConfig` (default: `gpt-5.5`). For now, you cannot override the CUA model.
- `getMode()` helper and `AIMode` type exported from `src/config.ts`.

## [1.0.0] - 2026-03-27

### Added

- **Core execution functions**: `runSteps()`, `runUserFlow()`, `generatePlaywrightTest()`, `executeWithAutoHealing()`
- **Multi-model assertion engine**: consensus-based validation using Claude and Gemini with arbiter for disagreements
- **Redis-based step caching**: cache-first execution with AI fallback and auto-healing
- **Configurable AI models**: 8 model slots for different use cases (step execution, assertions, extraction, etc.)
- **AI Gateway support**: route through Vercel AI Gateway or use direct provider SDKs
- **Placeholder system**: `{{run.*}}`, `{{global.*}}`, `{{data.*}}`, and `{{email.*}}` dynamic value injection
- **Email extraction**: pluggable email provider interface with built-in emailsink provider
- **Data extraction**: AI-powered extraction of values from page snapshots and URLs
- **Wait conditions**: AI-evaluated wait conditions with exponential backoff
- **Secure script runner**: AST-validated Playwright script execution with whitelisted APIs
- **Telemetry**: optional Axiom/OpenTelemetry tracing via environment variables
- **Structured logging**: Pino-based logger with configurable log levels
- **Global configuration**: `configure()` function for models, gateway, email provider, upload path
