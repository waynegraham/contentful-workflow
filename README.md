# Contentful Workflow Importer

Imports `iab25-sample.csv` into Contentful content type `alMadarCsv` in space `t7x0vaz0zty0`.

## What It Does
- Inserts missing entries only (idempotent by `IAB Code` -> `iabCode`)
- Leaves created entries as drafts (no publish)
- Validates required fields and enum constraints
- Auto-fills missing Arabic localized fields via OpenAI translation
- Defers non-text/media fields
- Produces per-run JSON reports in `reports/`

## Prerequisites
- Node.js 18+
- Contentful Management API token with access to:
  - Space: `t7x0vaz0zty0`
  - Environment: `master`
  - Content type: `alMadarCsv`
- OpenAI API key (required for `dry-run` and `apply` because Arabic auto-translation is enabled)

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
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
CSV_PATH=iab25-sample.csv
MAPPING_PATH=config/almadar-mapping.json
DEFAULT_LOCALE=en-US
AR_LOCALE=ar
```

## Commands

### Validate
Checks mapping, CSV headers, Contentful content type, and locales.

```bash
npm run validate
```

### Dry Run
Performs full processing without writing entries.

```bash
npm run dry-run
```

### Apply
Creates missing entries as drafts.

```bash
npm run apply
```

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
- `validate` does not call OpenAI translation.
- `dry-run` and `apply` call OpenAI when Arabic values are missing and translation is configured.
