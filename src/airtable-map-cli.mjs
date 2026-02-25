import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { listAirtableRecords, listAirtableTableFields } from './airtable-client.mjs';

const DEFAULT_OUTPUT_PATH = 'config/airtable-contentful-map.json';
const DEFAULT_SAMPLE_SIZE = 50;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await loadDotenv();

  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
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

async function main() {
  const options = parseMapCliOptions(process.argv.slice(2));
  const env = resolveEnv(options);

  const airtableResult = await loadAirtableColumns({
    apiKey: env.airtableApiKey,
    baseId: env.airtableBaseId,
    tableName: env.airtableTableName,
    view: options.view,
    filterByFormula: options.filterByFormula,
    sampleSize: options.sampleSize
  });

  const contentfulFields = options.skipContentful ? [] : await loadContentfulFields(env);
  const mappings = buildSuggestedMappings(airtableResult.columns, contentfulFields);

  const output = {
    version: 1,
    generatedAt: new Date().toISOString(),
    airtable: {
      baseId: env.airtableBaseId,
      tableName: env.airtableTableName,
      source: airtableResult.source,
      columns: airtableResult.columns
    },
    contentful: {
      spaceId: env.spaceId || null,
      environmentId: env.environmentId || null,
      contentTypeId: env.contentTypeId || null,
      fields: contentfulFields
    },
    mappings
  };

  if (options.outputPath) {
    const destinationPath = path.resolve(options.outputPath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(`Wrote mapping scaffold: ${destinationPath}`);
  }

  if (options.json || !options.outputPath) {
    console.log(JSON.stringify(output, null, 2));
  }
}

export function parseMapCliOptions(argv) {
  const options = {
    outputPath: DEFAULT_OUTPUT_PATH,
    sampleSize: DEFAULT_SAMPLE_SIZE,
    json: false,
    skipContentful: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--output' && argv[i + 1]) {
      options.outputPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      options.outputPath = arg.slice('--output='.length);
      continue;
    }
    if (arg === '--stdout-only') {
      options.outputPath = null;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--skip-contentful') {
      options.skipContentful = true;
      continue;
    }
    if (arg === '--table' && argv[i + 1]) {
      options.tableName = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--table=')) {
      options.tableName = arg.slice('--table='.length);
      continue;
    }
    if (arg === '--content-type' && argv[i + 1]) {
      options.contentTypeId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--content-type=')) {
      options.contentTypeId = arg.slice('--content-type='.length);
      continue;
    }
    if (arg === '--sample-size' && argv[i + 1]) {
      options.sampleSize = clampInt(argv[i + 1], 1, 100, DEFAULT_SAMPLE_SIZE);
      i += 1;
      continue;
    }
    if (arg.startsWith('--sample-size=')) {
      options.sampleSize = clampInt(arg.slice('--sample-size='.length), 1, 100, DEFAULT_SAMPLE_SIZE);
      continue;
    }
    if (arg === '--view' && argv[i + 1]) {
      options.view = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--view=')) {
      options.view = arg.slice('--view='.length);
      continue;
    }
    if (arg === '--filter-by-formula' && argv[i + 1]) {
      options.filterByFormula = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--filter-by-formula=')) {
      options.filterByFormula = arg.slice('--filter-by-formula='.length);
      continue;
    }
    if (arg === '--space' && argv[i + 1]) {
      options.spaceId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--space=')) {
      options.spaceId = arg.slice('--space='.length);
      continue;
    }
    if (arg === '--environment' && argv[i + 1]) {
      options.environmentId = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--environment=')) {
      options.environmentId = arg.slice('--environment='.length);
      continue;
    }
  }

  return options;
}

export async function loadAirtableColumns(options) {
  try {
    const fields = await listAirtableTableFields({
      apiKey: options.apiKey,
      baseId: options.baseId,
      tableName: options.tableName
    });

    return {
      source: 'airtable-metadata',
      columns: fields.map((field) => field.name).filter(Boolean)
    };
  } catch (schemaError) {
    const records = await listAirtableRecords({
      apiKey: options.apiKey,
      baseId: options.baseId,
      tableName: options.tableName,
      fields: null,
      maxRecords: options.sampleSize,
      view: options.view,
      filterByFormula: options.filterByFormula
    });

    const columns = inferColumnsFromRecords(records);
    if (columns.length === 0) {
      throw new Error(
        `Unable to load Airtable columns from metadata or records (${schemaError.message}). Ensure the table has at least one row.`
      );
    }

    return {
      source: 'record-scan-fallback',
      columns
    };
  }
}

async function loadContentfulFields(env) {
  const managementToken = required(env.managementToken, 'CONTENTFUL_MANAGEMENT_TOKEN');
  const spaceId = required(env.spaceId, 'CONTENTFUL_SPACE_ID');
  const environmentId = required(env.environmentId, 'CONTENTFUL_ENV_ID');
  const contentTypeId = required(env.contentTypeId, 'CONTENTFUL_CONTENT_TYPE_ID');

  const contentful = await import('contentful-management');
  const client = contentful.default.createClient({ accessToken: managementToken });
  const space = await client.getSpace(spaceId);
  const environment = await space.getEnvironment(environmentId);
  const contentType = await environment.getContentType(contentTypeId);

  const fields = Array.isArray(contentType?.fields) ? contentType.fields : [];
  return fields.map((field) => {
    return {
      id: field.id,
      name: field.name || null,
      type: field.type || null,
      localized: Boolean(field.localized),
      required: Boolean(field.required)
    };
  });
}

export function inferColumnsFromRecords(records) {
  const discovered = new Set();
  for (const record of records) {
    const keys = Object.keys(record?.fields || {});
    for (const key of keys) {
      const normalized = normalizeOptionalString(key);
      if (normalized) {
        discovered.add(normalized);
      }
    }
  }
  return Array.from(discovered);
}

export function buildSuggestedMappings(airtableColumns, contentfulFields) {
  const normalizedFields = contentfulFields.map((field) => {
    return {
      id: field.id,
      name: field.name || '',
      normId: normalizeForMatch(field.id),
      normName: normalizeForMatch(field.name || '')
    };
  });

  return airtableColumns.map((airtableField) => {
    const normAirtable = normalizeForMatch(airtableField);
    const exactId = normalizedFields.find((field) => field.normId && field.normId === normAirtable);
    const exactName = normalizedFields.find((field) => field.normName && field.normName === normAirtable);
    const partial = normalizedFields.find((field) => {
      if (!normAirtable) {
        return false;
      }
      if (field.normName && field.normName.length >= 4) {
        return normAirtable.includes(field.normName) || field.normName.includes(normAirtable);
      }
      return false;
    });

    let candidate = null;
    let confidence = 'none';

    if (exactId) {
      candidate = exactId;
      confidence = 'high';
    } else if (exactName) {
      candidate = exactName;
      confidence = 'high';
    } else if (partial) {
      candidate = partial;
      confidence = 'medium';
    }

    return {
      airtableField,
      contentfulFieldId: candidate?.id || null,
      confidence
    };
  });
}

function resolveEnv(options) {
  return {
    airtableApiKey: process.env.AIRTABLE_API_KEY,
    airtableBaseId: process.env.AIRTABLE_BASE_ID,
    airtableTableName: options.tableName || process.env.AIRTABLE_TABLE_NAME,
    managementToken: process.env.CONTENTFUL_MANAGEMENT_TOKEN,
    spaceId: options.spaceId || process.env.CONTENTFUL_SPACE_ID,
    environmentId: options.environmentId || process.env.CONTENTFUL_ENV_ID || 'master',
    contentTypeId: options.contentTypeId || process.env.CONTENTFUL_CONTENT_TYPE_ID
  };
}

function required(value, envName) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${envName} is required`);
  }
  return normalized;
}

function normalizeForMatch(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return '';
  }
  return normalized.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeOptionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const str = String(value).trim();
  return str === '' ? null : str;
}

function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}
