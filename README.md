# Contentful Workflow Importer

Imports `CSV_PATH` into Contentful content type `your_contentful_content_type_id` in space `your_contentful_space_id`.

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
  - Space: `your_contentful_space_id`
  - Environment: `master`
  - Content type: `your_contentful_content_type_id`
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
# Contentful settings
CONTENTFUL_SPACE_ID=your_contentful_space_id
CONTENTFUL_ENV_ID=your_contentful_environment_id
CONTENTFUL_CONTENT_TYPE_ID=your_contentful_content_type_id
CONTENTFUL_MANAGEMENT_TOKEN=your_contentful_management_token
CONTENTFUL_DELIVERY_TOKEN=your_contentful_delivery_token
CONTENTFUL_DELIVERY_HOST=cdn.contentful.com

# Translation model settings
# defaults to ollama with translategemma:latest, but can be set to any provider/model combination
TRANSLATION_PROVIDER=ollama # ollama | openai | gemini | claude
TRANSLATION_MODEL=
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-4.1-mini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash
CLAUDE_API_KEY=
CLAUDE_MODEL=claude-3-5-haiku-latest
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=translategemma:latest

# Local settings
CSV_PATH=your_csv_file.csv
MAPPING_PATH=your_mapping_file.json
IIIF_MAPPING_PATH=your_iiif_mapping_file.json
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

### Humanize Reports
Builds a markdown summary focused on actionable errors from generated JSON reports.

```bash
# default: latest import report only
npm run humanize-reports

# include all import reports
npm run humanize-reports -- --all

# optional custom output path
npm run humanize-reports -- --all --output reports/human-readable-errors-all.md
```

### Export IIIF (Published Content Cache)
Exports published entries from Contentful Delivery API as IIIF Presentation API v3 manifests.

```bash
# incremental (default)
npm run export-iiif

# full rebuild
npm run export-iiif:full

# optional flags
node src/export-iiif-cli.mjs --mode incremental --mapping config/iiif-mapping.json --output manifests
```

Output files:
- `manifests/<iabCode>.json` (one manifest per entry)
- `manifests/collection.json` (collection manifest)
- `manifests/index.json` (incremental cache index)

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

## Editorial Workflow (Airtable -> Contentful)
This workflow is designed around the current importer behavior:
- inserts `new` records only (by `IAB Code`)
- creates draft entries only (no publish)
- auto-generates missing Arabic values for localized fields

### Roles
- Catalog editor: creates and updates English source data in Airtable.
- Import operator: runs `validate`, `dry-run`, and `apply`; shares reports.
- Arabic reviewer: reviews and corrects Arabic fields in Contentful drafts.
- Publisher: final QA and publish approval in Contentful.

### Airtable Setup (Recommended)
Use one main table with at least these fields:
- `IAB Code` (required, unique, never reused)
- `Title of Object` (required)
- `Description` (required)
- `Workflow Status` (single select)
- `Ready for Import` (checkbox or formula from status)
- `Imported At` (datetime)
- `Contentful Entry ID` (text)
- `Import Notes` (long text)

Recommended `Workflow Status` values:
- `Draft EN`
- `Ready for Import`
- `Imported - Needs Arabic Review`
- `Arabic Reviewed`
- `Ready to Publish`
- `Published`

### End-to-End Process
1. Catalog editor enters English content in Airtable (`IAB Code`, title, description, and other mapped fields).
2. Editor marks row `Ready for Import` only when required fields are complete.
3. Import operator exports CSV from Airtable and runs:
   - `npm run validate`
   - `npm run dry-run`
   - check `reports/import-<timestamp>.json` for:
     - `would_create` count is expected
     - no unexpected `skipped_missing_required` or `skipped_invalid_enum`
4. If dry-run is clean, import operator runs `npm run apply`.
5. Import operator updates Airtable rows to `Imported - Needs Arabic Review` and records `Imported At` (and optionally Contentful entry IDs).
6. Arabic reviewer opens draft entries in Contentful and manually reviews all Arabic fields generated by the importer.
7. After corrections, reviewer marks the item `Arabic Reviewed` (in Airtable or a Contentful workflow field).
8. Publisher performs final QA (EN + AR + taxonomy + media + links) and publishes only approved entries.
9. Publisher marks status as `Published`.

### Review and Publish Guardrails
- Do not publish directly after import; imported entries contain machine-generated Arabic that requires human review.
- Treat `IAB Code` as immutable primary key. Changing it creates a new entry path.
- This importer does not update existing entries. If content changes after import, edit directly in Contentful or use a separate update workflow.
- Keep a per-run report archive in `reports/` for audit and troubleshooting.

### Suggested QA Checklist Before Publish
- English title/description are complete and editorially approved.
- Arabic title/description are human-reviewed (not only machine output).
- `category`, `gallery`, and `section` values are valid controlled terms.
- Required metadata is present and date parsing looks correct.
- Entry remains draft until all checks pass.

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

IIIF mapping is stored in:
- `config/iiif-mapping.json`

Default IIIF field mapping:
- `label` -> `title`
- `summary` -> `description`
- `provider` -> `lendingInstitution`
- manifest filename key -> `iabCode`

## Reports
Each `dry-run` and `apply` writes:
- `reports/import-<timestamp>.json`

Human-readable error summaries:
- `npm run humanize-reports` writes `reports/human-readable-errors.md` from the latest `import-*.json` file
- `npm run humanize-reports -- --all` includes all `import-*.json` files

Row statuses include:
- `would_create`
- `created`
- `skipped_existing`
- `skipped_missing_required`
- `skipped_invalid_enum`
- `failed_translation`
- `failed_contentful`

## Security Scan (OSV)
Generate a known-vulnerability report for dependency lockfiles:

```bash
npm run security:osv
```

Output:
- `reports/osv-report.json`

Notes:
- Requires `osv-scanner` to be installed and available on your `PATH`.
- You can pass a custom output path:
  - `npm run security:osv -- reports/custom-osv-report.json`

## Project Files
- `src/import-cli.mjs` - importer CLI implementation
- `src/humanize-reports.mjs` - converts JSON reports into actionable markdown summaries
- `config/almadar-mapping.json` - field mapping and import options
- `src/export-iiif-cli.mjs` - IIIF v3 manifest exporter (published entries via CDA)
- `config/iiif-mapping.json` - IIIF field mapping and collection metadata
- `docs/contentful-import-spec.md` - detailed technical spec
- `docs/airtable-sop-template.md` - copy/paste SOP for Airtable intake, import ops, Arabic review, and publish workflow
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
