import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import contentful from 'contentful-management';
import { parse as parseCsv } from 'csv-parse/sync';
import dotenv from 'dotenv';

dotenv.config();

const MODE_VALIDATE = 'validate';
const MODE_DRY_RUN = 'dry-run';
const MODE_APPLY = 'apply';
const MODES = new Set([MODE_VALIDATE, MODE_DRY_RUN, MODE_APPLY]);

const NA_VALUES = new Set(['', 'n/a', 'na', 'null', '-']);

const args = process.argv.slice(2);
const mode = args[0];
if (!MODES.has(mode)) {
  console.error('Usage: node src/import-cli.mjs <validate|dry-run|apply> [--csv path] [--mapping path]');
  process.exit(1);
}

const cliOptions = parseCliOptions(args.slice(1));

const mappingPath = cliOptions.mapping || process.env.MAPPING_PATH || 'config/almadar-mapping.json';
const csvPath = cliOptions.csv || process.env.CSV_PATH || 'iab25-sample.csv';

const mapping = readJson(mappingPath);
const csvRows = readCsv(csvPath);

const env = {
  spaceId: process.env.CONTENTFUL_SPACE_ID || mapping.spaceId,
  envId: process.env.CONTENTFUL_ENV_ID || mapping.environmentId || 'master',
  contentTypeId: process.env.CONTENTFUL_CONTENT_TYPE_ID || mapping.contentTypeId,
  managementToken: process.env.CONTENTFUL_MANAGEMENT_TOKEN,
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  defaultLocale: process.env.DEFAULT_LOCALE || mapping.locales?.default || 'en-US',
  arLocale: process.env.AR_LOCALE || mapping.locales?.target || 'ar'
};

const summary = {
  mode,
  csvPath,
  mappingPath,
  totals: {
    rows: csvRows.length,
    created: 0,
    would_create: 0,
    skipped_existing: 0,
    skipped_missing_required: 0,
    skipped_invalid_enum: 0,
    failed_validation: 0,
    failed_translation: 0,
    failed_contentful: 0
  },
  rows: []
};

const translationCache = new Map();

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});

async function main() {
  validateEnvForMode(env, mode, mapping);
  validateMappingShape(mapping);
  validateCsvHeaders(mapping, csvRows);

  const cma = createContentfulClient(env.managementToken);
  const { environment, contentType, localesByCode, enumMap } = await loadContentfulContext(cma, env);

  ensureLocale(localesByCode, env.defaultLocale);
  ensureLocale(localesByCode, env.arLocale);

  if (mode === MODE_VALIDATE) {
    console.log('Validation passed.');
    console.log(`Rows: ${csvRows.length}`);
    console.log(`Content type: ${contentType.sys.id}`);
    console.log(`Locales: ${env.defaultLocale}, ${env.arLocale}`);
    return;
  }

  for (let i = 0; i < csvRows.length; i += 1) {
    const rowNumber = i + 2;
    const row = normalizeRow(csvRows[i]);

    const status = await processRow({
      row,
      rowNumber,
      mapping,
      env,
      mode,
      environment,
      contentType,
      enumMap,
      translationCache
    });

    summary.rows.push(status);
    summary.totals[status.status] = (summary.totals[status.status] || 0) + 1;
  }

  const reportPath = writeReport(summary);
  printSummary(summary, reportPath);
}

function parseCliOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--csv' && argv[i + 1]) {
      options.csv = argv[i + 1];
      i += 1;
      continue;
    }
    if (argv[i] === '--mapping' && argv[i + 1]) {
      options.mapping = argv[i + 1];
      i += 1;
    }
  }
  return options;
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  return parseCsv(raw, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true
  });
}

function validateEnvForMode(currentEnv, currentMode, currentMapping) {
  const required = ['spaceId', 'envId', 'contentTypeId', 'managementToken', 'defaultLocale', 'arLocale'];
  const missing = required.filter((k) => !currentEnv[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env/config values: ${missing.join(', ')}`);
  }

  const needsTranslation = currentMode !== MODE_VALIDATE && currentMapping.options?.translateMissingArabic;
  if (needsTranslation && !currentEnv.openaiApiKey) {
    throw new Error('OPENAI_API_KEY is required for dry-run/apply when translateMissingArabic is enabled.');
  }
}

function validateMappingShape(currentMapping) {
  if (!currentMapping || !Array.isArray(currentMapping.fieldMappings)) {
    throw new Error('Invalid mapping: fieldMappings array is required.');
  }

  const duplicateIds = findDuplicates(currentMapping.fieldMappings.map((f) => f.fieldId));
  if (duplicateIds.length > 0) {
    throw new Error(`Invalid mapping: duplicate fieldId values: ${duplicateIds.join(', ')}`);
  }
}

function validateCsvHeaders(currentMapping, rows) {
  if (rows.length === 0) {
    throw new Error('CSV has no data rows.');
  }

  const headers = new Set(Object.keys(rows[0]));
  const requiredHeaders = new Set();

  for (const field of currentMapping.fieldMappings) {
    const source = field.source || {};
    for (const key of Object.keys(source)) {
      requiredHeaders.add(source[key]);
    }
  }

  const missing = [];
  for (const header of requiredHeaders) {
    if (!headers.has(header)) {
      missing.push(header);
    }
  }

  if (missing.length > 0) {
    throw new Error(`CSV missing mapped header(s): ${missing.join(', ')}`);
  }
}

function createContentfulClient(token) {
  return contentful.createClient({ accessToken: token });
}

async function loadContentfulContext(client, currentEnv) {
  const space = await client.getSpace(currentEnv.spaceId);
  const environment = await space.getEnvironment(currentEnv.envId);

  const [contentType, localesCollection] = await Promise.all([
    environment.getContentType(currentEnv.contentTypeId),
    environment.getLocales()
  ]);

  const localesByCode = new Map();
  for (const locale of localesCollection.items) {
    localesByCode.set(locale.code, locale);
  }

  const enumMap = new Map();
  for (const field of contentType.fields || []) {
    const inValidation = (field.validations || []).find((v) => Array.isArray(v.in));
    if (inValidation) {
      enumMap.set(field.id, new Set(inValidation.in));
    }
  }

  return { environment, contentType, localesByCode, enumMap };
}

function ensureLocale(localesByCode, code) {
  if (!localesByCode.has(code)) {
    throw new Error(`Locale not found in Contentful environment: ${code}`);
  }
}

async function processRow(ctx) {
  const {
    row,
    rowNumber,
    mapping,
    env: currentEnv,
    mode: currentMode,
    environment,
    contentType,
    enumMap,
    translationCache: cache
  } = ctx;

  const uniqueSourceColumn = mapping.idempotency?.sourceColumn || 'IAB Code';
  const uniqueFieldId = mapping.idempotency?.uniqueFieldId || 'iabCode';
  const iabCode = norm(row[uniqueSourceColumn]);

  if (!iabCode) {
    return {
      rowNumber,
      iabCode: null,
      status: 'skipped_missing_required',
      missingRequired: [uniqueSourceColumn],
      errors: []
    };
  }

  const existing = await environment.getEntries({
    content_type: contentType.sys.id,
    [`fields.${uniqueFieldId}`]: iabCode,
    limit: 1
  });

  if (existing.items.length > 0) {
    return {
      rowNumber,
      iabCode,
      status: 'skipped_existing',
      missingRequired: [],
      errors: []
    };
  }

  const buildResult = await buildFields({
    row,
    mapping,
    contentType,
    enumMap,
    defaultLocale: currentEnv.defaultLocale,
    arLocale: currentEnv.arLocale,
    openaiApiKey: currentEnv.openaiApiKey,
    openaiModel: currentEnv.openaiModel,
    translationCache: cache
  });

  if (buildResult.enumErrors.length > 0) {
    return {
      rowNumber,
      iabCode,
      status: 'skipped_invalid_enum',
      missingRequired: [],
      errors: buildResult.enumErrors
    };
  }

  if (buildResult.missingRequired.length > 0) {
    return {
      rowNumber,
      iabCode,
      status: 'skipped_missing_required',
      missingRequired: buildResult.missingRequired,
      errors: buildResult.errors
    };
  }

  if (buildResult.requiredTranslationFailed) {
    return {
      rowNumber,
      iabCode,
      status: 'failed_translation',
      missingRequired: [],
      errors: buildResult.errors
    };
  }

  if (currentMode === MODE_DRY_RUN) {
    return {
      rowNumber,
      iabCode,
      status: 'would_create',
      missingRequired: [],
      errors: buildResult.errors
    };
  }

  try {
    const entry = await environment.createEntry(contentType.sys.id, { fields: buildResult.fields });
    return {
      rowNumber,
      iabCode,
      status: 'created',
      entryId: entry.sys.id,
      missingRequired: [],
      errors: buildResult.errors
    };
  } catch (error) {
    return {
      rowNumber,
      iabCode,
      status: 'failed_contentful',
      missingRequired: [],
      errors: [error.message]
    };
  }
}

async function buildFields(ctx) {
  const {
    row,
    mapping,
    contentType,
    enumMap,
    defaultLocale,
    arLocale,
    openaiApiKey,
    openaiModel,
    translationCache
  } = ctx;

  const fields = {};
  const missingRequired = [];
  const errors = [];
  const enumErrors = [];
  let requiredTranslationFailed = false;

  const requiredFieldIds = new Set(
    (contentType.fields || []).filter((f) => f.required).map((f) => f.id)
  );

  for (const fieldMap of mapping.fieldMappings) {
    const contentField = contentType.fields.find((f) => f.id === fieldMap.fieldId);
    if (!contentField) {
      errors.push(`Field not found in content type: ${fieldMap.fieldId}`);
      continue;
    }

    const enSource = fieldMap.source?.[defaultLocale];
    const arSource = fieldMap.source?.[arLocale];

    const rawEn = enSource ? norm(row[enSource]) : null;
    const rawAr = arSource ? norm(row[arSource]) : null;

    let enValue = applyTransform(rawEn, fieldMap);
    let arValue = applyTransform(rawAr, fieldMap);

    if (fieldMap.localized) {
      if (shouldTranslateAr(arValue, fieldMap.ar?.mode) && hasValue(enValue)) {
        try {
          if (Array.isArray(enValue)) {
            arValue = [];
            for (const item of enValue) {
              // Translate array items separately for better glossary reuse.
              arValue.push(await translateToArabic(item, fieldMap.fieldId, openaiApiKey, openaiModel, translationCache));
            }
          } else {
            arValue = await translateToArabic(enValue, fieldMap.fieldId, openaiApiKey, openaiModel, translationCache);
          }
        } catch (error) {
          const required = requiredFieldIds.has(fieldMap.fieldId);
          errors.push(`Translation failed for ${fieldMap.fieldId}: ${error.message}`);
          if (required) {
            requiredTranslationFailed = true;
          }
        }
      }

      const localizedValues = {};
      if (hasValue(enValue)) {
        localizedValues[defaultLocale] = enValue;
      }
      if (hasValue(arValue)) {
        localizedValues[arLocale] = arValue;
      }

      if (Object.keys(localizedValues).length > 0) {
        fields[fieldMap.fieldId] = localizedValues;
      }
    } else if (hasValue(enValue)) {
      fields[fieldMap.fieldId] = { [defaultLocale]: enValue };
    }

    const valueForEnum = fields[fieldMap.fieldId]?.[defaultLocale];
    const allowed = enumMap.get(fieldMap.fieldId);
    if (allowed && hasValue(valueForEnum) && !allowed.has(valueForEnum)) {
      enumErrors.push(
        `${fieldMap.fieldId} has invalid value \"${valueForEnum}\". Allowed: ${Array.from(allowed).join(', ')}`
      );
    }
  }

  for (const requiredFieldId of requiredFieldIds) {
    const value = fields[requiredFieldId]?.[defaultLocale];
    if (!hasValue(value)) {
      missingRequired.push(requiredFieldId);
    }
  }

  return { fields, missingRequired, errors, enumErrors, requiredTranslationFailed };
}

function applyTransform(input, fieldMap) {
  if (!hasValue(input)) {
    return null;
  }

  if (fieldMap.transform === 'parse_hijri_from_date') {
    const [left] = splitDateParts(input);
    return left;
  }

  if (fieldMap.transform === 'parse_gregorian_from_date') {
    const [, right] = splitDateParts(input);
    return right;
  }

  if (fieldMap.transform === 'split_to_array') {
    const delimiters = Array.isArray(fieldMap.arrayDelimiters)
      ? fieldMap.arrayDelimiters
      : [fieldMap.arrayDelimiter || ','];

    const escaped = delimiters.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const splitter = new RegExp(`[${escaped.join('')}]`);

    const items = String(input)
      .split(splitter)
      .map((x) => norm(x))
      .filter(Boolean)
      .map((x) => (fieldMap.arrayItemCase === 'title' ? toTitleCase(x) : x));

    return items.length > 0 ? items : null;
  }

  return input;
}

function splitDateParts(value) {
  const [leftRaw, rightRaw] = String(value).split('/', 2);
  const left = normalizeDatePart(leftRaw);
  const right = normalizeDatePart(rightRaw);
  return [left, right];
}

function normalizeDatePart(part) {
  if (!part) {
    return null;
  }
  return part.replace(/[–—]/g, '-').trim() || null;
}

function toTitleCase(value) {
  return String(value)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function shouldTranslateAr(arValue, modeValue) {
  if (!modeValue) {
    return false;
  }
  if (!modeValue.includes('translate')) {
    return false;
  }
  return !hasValue(arValue);
}

async function translateToArabic(text, fieldId, apiKey, model, cache) {
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY missing');
  }

  const normalizedText = String(text).trim();
  if (!normalizedText) {
    return null;
  }

  const cacheKey = hash(`${fieldId}::${normalizedText}`);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: 'Translate to Modern Standard Arabic. Preserve proper nouns, references, and identifiers.' }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: normalizedText }]
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const translated = extractText(data)?.trim();
  if (!translated) {
    throw new Error('OpenAI returned empty translation output');
  }

  cache.set(cacheKey, translated);
  return translated;
}

function extractText(responseJson) {
  if (typeof responseJson.output_text === 'string') {
    return responseJson.output_text;
  }

  for (const outputItem of responseJson.output || []) {
    for (const contentItem of outputItem.content || []) {
      if (typeof contentItem.text === 'string') {
        return contentItem.text;
      }
    }
  }

  return null;
}

function normalizeRow(row) {
  const output = {};
  for (const [key, value] of Object.entries(row)) {
    output[key] = norm(value);
  }
  return output;
}

function norm(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = String(value).trim();
  if (NA_VALUES.has(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

function hasValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value !== null && value !== undefined && value !== '';
}

function writeReport(currentSummary) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join('reports', `import-${timestamp}.json`);
  fs.mkdirSync('reports', { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(currentSummary, null, 2)}\n`, 'utf8');
  return reportPath;
}

function printSummary(currentSummary, reportPath) {
  console.log(`Mode: ${currentSummary.mode}`);
  console.log(`Rows: ${currentSummary.totals.rows}`);
  console.log(`Would create: ${currentSummary.totals.would_create}`);
  console.log(`Created: ${currentSummary.totals.created}`);
  console.log(`Skipped existing: ${currentSummary.totals.skipped_existing}`);
  console.log(`Skipped missing required: ${currentSummary.totals.skipped_missing_required}`);
  console.log(`Skipped invalid enum: ${currentSummary.totals.skipped_invalid_enum}`);
  console.log(`Failed translation: ${currentSummary.totals.failed_translation}`);
  console.log(`Failed contentful: ${currentSummary.totals.failed_contentful}`);
  console.log(`Report: ${reportPath}`);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function findDuplicates(values) {
  const seen = new Set();
  const dupes = new Set();
  for (const value of values) {
    if (seen.has(value)) {
      dupes.add(value);
    }
    seen.add(value);
  }
  return Array.from(dupes);
}
