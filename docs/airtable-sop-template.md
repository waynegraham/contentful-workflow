# Airtable SOP Template (Copy/Paste)

Use this SOP to run the Airtable -> Contentful workflow with this importer.

## 1. Purpose
Create English-first records in Airtable, import only net-new items into Contentful drafts, review Arabic, then publish after QA.

## 2. Scope
- Source system: Airtable
- Import system: this repo (`npm run validate`, `npm run dry-run`, `npm run apply`)
- Target CMS: Contentful (`alMadarCsv` content type)

## 3. Roles and Owners
- Catalog Editor: creates and updates English source rows.
- Import Operator: exports CSV and runs importer commands.
- Arabic Reviewer: reviews and corrects Arabic fields in Contentful drafts.
- Publisher: approves final QA and publishes.

## 4. Airtable Base Setup
Create a table named `Content Intake` with these fields:

| Field Name | Type | Required | Notes |
| --- | --- | --- | --- |
| IAB Code | Single line text | Yes | Must be unique and immutable |
| Title of Object | Single line text | Yes | Maps to Contentful `title` (en-US) |
| Description | Long text | Yes | Maps to Contentful `description` (en-US) |
| Workflow Status | Single select | Yes | Values listed below |
| Ready for Import | Formula | Yes | Formula shown below |
| Imported At | Date with time | No | Set after successful apply |
| Contentful Entry ID | Single line text | No | Optional tracking field |
| Import Batch ID | Single line text | No | Optional run identifier |
| Import Notes | Long text | No | Notes from import/report review |
| Arabic Review Owner | Collaborator | No | Person responsible for AR QA |
| Arabic Reviewed At | Date with time | No | Set when AR review complete |
| Publish Approved By | Collaborator | No | Final approver |
| Published At | Date with time | No | Set after publish |

## 5. Workflow Status Values
Set `Workflow Status` single-select options to:
- `Draft EN`
- `Ready for Import`
- `Imported - Needs Arabic Review`
- `Arabic Reviewed`
- `Ready to Publish`
- `Published`
- `Blocked`

## 6. Airtable Formula (Copy/Paste)
Set `Ready for Import` formula to:

```text
IF(
  AND(
    {Workflow Status}="Ready for Import",
    LEN(TRIM({IAB Code}&""))>0,
    LEN(TRIM({Title of Object}&""))>0,
    LEN(TRIM({Description}&""))>0
  ),
  "Yes",
  "No"
)
```

## 7. Recommended Views
Create these Airtable views:

- `01 Ready for Import`
  - Filter: `Ready for Import = "Yes"`
  - Sort: `IAB Code` ascending
- `02 Imported - Needs Arabic Review`
  - Filter: `Workflow Status = "Imported - Needs Arabic Review"`
- `03 Ready to Publish`
  - Filter: `Workflow Status = "Ready to Publish"`
- `04 Blocked`
  - Filter: `Workflow Status = "Blocked"`

## 8. Airtable CSV Export Checklist
Run this checklist before each export:

1. Export source view is `01 Ready for Import` (not the full table).
2. Only rows with `Ready for Import = "Yes"` are included.
3. CSV format is selected (not Excel).
4. Header row is included.
5. Header names exactly match mapping values (case, punctuation, and spacing).
6. Required source fields are populated for all exported rows:
   - `IAB Code`
   - `Title of Object`
   - `Description`
7. No duplicate `IAB Code` values exist in the export batch.
8. Save export with a batch-style filename, for example: `airtable-export-YYYY-MM-DD.csv`.
9. Set `CSV_PATH` in `.env` (or pass `--csv`) to this exported file before running importer commands.

Mapped headers expected by current config:

```text
AlMadar Thematic Sub-Section
AlMadar Thematic Sub-Section (AR)
Category of Work
Credit Line
Curator(s)
Curator(s) (AR)
Date
Description
Dimension
Extra Contemporary Artwork Information (Artist Biography for the Islamic Arts Biennale)
Extra Manuscript Description (endowment, author, calligrapher, page layout,etc)
Extra Object Related Information (maker, inscription, annotation, etc)
Footnote reference
Gallery
Gallery Presentation No.
IAB Code
Image Credit
Institution Ref. No.
Island Essay Footnote
Island Specific Essay
Lending Institution
Lending Institution (AR)
Loaning Nation
Loaning Nation (AR)
Material
Opening Folio No. On Display
Origin
Section
Title of Object
Weight
Writer(s)
Writer(s) (AR)
```

Pre-flight check command:

```bash
npm run validate
```

If `validate` reports missing headers, fix Airtable column names and export again.
Note: mapping currently expects `Island Specific Essay ` with one trailing space.

## 9. Operating Procedure
1. Catalog Editor populates required English fields.
2. Catalog Editor sets `Workflow Status` to `Ready for Import`.
3. Import Operator exports CSV from `01 Ready for Import`.
4. Import Operator runs:
   - `npm run validate`
   - `npm run dry-run`
5. Import Operator reviews `reports/import-<timestamp>.json`:
   - expected `would_create` count
   - no unexpected `skipped_missing_required`
   - no unexpected `skipped_invalid_enum`
6. If clean, Import Operator runs `npm run apply`.
7. For successfully created rows:
   - set `Workflow Status` to `Imported - Needs Arabic Review`
   - set `Imported At` timestamp
   - optionally set `Import Batch ID` and `Contentful Entry ID`
8. Arabic Reviewer reviews/corrects Arabic in Contentful drafts.
9. After Arabic QA:
   - set `Workflow Status` to `Arabic Reviewed`
   - set `Arabic Reviewed At`
10. Publisher runs final QA and sets:
   - `Workflow Status` to `Ready to Publish`
   - publish in Contentful
   - `Workflow Status` to `Published`
   - set `Published At`

## 10. QA Checklist (Before Publish)
- English title/description are approved.
- Arabic title/description are human-reviewed.
- `category`, `gallery`, and `section` are valid.
- Entry is correct and complete in Contentful draft.
- Item is approved by publisher.

## 11. Exception Handling
- Missing required fields:
  - Set `Workflow Status` to `Blocked`
  - Add issue in `Import Notes`
- Invalid enum (`category`, `gallery`, `section`):
  - Set `Workflow Status` to `Blocked`
  - Correct source value and retry next batch
- Existing `IAB Code` skipped:
  - Expected for already imported records
  - Update directly in Contentful if edits are needed (importer is insert-only)
- Translation errors:
  - Review report row errors
  - Retry run or manually complete Arabic fields in Contentful

## 12. Batch Log Template (Copy/Paste)
Use this per import run in your project tracker:

```text
Batch ID:
CSV Export Date:
Operator:
Rows in CSV:
Dry-Run would_create:
Dry-Run skipped_existing:
Dry-Run skipped_missing_required:
Dry-Run skipped_invalid_enum:
Apply created:
Apply failed_translation:
Apply failed_contentful:
Report file:
Notes / follow-ups:
```
