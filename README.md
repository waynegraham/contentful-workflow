# Contentful Workflow Importer

Imports `iab25-sample.csv` into Contentful content type `alMadarCsv` in space `t7x0vaz0zty0`.

## What It Does
- Inserts missing entries only (idempotent by `IAB Code` -> `iabCode`)
- Leaves created entries as drafts (no publish)
- Validates required fields and enum constraints
- Auto-fills missing Arabic localized fields via the configured translation provider
- Defers non-text/media fields
- Produces per-run JSON reports in `reports/`

## Prerequisites
- Node.js 18+
- Contentful Management API token with access to:
  - Space: `t7x0vaz0zty0`
  - Environment: `master`
  - Content type: `alMadarCsv`
- One translation provider configuration (required for `dry-run` and `apply` because Arabic auto-translation is enabled):
  - Ollama local endpoint (`OLLAMA_BASE_URL`) with model pulled locally
  - OpenAI (`OPENAI_API_KEY`)
  - Gemini (`GEMINI_API_KEY`)
  - Claude/Anthropic (`CLAUDE_API_KEY` or `ANTHROPIC_API_KEY`)

## Install
```bash
npm install
```

## Configuration
Copy `.env.example` to `.env` and fill values:

```env
CONTENTFUL_SPACE_ID=xxxxxxx
CONTENTFUL_ENV_ID=master
CONTENTFUL_CONTENT_TYPE_ID=alMadarCsv
CONTENTFUL_MANAGEMENT_TOKEN=your_contentful_management_token
TRANSLATION_PROVIDER=ollama
TRANSLATION_MODEL=
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash
CLAUDE_API_KEY=
CLAUDE_MODEL=claude-3-5-haiku-latest
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=translategemma:latest
CSV_PATH=iab25-sample.csv
MAPPING_PATH=config/almadar-mapping.json
DEFAULT_LOCALE=en-US
AR_LOCALE=ar
```

## Commands

### Validate
Checks mapping, CSV headers, Contentful content type, and locales.
Shows a small live validation indicator unless progress is turned off.

```bash
npm run validate

# optional progress control
node src/import-cli.mjs validate --progress=off
```

### Dry Run
Performs full processing without writing entries.
Shows a live status bar with rows, status counts, and ETA.

```bash
npm run dry-run

# optional progress control
node src/import-cli.mjs dry-run --progress=auto
```

### Apply
Creates missing entries as drafts.
Shows a live status bar with rows, status counts, and ETA.

```bash
npm run apply

# optional progress control
node src/import-cli.mjs apply --progress=on
```

### Progress Output
- `--progress=auto` (default): live progress in TTY, periodic logs in non-TTY
- `--progress=on`: force live progress rendering
- `--progress=off`: disable progress output

## Import Rules
- Unique key: `IAB Code` (`iabCode` in Contentful)
- Existing entries: skipped
- Date parsing:
  - `hijriDate` = text before `/`
  - `gregorianDate` = text after `/`
  - long dashes normalized to `-`
- Array fields (`material`, `curator`, `writers`): split by `,` and `;`, then Title Case each item
- Enum validation: invalid `category`, `gallery`, or `section` values are logged and row is skipped
- Translation failure:
  - required localized field (`title`, `description`) => row fails
  - non-required localized field => error logged, row continues

## Translation Providers
- `TRANSLATION_PROVIDER` supports: `ollama`, `openai`, `gemini`, `claude`
- `TRANSLATION_MODEL` optionally overrides provider default model
- If `TRANSLATION_MODEL` is empty, defaults are:
  - `ollama` -> `translategemma:latest`
  - `openai` -> `gpt-4.1-mini`
  - `gemini` -> `gemini-2.0-flash`
  - `claude` -> `claude-3-5-haiku-latest`

## Mapping File
Mapping is stored in:
- `config/almadar-mapping.json`

Use this file to add new CSV->Contentful field mappings without changing importer code.

## Reports
Each `dry-run` and `apply` writes:
- `reports/import-<timestamp>.json`

Row statuses include:
- `would_create`
- `created`
- `skipped_existing`
- `skipped_missing_required`
- `skipped_invalid_enum`
- `failed_translation`
- `failed_contentful`

## Project Files
- `src/import-cli.mjs` - importer CLI implementation
- `config/almadar-mapping.json` - field mapping and import options
- `docs/contentful-import-spec.md` - detailed technical spec
- `iab25-sample.csv` - sample source CSV

## Notes
- `validate` does not call translation APIs.
- `dry-run` and `apply` call the configured translation provider when Arabic values are missing and translation is configured.

## Troubleshooting
- `npm install` hangs or fails:
- check network access to npm registry and retry.
- delete any partial `node_modules` directory and run `npm install` again.

- `Missing required env/config values`:
- verify `.env` includes all required variables from `.env.example`.
- ensure `CONTENTFUL_MANAGEMENT_TOKEN` and provider auth config are present (`OLLAMA_BASE_URL` for ollama, API key for hosted providers).

- Contentful auth errors (`401`/`403`):
- confirm the PAT is a Content Management API token.
- confirm token has access to space `t7x0vaz0zty0` and environment `master`.

- `Locale not found in Contentful environment`:
- ensure `en-US` and `ar` locales exist in `master`.
- confirm `DEFAULT_LOCALE` and `AR_LOCALE` match Contentful locale codes exactly.

- `Field not found in content type`:
- confirm `CONTENTFUL_CONTENT_TYPE_ID=alMadarCsv`.
- compare `config/almadar-mapping.json` field IDs with Contentful field IDs.

- CSV header mismatch errors:
- verify headers match mapping strings exactly (including punctuation/trailing spaces).
- if source CSV changed, update `config/almadar-mapping.json`.

- Too many rows skipped for invalid enum:
- check CSV values for `category`, `gallery`, and `section`.
- values must match Contentful allowed values exactly (case-sensitive).

- Translation API errors / rate limits:
- verify provider API key is valid and has quota.
- verify `TRANSLATION_PROVIDER` is one of `ollama`, `openai`, `gemini`, `claude`.
- for Ollama, ensure daemon is running and model is installed: `ollama pull translategemma:latest`.
- retry the run; non-required localized translation failures are logged and rows continue.

- `apply` created nothing:
- run `dry-run` first and inspect `reports/import-<timestamp>.json`.
- rows may be skipped as existing (`iabCode` already present) or failing validations.
