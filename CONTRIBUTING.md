# Contributing to Passmark

Thank you for your interest in contributing to Passmark! This document provides guidelines and information for contributors.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Install dependencies**: `npm install`
4. **Create a branch** for your change: `git checkout -b feature/your-feature`

## Development Setup

### Prerequisites

- Node.js >= 18.0.0
- Redis instance (local or remote)
- API keys for Anthropic and Google Generative AI (for running tests)
- Playwright: `npx playwright install`

### Building

```bash
npm run build
```

This runs the TypeScript compiler (`tsc`). Fix any type errors before submitting.

## Code Style

- **TypeScript** with strict mode enabled
- **Module system**: Node16
- **Target**: ES2022
- Keep code simple and focused. Avoid over-engineering.
- Use named constants from `src/constants.ts` instead of magic numbers
- Use the logger (`src/logger.ts`) instead of `console.log`

## Making Changes

### Branch Naming

- `feature/description` for new features
- `fix/description` for bug fixes
- `docs/description` for documentation changes
- `test/description` for test-only changes

### Commit Messages

Use clear, concise commit messages:

```
feat: add support for custom model providers
fix: handle empty email extraction gracefully
docs: update environment variables table
test: add test contribution naming conventions
```

### Pull Requests

1. Ensure `npm run build` passes with no errors
2. Update documentation if your change affects the public API
3. Add entries to `CHANGELOG.md` under an `[Unreleased]` section
4. Keep PRs focused on a single change
5. Provide a clear description of what changed and why

## Project Structure

```
src/
  config.ts        # Global configuration (configure(), ModelConfig, EmailProvider)
  constants.ts     # Named constants for timeouts, limits, retries
  logger.ts        # Pino logger instance
  models.ts        # AI model resolution (gateway vs direct providers)
  index.ts         # Main entry point and core functions
  types.ts         # TypeScript type definitions
  assertion.ts     # Multi-model consensus assertion engine
  extract.ts       # AI-powered data extraction
  email.ts         # Email generation and content extraction
  redis.ts         # Redis client
  data-cache.ts    # Placeholder resolution and caching
  instrumentation.ts # OpenTelemetry/Axiom setup
  tools.ts         # Playwright browser automation tools
  prompts/         # AI system prompts
  providers/       # Built-in providers (emailsink)
  utils/           # Utility functions and secure script runner
```

## Questions?

Open an issue for discussion before starting large changes. This helps ensure your contribution aligns with the project's direction.
