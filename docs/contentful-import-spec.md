# Contentful Import Spec: alMadar CSV

## 1. Goal
Import `iab25-sample.csv` into Contentful content type `alMadarCsv` in space `t7x0vaz0zty0`, environment `master`, while:
- creating only missing entries (skip existing `iabCode`),
- auto-filling missing Arabic localized values using the configured translation provider,
- leaving created entries as drafts,
- logging rows with missing required fields.

## 2. Confirmed Constraints
- Locales: `en-US` (default), `ar` (fallback to `en-US` configured in Contentful).
- Content type already exists: `alMadarCsv`.
- Unique key for idempotency: CSV `IAB Code` -> field `iabCode` (unique in Contentful).
- Import behavior: insert missing only, do not update existing entries.
- Non-text/media ingestion: deferred.
- Publish behavior: do not publish.
- Mapping format: JSON in repo (`config/almadar-mapping.json`).
- Required-row logging: enabled for `iabCode`, `title`, `description`, `section`.
- Dry-run mode: required.

## 3. Data Flow
1. Read CSV with UTF-8 BOM support.
2. Normalize cells:
- trim whitespace,
- convert `N/A`, `NA`, empty strings to `null`.
3. Validate required source values for each row (`IAB Code`, title, description, section).
4. Resolve existing entry by `iabCode`.
5. If exists: log `skipped_existing` and continue.
6. If missing:
- map fields from JSON config,
- build localized values for `en-US` and `ar`,
- auto-translate `ar` when absent.
7. Validate target constraints (enum values such as `category`, `gallery`, `section`).
8. If `--dry-run`: log action `would_create` and do not write.
9. Else create draft entry in Contentful.
10. Emit report (`json` + optional `csv`) with row outcomes.

## 4. Translation Policy
- Provider: configurable (`ollama`, `openai`, `gemini`, `claude`).
- Trigger: localized field has `en-US` value and `ar` value is empty after checking mapped AR column.
- Output: Modern Standard Arabic, preserve proper nouns and codes (e.g. `IAB Code`, institution refs).
- Caching: translation cache keyed by (`fieldId`, English text hash) to reduce API calls and ensure consistency.
- Failure handling: if translation fails for required localized field (`title`, `description`), mark row failed and continue with next row.

## 5. CLI Modes
- `validate`:
- checks mapping JSON shape,
- verifies CSV headers,
- verifies Contentful content type and locale presence,
- performs no entry writes.
- `dry-run`:
- performs full transform/validation,
- checks existence by `iabCode`,
- outputs create/skip/fail plan.
- `apply`:
- identical to dry-run but creates missing entries as drafts.

## 6. Required Logging
For every row, record:
- row number,
- `iabCode` (if present),
- status: `created`, `would_create`, `skipped_existing`, `skipped_missing_required`, `failed_validation`, `failed_translation`, `failed_contentful`,
- status: `created`, `would_create`, `skipped_existing`, `skipped_missing_required`, `skipped_invalid_enum`, `failed_translation`, `failed_contentful`,
- missing required fields,
- validation errors,
- Contentful entry ID when created.

## 7. Contentful + Translation API Setup
Create a `.env` file with:

```env
CONTENTFUL_SPACE_ID=t7x0vaz0zty0
CONTENTFUL_ENV_ID=master
CONTENTFUL_CONTENT_TYPE_ID=alMadarCsv
CONTENTFUL_MANAGEMENT_TOKEN=<contentful_pat>
TRANSLATION_PROVIDER=ollama
TRANSLATION_MODEL=
OPENAI_API_KEY=<openai_api_key>
GEMINI_API_KEY=<gemini_api_key>
CLAUDE_API_KEY=<claude_api_key>
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=translategemma:latest
CSV_PATH=iab25-sample.csv
MAPPING_PATH=config/almadar-mapping.json
DEFAULT_LOCALE=en-US
AR_LOCALE=ar
```

### Contentful steps
1. In Contentful, create a Personal Access Token (CMA scope).
2. Confirm token has access to space `t7x0vaz0zty0`.
3. Confirm environment `master` includes locales `en-US` and `ar`.
4. Confirm content type ID is `alMadarCsv`.

## 8. Execution Sequence
1. Run `validate` until clean.
2. Run `dry-run` and inspect report counts.
3. Run `apply`.
4. Hand draft entries to editorial review/publish workflow.

## 9. Implementation Files
- `config/almadar-mapping.json` (completed)
- `src/import-cli.mjs` (CSV read, mapping, validation, translation, Contentful create)
- `package.json` (scripts + dependencies)
- `reports/import-<timestamp>.json`

## 10. Finalized Rules
- Date parsing:
- `hijriDate` = segment before `/`.
- `gregorianDate` = segment after `/`.
- Normalize long dashes (`–`, `—`) to `-` in parsed date output.
- Array parsing:
- split `material`, `curator`, and `writers` by comma and semicolon.
- normalize each item to Title Case.
- Translation failures:
- if translation fails on a non-required localized field, log the error and continue row creation.
- if translation fails on a required localized field (`title`, `description`), fail that row.
- Enum enforcement:
- if `category`, `gallery`, or `section` is outside allowed values, log the value and skip the row.
