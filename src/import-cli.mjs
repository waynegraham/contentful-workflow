import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listAirtableRecords, listAirtableTableFields, updateAirtableRecord } from './airtable-client.mjs';

const MODE_VALIDATE = 'validate';
const MODE_DRY_RUN = 'dry-run';
const MODE_APPLY = 'apply';
const MODES = new Set([MODE_VALIDATE, MODE_DRY_RUN, MODE_APPLY]);
const SUPPORTED_TRANSLATION_PROVIDERS = new Set(['openai', 'gemini', 'claude', 'ollama']);
const SUPPORTED_PROGRESS_MODES = new Set(['auto', 'on', 'off']);

const NA_VALUES = new Set(['', 'n/a', 'na', 'null', '-']);

let mode;
let cliOptions;
let mappingPath;
let mapping;
let env;
let summary;
let translationCache;
let airtableFields;
let airtableRecords;
let processableRecords;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await loadDotenv();
  await initializeCliState(process.argv.slice(2));
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

async function loadDotenv() {
  try {
    const dotenv = await import('dotenv');
    dotenv.default?.config();
  } catch (_error) {
    // Ignore in test-only environments where dotenv is not installed.
  }
}

async function initializeCliState(args) {
  mode = args[0];
  if (!MODES.has(mode)) {
    console.error(
      'Usage: node src/import-cli.mjs <validate|dry-run|apply> [--mapping path] [--progress auto|on|off] [--max N] [--redo]'
    );
    process.exit(1);
  }

  cliOptions = parseCliOptions(args.slice(1));
  if (!SUPPORTED_PROGRESS_MODES.has(cliOptions.progress)) {
    console.error(`Invalid --progress value: ${cliOptions.progress}. Supported: auto, on, off`);
    process.exit(1);
  }

  mappingPath = cliOptions.mapping || process.env.MAPPING_PATH || 'config/almadar-mapping.json';
  mapping = readJson(mappingPath);

  env = {
    spaceId: process.env.CONTENTFUL_SPACE_ID || mapping.spaceId,
    envId: process.env.CONTENTFUL_ENV_ID || mapping.environmentId || 'master',
    contentTypeId: process.env.CONTENTFUL_CONTENT_TYPE_ID || mapping.contentTypeId,
    managementToken: process.env.CONTENTFUL_MANAGEMENT_TOKEN,
    airtableApiKey: process.env.AIRTABLE_API_KEY,
    airtableBaseId: process.env.AIRTABLE_BASE_ID,
    airtableTableName: process.env.AIRTABLE_TABLE_NAME,
    airtableContentfulUrlField:
      process.env.AIRTABLE_CONTENTFUL_URL_FIELD || mapping.airtable?.contentfulUrlField || 'contentful_url',
    translationProvider: String(
      process.env.TRANSLATION_PROVIDER || mapping.options?.translationProvider || 'openai'
    ).toLowerCase(),
    translationModel: process.env.TRANSLATION_MODEL || mapping.options?.translationModel || null,
    openaiApiKey: process.env.OPENAI_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    claudeApiKey: process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY,
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    defaultLocale: process.env.DEFAULT_LOCALE || mapping.locales?.default || 'en-US',
    arLocale: process.env.AR_LOCALE || mapping.locales?.target || 'ar'
  };
  env.translationModel = resolveTranslationModel(env.translationProvider, env.translationModel);

  summary = {
    mode,
    mappingPath,
    redo: cliOptions.redo,
    maxRecords: cliOptions.maxRecords ?? null,
    translation: {
      provider: env.translationProvider,
      model: env.translationModel
    },
    airtable: {
      baseId: env.airtableBaseId,
      tableName: env.airtableTableName,
      contentfulUrlField: env.airtableContentfulUrlField
    },
    totals: {
      rows: 0,
      created: 0,
      updated: 0,
      would_create: 0,
      would_update: 0,
      skipped_existing: 0,
      skipped_linked: 0,
      skipped_missing_required: 0,
      skipped_invalid_enum: 0,
      failed_validation: 0,
      failed_translation: 0,
      failed_contentful: 0
    },
    rows: []
  };

  translationCache = new Map();
}

async function main() {
  const validateProgress = createValidateProgress({
    mode,
    progressMode: cliOptions.progress,
    stream: process.stdout
  });

  validateProgress.start();
  validateProgress.step('Validating environment');
  validateEnvForMode(env, mode, mapping);

  validateProgress.step('Validating mapping');
  validateMappingShape(mapping);

  validateProgress.step('Loading Airtable schema');
  airtableFields = await listAirtableTableFields({
    apiKey: env.airtableApiKey,
    baseId: env.airtableBaseId,
    tableName: env.airtableTableName
  });

  validateProgress.step('Validating Airtable fields');
  validateAirtableFields(mapping, airtableFields, env.airtableContentfulUrlField);

  validateProgress.step('Loading Airtable records');
  airtableRecords = await listAirtableRecords({
    apiKey: env.airtableApiKey,
    baseId: env.airtableBaseId,
    tableName: env.airtableTableName,
    fields: null,
    maxRecords: cliOptions.maxRecords
  });
  processableRecords = selectProcessableRecords(airtableRecords, {
    mode,
    redo: cliOptions.redo,
    contentfulUrlField: env.airtableContentfulUrlField
  });
  summary.totals.rows = processableRecords.length;

  validateProgress.step('Connecting to Contentful');
  const cma = await createContentfulClient(env.managementToken);

  validateProgress.step('Loading content type and locales');
  const { environment, contentType, localesByCode, enumMap } = await loadContentfulContext(cma, env);

  validateProgress.step('Checking locales');
  ensureLocale(localesByCode, env.defaultLocale);
  ensureLocale(localesByCode, env.arLocale);
  validateProgress.finish('Validation checks complete');

  if (mode === MODE_VALIDATE) {
    console.log('Validation passed.');
    console.log(`Airtable records loaded: ${airtableRecords.length}`);
    console.log(`Rows to process: ${processableRecords.length}`);
    console.log(`Content type: ${contentType.sys.id}`);
    console.log(`Locales: ${env.defaultLocale}, ${env.arLocale}`);
    return;
  }

  const rowProgress = createRowProgress({
    mode,
    totalRows: processableRecords.length,
    progressMode: cliOptions.progress,
    stream: process.stdout
  });
  rowProgress.start();

  for (let i = 0; i < processableRecords.length; i += 1) {
    const airtableRecord = processableRecords[i];
    const rowNumber = i + 1;
    const row = normalizeRow(airtableRecord.fields || {});

    const status = await processRow({
      airtableRecord,
      row,
      rowNumber,
      mapping,
      env,
      mode,
      redo: cliOptions.redo,
      environment,
      contentType,
      enumMap,
      translationCache
    });

    summary.rows.push(status);
    summary.totals[status.status] = (summary.totals[status.status] || 0) + 1;
    rowProgress.tick(summary.totals, status.status);
  }
  rowProgress.finish(summary.totals);

  const reportPath = writeReport(summary);
  printSummary(summary, reportPath);
}

function parseCliOptions(argv) {
  const options = { progress: 'auto', redo: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--mapping' && argv[i + 1]) {
      options.mapping = argv[i + 1];
      i += 1;
      continue;
    }
    if (argv[i].startsWith('--progress=')) {
      options.progress = argv[i].slice('--progress='.length).toLowerCase();
      continue;
    }
    if (argv[i] === '--progress' && argv[i + 1]) {
      options.progress = String(argv[i + 1]).toLowerCase();
      i += 1;
      continue;
    }
    if (argv[i] === '--max' && argv[i + 1]) {
      options.maxRecords = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (argv[i].startsWith('--max=')) {
      options.maxRecords = Number.parseInt(argv[i].slice('--max='.length), 10);
      continue;
    }
    if (argv[i] === '--redo') {
      options.redo = true;
    }
  }
  return options;
}

function createValidateProgress({ mode, progressMode, stream }) {
  const enabled = progressMode !== 'off';
  const interactive = enabled && (progressMode === 'on' || (progressMode === 'auto' && stream.isTTY));
  const spinnerFrames = ['|', '/', '-', '\\'];
  const totalSteps = 6;
  let currentStep = 0;
  let spinnerIndex = 0;
  let timer = null;
  let lastMessage = 'Starting';
  let hasWritten = false;
  const clearLinePrefix = '\x1b[2K\r';

  function render() {
    if (!interactive) {
      return;
    }
    const frame = spinnerFrames[spinnerIndex % spinnerFrames.length];
    spinnerIndex += 1;
    const label = `[${mode}] ${frame} validate ${currentStep}/${totalSteps} ${lastMessage}`;
    stream.write(`${clearLinePrefix}${label}`);
    hasWritten = true;
  }

  return {
    start() {
      if (!enabled) {
        return;
      }
      if (interactive) {
        render();
        timer = setInterval(render, 120);
      } else {
        stream.write(`[${mode}] validating...\n`);
      }
    },
    step(message) {
      if (!enabled) {
        return;
      }
      currentStep = Math.min(currentStep + 1, totalSteps);
      lastMessage = message;
      if (interactive) {
        render();
      }
    },
    finish(message) {
      if (!enabled) {
        return;
      }
      if (timer) {
        clearInterval(timer);
      }
      if (interactive && hasWritten) {
        stream.write(`${clearLinePrefix}[${mode}] ✓ validate ${totalSteps}/${totalSteps} ${message}\n`);
      } else if (!interactive) {
        stream.write(`[${mode}] ${message}\n`);
      }
    }
  };
}

function createRowProgress({ mode, totalRows, progressMode, stream }) {
  const enabled = progressMode !== 'off';
  const interactive = enabled && (progressMode === 'on' || (progressMode === 'auto' && stream.isTTY));
  const startedAt = Date.now();
  let processedRows = 0;
  let nextLogThreshold = 1;
  const clearLinePrefix = '\x1b[2K\r';

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) {
      return '--:--';
    }
    const totalSeconds = Math.round(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function buildCounts(totals) {
    const short = [
      `would:${totals.would_create || 0}`,
      `wupd:${totals.would_update || 0}`,
      `created:${totals.created || 0}`,
      `updated:${totals.updated || 0}`,
      `exist:${totals.skipped_existing || 0}`,
      `linked:${totals.skipped_linked || 0}`,
      `req:${totals.skipped_missing_required || 0}`,
      `enum:${totals.skipped_invalid_enum || 0}`,
      `tr:${totals.failed_translation || 0}`,
      `cf:${totals.failed_contentful || 0}`
    ];
    return short.join(' ');
  }

  function render(totals) {
    if (!enabled || !interactive) {
      return;
    }
    const total = Math.max(totalRows, 1);
    const pct = Math.min(processedRows / total, 1);
    const width = 24;
    const filled = Math.round(width * pct);
    const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
    const elapsedMs = Date.now() - startedAt;
    const avgPerRow = processedRows > 0 ? elapsedMs / processedRows : 0;
    const etaMs = (totalRows - processedRows) * avgPerRow;
    const line = `[${mode}] [${bar}] ${processedRows}/${totalRows} ${Math.round(pct * 100)}% ETA ${fmtDuration(etaMs)} ${buildCounts(totals)}`;
    stream.write(`${clearLinePrefix}${line}`);
  }

  function maybeLogNonInteractive(totals, lastStatus) {
    if (!enabled || interactive) {
      return;
    }
    const ratio = totalRows > 0 ? processedRows / totalRows : 1;
    if (processedRows < nextLogThreshold && processedRows !== totalRows) {
      return;
    }
    const elapsedMs = Date.now() - startedAt;
    const avgPerRow = processedRows > 0 ? elapsedMs / processedRows : 0;
    const etaMs = (totalRows - processedRows) * avgPerRow;
    stream.write(
      `[${mode}] ${processedRows}/${totalRows} ${Math.round(ratio * 100)}% eta=${fmtDuration(etaMs)} last=${lastStatus} ${buildCounts(totals)}\n`
    );
    nextLogThreshold = Math.max(nextLogThreshold + 25, processedRows + 1);
  }

  return {
    start() {
      if (!enabled) {
        return;
      }
      if (interactive) {
        render({});
      } else {
        stream.write(`[${mode}] processing ${totalRows} rows...\n`);
      }
    },
    tick(totals, lastStatus) {
      processedRows += 1;
      render(totals);
      maybeLogNonInteractive(totals, lastStatus);
    },
    finish(totals) {
      if (!enabled) {
        return;
      }
      processedRows = totalRows;
      render(totals);
      if (interactive) {
        stream.write('\n');
      } else {
        stream.write(`[${mode}] done ${totalRows}/${totalRows}\n`);
      }
    }
  };
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function validateEnvForMode(currentEnv, currentMode, currentMapping) {
  const required = [
    'spaceId',
    'envId',
    'contentTypeId',
    'managementToken',
    'airtableApiKey',
    'airtableBaseId',
    'airtableTableName',
    'defaultLocale',
    'arLocale'
  ];
  const missing = required.filter((k) => !currentEnv[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required env/config values: ${missing.join(', ')}`);
  }

  const needsTranslation = currentMode !== MODE_VALIDATE && currentMapping.options?.translateMissingArabic;
  if (!SUPPORTED_TRANSLATION_PROVIDERS.has(currentEnv.translationProvider)) {
    throw new Error(
      `Unsupported TRANSLATION_PROVIDER: ${currentEnv.translationProvider}. Supported: ${Array.from(SUPPORTED_TRANSLATION_PROVIDERS).join(', ')}`
    );
  }

  if (needsTranslation) {
    if (providerRequiresApiKey(currentEnv.translationProvider)) {
      const providerKeyName = getProviderApiKeyEnvName(currentEnv.translationProvider);
      const providerApiKey = getProviderApiKey(currentEnv);
      if (!providerApiKey) {
        throw new Error(
          `${providerKeyName} is required for dry-run/apply when translateMissingArabic is enabled with provider "${currentEnv.translationProvider}".`
        );
      }
    }

    if (currentEnv.translationProvider === 'ollama' && !currentEnv.ollamaBaseUrl) {
      throw new Error(
        'OLLAMA_BASE_URL is required for dry-run/apply when translateMissingArabic is enabled with provider "ollama".'
      );
    }
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

function validateAirtableFields(currentMapping, fields, contentfulUrlField) {
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('Airtable schema returned no fields.');
  }

  const headers = new Set(fields.map((field) => field.name).filter(Boolean));
  const requiredHeaders = new Set([contentfulUrlField]);

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
    throw new Error(`Airtable missing mapped field(s): ${missing.join(', ')}`);
  }
}

function selectProcessableRecords(records, { mode: currentMode, redo, contentfulUrlField }) {
  if (currentMode === MODE_VALIDATE || redo) {
    return records;
  }

  return records.filter((record) => {
    const fields = record?.fields || {};
    return !hasValue(norm(fields[contentfulUrlField]));
  });
}

async function createContentfulClient(token) {
  const contentful = await import('contentful-management');
  return contentful.default.createClient({ accessToken: token });
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

async function updateContentfulEntry(entry, fields) {
  entry.fields = fields;
  return entry.update();
}

function buildContentfulEntryUrl({ spaceId, envId, entryId }) {
  return `https://app.contentful.com/spaces/${encodeURIComponent(spaceId)}/environments/${encodeURIComponent(envId)}/entries/${encodeURIComponent(entryId)}`;
}

function ensureLocale(localesByCode, code) {
  if (!localesByCode.has(code)) {
    throw new Error(`Locale not found in Contentful environment: ${code}`);
  }
}

async function processRow(ctx) {
  const {
    airtableRecord,
    row,
    rowNumber,
    mapping,
    env: currentEnv,
    mode: currentMode,
    redo,
    environment,
    contentType,
    enumMap,
    translationCache: cache
  } = ctx;

  const uniqueSourceColumn = mapping.idempotency?.sourceColumn || 'IAB Code';
  const uniqueFieldId = mapping.idempotency?.uniqueFieldId || 'iabCode';
  const iabCode = norm(row[uniqueSourceColumn]);
  const contentfulUrl = norm(row[currentEnv.airtableContentfulUrlField]);

  if (!iabCode) {
    return {
      rowNumber,
      airtableRecordId: airtableRecord?.id || null,
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
  const existingEntry = existing.items[0] || null;

  if (!redo && hasValue(contentfulUrl)) {
    return {
      rowNumber,
      airtableRecordId: airtableRecord?.id || null,
      iabCode,
      status: 'skipped_linked',
      missingRequired: [],
      errors: []
    };
  }

  if (!redo && existingEntry) {
    return {
      rowNumber,
      airtableRecordId: airtableRecord?.id || null,
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
    translationProvider: currentEnv.translationProvider,
    translationModel: currentEnv.translationModel,
    translationApiKey: getProviderApiKey(currentEnv),
    ollamaBaseUrl: currentEnv.ollamaBaseUrl,
    translationCache: cache
  });

  if (buildResult.enumErrors.length > 0) {
    return {
      rowNumber,
      airtableRecordId: airtableRecord?.id || null,
      iabCode,
      status: 'skipped_invalid_enum',
      missingRequired: [],
      errors: buildResult.enumErrors
    };
  }

  if (buildResult.missingRequired.length > 0) {
    return {
      rowNumber,
      airtableRecordId: airtableRecord?.id || null,
      iabCode,
      status: 'skipped_missing_required',
      missingRequired: buildResult.missingRequired,
      errors: buildResult.errors
    };
  }

  if (buildResult.requiredTranslationFailed) {
    return {
      rowNumber,
      airtableRecordId: airtableRecord?.id || null,
      iabCode,
      status: 'failed_translation',
      missingRequired: [],
      errors: buildResult.errors
    };
  }

  if (currentMode === MODE_DRY_RUN) {
    return {
      rowNumber,
      airtableRecordId: airtableRecord?.id || null,
      iabCode,
      status: existingEntry ? 'would_update' : 'would_create',
      missingRequired: [],
      errors: buildResult.errors
    };
  }

  try {
    const entry = existingEntry
      ? await updateContentfulEntry(existingEntry, buildResult.fields)
      : await environment.createEntry(contentType.sys.id, { fields: buildResult.fields });

    if (!existingEntry || redo) {
      const contentfulEntryUrl = buildContentfulEntryUrl({
        spaceId: currentEnv.spaceId,
        envId: currentEnv.envId,
        entryId: entry.sys.id
      });
      await updateAirtableRecord({
        apiKey: currentEnv.airtableApiKey,
        baseId: currentEnv.airtableBaseId,
        tableName: currentEnv.airtableTableName,
        recordId: airtableRecord.id,
        fields: {
          [currentEnv.airtableContentfulUrlField]: contentfulEntryUrl
        }
      });
    }

    return {
      rowNumber,
      airtableRecordId: airtableRecord?.id || null,
      iabCode,
      status: existingEntry ? 'updated' : 'created',
      entryId: entry.sys.id,
      missingRequired: [],
      errors: buildResult.errors
    };
  } catch (error) {
    return {
      rowNumber,
      airtableRecordId: airtableRecord?.id || null,
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
    translationProvider,
    translationModel,
    translationApiKey,
    ollamaBaseUrl,
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
    const staticValue = fieldMap.staticValue;
    const rawEn =
      staticValue && typeof staticValue === 'object' && !Array.isArray(staticValue)
        ? (staticValue[defaultLocale] ?? (enSource ? norm(row[enSource]) : null))
        : (staticValue ?? (enSource ? norm(row[enSource]) : null));
    const rawAr =
      staticValue && typeof staticValue === 'object' && !Array.isArray(staticValue)
        ? (staticValue[arLocale] ?? (arSource ? norm(row[arSource]) : null))
        : (arSource ? norm(row[arSource]) : null);

    let enValue = applyTransform(rawEn, fieldMap);
    let arValue = applyTransform(rawAr, fieldMap);

    if (fieldMap.localized) {
      if (shouldTranslateAr(arValue, fieldMap.ar?.mode) && hasValue(enValue)) {
        try {
          if (Array.isArray(enValue)) {
            arValue = [];
            for (const item of enValue) {
              // Translate array items separately for better glossary reuse.
              arValue.push(
                await translateToArabic({
                  text: item,
                  fieldId: fieldMap.fieldId,
                  provider: translationProvider,
                  model: translationModel,
                  apiKey: translationApiKey,
                  ollamaBaseUrl,
                  cache: translationCache
                })
              );
            }
          } else {
            arValue = await translateToArabic({
              text: enValue,
              fieldId: fieldMap.fieldId,
              provider: translationProvider,
              model: translationModel,
              apiKey: translationApiKey,
              ollamaBaseUrl,
              cache: translationCache
            });
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

  applyFootnoteLinking(fields, { defaultLocale, arLocale });

  return { fields, missingRequired, errors, enumErrors, requiredTranslationFailed };
}

function applyFootnoteLinking(fields, { defaultLocale, arLocale }) {
  const footnotesValues = fields.footnotes;
  const descriptionValues = fields.description;
  if (!footnotesValues || !descriptionValues) {
    return;
  }

  const localesToCheck = [defaultLocale, arLocale];
  const knownFootnotes = new Set();

  for (const locale of localesToCheck) {
    const text = footnotesValues[locale];
    if (typeof text !== 'string' || !text.trim()) {
      continue;
    }
    for (const number of extractFootnoteNumbers(text)) {
      knownFootnotes.add(number);
    }
    footnotesValues[locale] = formatFootnotes(text);
  }

  if (knownFootnotes.size === 0) {
    return;
  }

  for (const locale of localesToCheck) {
    const description = descriptionValues[locale];
    if (typeof description !== 'string' || !description.trim()) {
      continue;
    }
    descriptionValues[locale] = linkDescriptionFootnotes(description, knownFootnotes);
  }
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

function extractFootnoteNumbers(text) {
  const numbers = new Set();
  const matcher = /(^|\n)\s*(?:\*\*(\d+)\*\*\.\s*|\*\*(\d+)\.\*\*\s*|(\d+)\.\s*)/gm;
  for (const match of String(text).matchAll(matcher)) {
    const number = match[2] || match[3] || match[4];
    if (number) {
      numbers.add(number);
    }
  }
  return numbers;
}

function formatFootnotes(text) {
  return String(text).replace(
    /(^|\n)\s*(?:\*\*(\d+)\*\*\.\s*|\*\*(\d+)\.\*\*\s*|(\d+)\.\s*)/gm,
    (full, linePrefix, numberA, numberB, numberC) => {
      const number = numberA || numberB || numberC;
      const prefix = linePrefix || '';
      return `${prefix}<span class="footnote-ref" id="ref${number}">${number}</span> `;
    }
  );
}

function linkDescriptionFootnotes(description, availableFootnotes) {
  if (!availableFootnotes || availableFootnotes.size === 0) {
    return description;
  }

  const sorted = Array.from(availableFootnotes).sort((a, b) => Number(b) - Number(a));
  const numbersPattern = sorted.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const boldMarkerPattern = new RegExp(`(\\*\\*(${numbersPattern})\\*\\*)(?=(?:\\s|$))`, 'g');
  const linked = String(description).replace(boldMarkerPattern, (full, _bold, number) => {
    return `<sup><a href="#ref${number}">${number}</a></sup>`;
  });
  const markerPattern = new RegExp(`([.!?,;:)"'\\]»])\\s*(${numbersPattern})(?=(?:\\s|$))`, 'g');
  return linked.replace(markerPattern, (full, punctuation, number) => {
    return `${punctuation}<sup><a href="#ref${number}">${number}</a></sup>`;
  });
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

async function translateToArabic({ text, fieldId, provider, model, apiKey, ollamaBaseUrl, cache }) {
  if (providerRequiresApiKey(provider) && !apiKey) {
    throw new Error(`${getProviderApiKeyEnvName(provider)} missing`);
  }

  const normalizedText = String(text).trim();
  if (!normalizedText) {
    return null;
  }

  const cacheKey = hash(`${provider}::${model}::${fieldId}::${normalizedText}`);
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  let translated = null;
  if (provider === 'openai') {
    translated = await translateWithOpenAI({ text: normalizedText, model, apiKey });
  } else if (provider === 'gemini') {
    translated = await translateWithGemini({ text: normalizedText, model, apiKey });
  } else if (provider === 'claude') {
    translated = await translateWithClaude({ text: normalizedText, model, apiKey });
  } else if (provider === 'ollama') {
    translated = await translateWithOllama({ text: normalizedText, model, baseUrl: ollamaBaseUrl });
  } else {
    throw new Error(`Unsupported translation provider: ${provider}`);
  }

  if (!translated) {
    throw new Error(`${provider} returned empty translation output`);
  }

  cache.set(cacheKey, translated);
  return translated;
}

async function translateWithOpenAI({ text, model, apiKey }) {
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
          content: [{ type: 'input_text', text: translationSystemInstruction() }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: translationUserPrompt(text) }]
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return extractOpenAIText(data)?.trim() || null;
}

async function translateWithGemini({ text, model, apiKey }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: translationSystemInstruction() }]
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: translationUserPrompt(text) }]
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return extractGeminiText(data)?.trim() || null;
}

async function translateWithClaude({ text, model, apiKey }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: translationSystemInstruction(),
      messages: [{ role: 'user', content: translationUserPrompt(text) }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return extractClaudeText(data)?.trim() || null;
}

async function translateWithOllama({ text, model, baseUrl }) {
  const endpointBase = String(baseUrl || '').replace(/\/+$/, '');
  if (!endpointBase) {
    throw new Error('OLLAMA_BASE_URL missing');
  }

  const response = await fetch(`${endpointBase}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      prompt: `${translationSystemInstruction()}\n\n${translationUserPrompt(text)}`
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Ollama HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  if (typeof data.response === 'string') {
    return data.response.trim();
  }
  return null;
}

function translationSystemInstruction() {
  return 'You are a professional English (en) to Arabic (ar) translator. Your goal is to accurately convey the meaning and nuances of the original English text while adhering to Arabic grammar, vocabulary, and cultural sensitives. Produce only Arabic translation, without any additional explanations or commentary.';
}

function translationUserPrompt(text) {
  return `Translate the following: ${text}`;
}

function extractOpenAIText(responseJson) {
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

function extractGeminiText(responseJson) {
  for (const candidate of responseJson.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === 'string') {
        return part.text;
      }
    }
  }
  return null;
}

function extractClaudeText(responseJson) {
  for (const item of responseJson.content || []) {
    if (item.type === 'text' && typeof item.text === 'string') {
      return item.text;
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
  console.log(`Redo: ${currentSummary.redo ? 'yes' : 'no'}`);
  console.log(`Translation provider/model: ${currentSummary.translation.provider}/${currentSummary.translation.model}`);
  console.log(`Rows: ${currentSummary.totals.rows}`);
  console.log(`Would create: ${currentSummary.totals.would_create}`);
  console.log(`Would update: ${currentSummary.totals.would_update}`);
  console.log(`Created: ${currentSummary.totals.created}`);
  console.log(`Updated: ${currentSummary.totals.updated}`);
  console.log(`Skipped existing: ${currentSummary.totals.skipped_existing}`);
  console.log(`Skipped linked: ${currentSummary.totals.skipped_linked}`);
  console.log(`Skipped missing required: ${currentSummary.totals.skipped_missing_required}`);
  console.log(`Skipped invalid enum: ${currentSummary.totals.skipped_invalid_enum}`);
  console.log(`Failed translation: ${currentSummary.totals.failed_translation}`);
  console.log(`Failed contentful: ${currentSummary.totals.failed_contentful}`);
  console.log(`Report: ${reportPath}`);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function getProviderApiKey(currentEnv) {
  if (currentEnv.translationProvider === 'openai') {
    return currentEnv.openaiApiKey;
  }
  if (currentEnv.translationProvider === 'gemini') {
    return currentEnv.geminiApiKey;
  }
  if (currentEnv.translationProvider === 'claude') {
    return currentEnv.claudeApiKey;
  }
  if (currentEnv.translationProvider === 'ollama') {
    return null;
  }
  return null;
}

function getProviderApiKeyEnvName(provider) {
  if (provider === 'openai') {
    return 'OPENAI_API_KEY';
  }
  if (provider === 'gemini') {
    return 'GEMINI_API_KEY';
  }
  if (provider === 'claude') {
    return 'CLAUDE_API_KEY';
  }
  if (provider === 'ollama') {
    return 'N/A';
  }
  return 'API_KEY';
}

function providerRequiresApiKey(provider) {
  return provider !== 'ollama';
}

function resolveTranslationModel(provider, explicitModel) {
  if (explicitModel) {
    return explicitModel;
  }
  if (provider === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  }
  if (provider === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  }
  if (provider === 'claude') {
    return process.env.CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';
  }
  if (provider === 'ollama') {
    return process.env.OLLAMA_MODEL || 'translategemma:latest';
  }
  return 'gpt-4.1-mini';
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

export {
  applyTransform,
  buildContentfulEntryUrl,
  buildFields,
  extractFootnoteNumbers,
  findDuplicates,
  formatFootnotes,
  hasValue,
  linkDescriptionFootnotes,
  norm,
  normalizeDatePart,
  parseCliOptions,
  resolveTranslationModel,
  selectProcessableRecords,
  shouldTranslateAr,
  splitDateParts,
  toTitleCase,
  validateAirtableFields,
  validateEnvForMode,
  validateMappingShape
};
