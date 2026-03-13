# Contentful Workflow Importer

Imports Airtable records directly into Contentful content type `your_contentful_content_type_id` in space `your_contentful_space_id`.

## What It Does
- Inserts missing entries only (idempotent by `IAB Code` -> `iabCode`)
- Default import scope is Airtable rows where `contentful_url` is empty
- Optional redo mode reprocesses the full Airtable table and overwrites existing Contentful entries
- Leaves created entries as drafts (no publish)
- Validates required fields and enum constraints
- Validates mapped Airtable fields against Airtable table schema before any import run
- Auto-fills missing Arabic localized fields via the configured translation provider
- Defers non-text/media fields
- Produces per-run JSON reports in `reports/`

## Prerequisites
- Node.js 24+
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
pnpm install
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

# Airtable settings
AIRTABLE_API_KEY=your_airtable_api_key
AIRTABLE_BASE_ID=your_airtable_base_id
AIRTABLE_TABLE_NAME=your_airtable_table_name
AIRTABLE_CONTENTFUL_URL_FIELD=contentful_url

# Local settings
MAPPING_PATH=your_mapping_file.json
IIIF_MAPPING_PATH=your_iiif_mapping_file.json
DEFAULT_LOCALE=en-US
AR_LOCALE=ar
```

## Commands

### Validate
Checks mapping, Airtable schema, Airtable connectivity, Contentful content type, and locales.
Shows a small live validation indicator unless progress is turned off.

```bash
pnpm run validate

# optional progress control
node src/import-cli.mjs validate --progress=off

# optional cap while testing
node src/import-cli.mjs validate --max 100
```

### Dry Run
Performs full processing without writing entries.
By default this only considers Airtable rows where `contentful_url` is empty.
Shows a live status bar with rows, status counts, and ETA.

```bash
pnpm run dry-run

# optional progress control
node src/import-cli.mjs dry-run --progress=auto

# optional cap while testing
node src/import-cli.mjs dry-run --max 100

# redo mode: process the full Airtable table and simulate overwrites
node src/import-cli.mjs dry-run --redo
```

### Apply
Creates missing entries as drafts.
By default this only processes Airtable rows where `contentful_url` is empty and writes the new Contentful app URL back to Airtable.
Shows a live status bar with rows, status counts, and ETA.

```bash
pnpm run apply

# optional progress control
node src/import-cli.mjs apply --progress=on

# optional cap while testing
node src/import-cli.mjs apply --max 100

# redo mode: process the full Airtable table and overwrite existing Contentful entries
node src/import-cli.mjs apply --redo
```

### Airtable List (Source Check)
Lists records from `AIRTABLE_TABLE_NAME` and prints these columns: `IAB Code`, `Title of Object`, `Description`.

```bash
# tab-separated output
pnpm run airtable:list

# JSON output
pnpm run airtable:list -- --json

# limit and optional view/formula
node src/airtable-list-cli.mjs --max 100 --view "Ready for Import"
node src/airtable-list-cli.mjs --filter-by-formula "{Ready for Import}=1"
```

### Airtable Export (Full Local Snapshot)
Pulls the full Airtable table, including all record fields and table schema, into a local JSON file for migration debugging.

```bash
# write a timestamped snapshot into reports/
pnpm run airtable:export

# custom output path
pnpm run airtable:export -- --output tmp/airtable-debug.json

# print to stdout instead of writing a file
pnpm run airtable:export -- --stdout-only

# optional filters while debugging
pnpm run airtable:export -- --view "Ready for Import"
pnpm run airtable:export -- --filter-by-formula "{Ready for Import}=1"
pnpm run airtable:export -- --max 100
```

Output includes:
- Airtable base/table metadata and active filters
- Full table field schema from Airtable metadata API
- Raw Airtable records exactly as returned by the records API

### Airtable -> Contentful Mapping Scaffold (Migration Step 1)
Connects to Airtable directly, reads Airtable column names, reads Contentful content type fields, and generates a mapping scaffold you can edit while field IDs are still changing.

```bash
# writes config/airtable-contentful-map.json
pnpm run airtable:map

# print only to stdout
pnpm run airtable:map -- --stdout-only --json

# optional filters when scanning fallback records
pnpm run airtable:map -- --view "Ready for Import" --sample-size 100
```

Notes:
- Uses Airtable metadata API first to get true table schema.
- Falls back to scanning Airtable records if metadata scope is unavailable.
- Suggested matches are marked with `confidence` (`high`, `medium`, `none`) and should be reviewed manually.

### Airtable Data Issues Check
Scans Airtable records for data quality issues before import.

Current checks:
- `IAB Code` contains multiple values separated by commas
- `IAB Code` contains `page` (case-insensitive)
- `Title of Object` length exceeds 255 characters (configurable)

```bash
# console summary only
pnpm run airtable:issues -- --max 200

# JSON output to stdout
pnpm run airtable:issues -- --max 200 --json

# write JSON report file in reports/
pnpm run airtable:issues -- --write-report --max 200

# custom title length threshold
pnpm run airtable:issues -- --title-max 255
```

### Humanize Reports
Builds a markdown summary focused on actionable errors from generated JSON reports.

```bash
# default: latest import report only
pnpm run humanize-reports

# include all import reports
pnpm run humanize-reports -- --all

# optional custom output path
pnpm run humanize-reports -- --all --output reports/human-readable-errors-all.md
```

### Export IIIF (Published Content Cache)
Exports published entries from Contentful Delivery API as IIIF Presentation API v3 manifests.

```bash
# incremental (default)
pnpm run export-iiif

# full rebuild
pnpm run export-iiif:full

# optional flags
pnpm src/export-iiif-cli.mjs --mode incremental --mapping config/iiif-mapping.json --output manifests
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
- Default mode: only Airtable rows where `contentful_url` is empty are processed
- Default mode existing entries: skipped
- `--redo`: ignores `contentful_url`, processes the full Airtable table, and updates existing Contentful entries when `iabCode` matches
- Successful `apply` writes the Contentful app URL into Airtable field `contentful_url` (or `AIRTABLE_CONTENTFUL_URL_FIELD`)
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
2. Import operator runs:
   - `npm run validate`
   - `npm run dry-run`
   - check `reports/import-<timestamp>.json` for:
     - `would_create` count is expected
     - no unexpected `skipped_missing_required` or `skipped_invalid_enum`
3. If dry-run is clean, import operator runs `npm run apply`.
4. Successful applies write the Contentful entry URL back to Airtable `contentful_url`.
5. Import operator updates Airtable rows to `Imported - Needs Arabic Review` and records `Imported At` if needed.
6. Arabic reviewer opens draft entries in Contentful and manually reviews all Arabic fields generated by the importer.
7. After corrections, reviewer marks the item `Arabic Reviewed` (in Airtable or a Contentful workflow field).
8. Publisher performs final QA (EN + AR + taxonomy + media + links) and publishes only approved entries.
9. Publisher marks status as `Published`.

### Review and Publish Guardrails
- Do not publish directly after import; imported entries contain machine-generated Arabic that requires human review.
- Treat `IAB Code` as immutable primary key. Changing it creates a new entry path.
- Default mode does not update existing Contentful entries.
- `--redo` updates existing Contentful entries matched by `iabCode`.
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

Use this file to add new Airtable->Contentful field mappings without changing importer code.

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
- `pnpm run humanize-reports` writes `reports/human-readable-errors.md` from the latest `import-*.json` file
- `pnpm run humanize-reports -- --all` includes all `import-*.json` files

Row statuses include:
- `would_create`
- `would_update`
- `created`
- `updated`
- `skipped_existing`
- `skipped_linked`
- `skipped_missing_required`
- `skipped_invalid_enum`
- `failed_translation`
- `failed_contentful`

## Security Scan (OSV)
Generate a known-vulnerability report for dependency lockfiles:

```bash
pnpm run security:osv
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

## Notes
- `validate` does not call translation APIs.
- `dry-run` and `apply` call the configured translation provider when Arabic values are missing and translation is configured.

## Troubleshooting

### `npm install` hangs or fails:

- check network access to npm registry and retry.
- delete any partial `node_modules` directory and run `npm install` again.

### Missing required `env/config` values:
- verify `.env` includes all required variables from `.env.example`.
- ensure `CONTENTFUL_MANAGEMENT_TOKEN` and provider auth config are present (`OLLAMA_BASE_URL` for ollama, API key for hosted providers).

### Contentful auth errors (`401`/`403`):
- confirm the PAT is a Content Management API token.
- confirm token has access to space `t7x0vaz0zty0` and environment `master`.

### `Locale not found in Contentful environment`:
- ensure `en-US` and `ar` locales exist in `master`.
- confirm `DEFAULT_LOCALE` and `AR_LOCALE` match Contentful locale codes exactly.

### `Field not found in content type`:
- confirm `CONTENTFUL_CONTENT_TYPE_ID=alMadarCsv`.
- compare `config/almadar-mapping.json` field IDs with Contentful field IDs.

### Airtable mapped field mismatch errors:
- verify Airtable field names match mapping strings exactly (including punctuation/trailing spaces).
- verify `contentful_url` exists in Airtable, or override the field name with `AIRTABLE_CONTENTFUL_URL_FIELD`.
- if Airtable schema changed, update `config/almadar-mapping.json`.

###  Too many rows skipped for invalid enum:
- check Airtable values for `category`, `gallery`, and `section`.
- values must match Contentful allowed values exactly (case-sensitive).

### Translation API errors / rate limits:
- verify provider API key is valid and has quota.
- verify `TRANSLATION_PROVIDER` is one of `ollama`, `openai`, `gemini`, `claude`.
- for Ollama, ensure daemon is running and model is installed: `ollama pull translategemma:latest`.
- retry the run; non-required localized translation failures are logged and rows continue.

### `apply` created nothing:
- run `dry-run` first and inspect `reports/import-<timestamp>.json`.
- rows may be skipped as linked (`contentful_url` already present), existing (`iabCode` already present), or failing validations.
