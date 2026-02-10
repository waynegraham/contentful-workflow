import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODE_INCREMENTAL = 'incremental';
const MODE_FULL = 'full';
const MODES = new Set([MODE_INCREMENTAL, MODE_FULL]);
const DEFAULT_MAPPING_PATH = 'config/iiif-mapping.json';
const DEFAULT_OUTPUT_DIR = 'manifests';
const DEFAULT_LIMIT = 1000;
const ALLOWED_DELIVERY_HOSTS = new Set(['cdn.contentful.com', 'preview.contentful.com']);

const args = process.argv.slice(2);
const cliOptions = parseCliOptions(args);
const mode = cliOptions.mode || MODE_INCREMENTAL;

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await loadDotenv();

  if (!MODES.has(mode)) {
    console.error('Usage: node src/export-iiif-cli.mjs [--mode incremental|full] [--mapping path] [--output dir] [--debug]');
    process.exit(1);
  }
}

async function loadDotenv() {
  try {
    const dotenv = await import('dotenv');
    dotenv.default?.config();
  } catch (_error) {
    // Ignore in test-only environments where dotenv is not installed.
  }
}

const mappingPath = cliOptions.mapping || process.env.IIIF_MAPPING_PATH || DEFAULT_MAPPING_PATH;

const counters = {
  fetched: 0,
  written: 0,
  skippedUnchanged: 0,
  skippedMissingIabCode: 0,
  removedStale: 0,
  errors: 0
};

if (isMain) {
  main().catch((error) => {
    console.error(`Fatal: ${error.message}`);
    process.exit(1);
  });
}

async function main() {
  const mapping = readMapping(mappingPath);
  const env = {
    spaceId: process.env.CONTENTFUL_SPACE_ID,
    environmentId: process.env.CONTENTFUL_ENV_ID || 'master',
    contentTypeId: process.env.CONTENTFUL_CONTENT_TYPE_ID,
    deliveryToken: process.env.CONTENTFUL_DELIVERY_TOKEN,
    deliveryHost: validateDeliveryHost(process.env.CONTENTFUL_DELIVERY_HOST || 'cdn.contentful.com'),
    defaultLocale: process.env.DEFAULT_LOCALE || 'en-US',
    arLocale: process.env.AR_LOCALE || 'ar'
  };
  validateEnv(env);

  const outputDir = cliOptions.output || mapping.outputDir || DEFAULT_OUTPUT_DIR;
  const collectionFileName = mapping.collection?.fileName || 'collection.json';
  const collectionId = mapping.collection?.id || collectionFileName;

  fs.mkdirSync(outputDir, { recursive: true });

  const previousIndexPath = path.join(outputDir, 'index.json');
  const previousIndex = readJsonIfExists(previousIndexPath) || { manifests: {} };

  const entries = await fetchAllEntries({
    spaceId: env.spaceId,
    environmentId: env.environmentId,
    contentTypeId: env.contentTypeId,
    deliveryToken: env.deliveryToken,
    deliveryHost: env.deliveryHost
  });
  counters.fetched = entries.length;

  const nextIndex = {
    generatedAt: new Date().toISOString(),
    mode,
    spaceId: env.spaceId,
    environmentId: env.environmentId,
    contentTypeId: env.contentTypeId,
    manifests: {}
  };

  for (const entry of entries) {
    try {
      const iabCodeValue = getLocalizedField(entry, mapping.idField, env.defaultLocale, env.arLocale);
      const iabCode = normalizeString(iabCodeValue);
      if (!iabCode) {
        counters.skippedMissingIabCode += 1;
        if (cliOptions.debug) {
          const rawIdField = entry?.fields?.[mapping.idField];
          console.error(
            `[debug] missing iabCode entryId=${entry?.sys?.id || 'unknown'} updatedAt=${entry?.sys?.updatedAt || 'n/a'} raw=${safeJson(rawIdField)} fields=${Object.keys(entry?.fields || {}).join(',')}`
          );
        }
        continue;
      }

      const safeIabCode = sanitizeFileName(iabCode);
      const manifestFileName = `${safeIabCode}.json`;
      const manifestPath = path.join(outputDir, manifestFileName);
      const updatedAt = entry?.sys?.updatedAt || null;
      const previous = previousIndex.manifests?.[iabCode] || null;

      if (
        mode === MODE_INCREMENTAL &&
        previous &&
        previous.updatedAt === updatedAt &&
        fs.existsSync(manifestPath)
      ) {
        counters.skippedUnchanged += 1;
        nextIndex.manifests[iabCode] = previous;
        continue;
      }

      const manifest = buildManifest({
        entry,
        iabCode,
        manifestFileName,
        mapping,
        defaultLocale: env.defaultLocale,
        arLocale: env.arLocale
      });

      writeJson(manifestPath, manifest);
      counters.written += 1;

      nextIndex.manifests[iabCode] = {
        fileName: manifestFileName,
        id: manifest.id,
        updatedAt
      };
    } catch (error) {
      counters.errors += 1;
      console.error(`Entry error (${entry?.sys?.id || 'unknown'}): ${error.message}`);
    }
  }

  counters.removedStale += removeStaleManifests({
    outputDir,
    nextIndex,
    previousIndex,
    collectionFileName
  });

  const collection = buildCollection({
    collectionId,
    collectionLabel: mapping.collection?.label,
    manifests: nextIndex.manifests,
    defaultLocale: env.defaultLocale,
    arLocale: env.arLocale
  });
  writeJson(path.join(outputDir, collectionFileName), collection);

  const indexOutput = {
    ...nextIndex,
    collection: {
      fileName: collectionFileName,
      id: collectionId
    }
  };
  writeJson(previousIndexPath, indexOutput);

  printSummary({
    mode,
    outputDir,
    collectionFileName,
    counters
  });
}

function parseCliOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode' && argv[i + 1]) {
      options.mode = String(argv[i + 1]).toLowerCase();
      i += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      options.mode = String(arg.slice('--mode='.length)).toLowerCase();
      continue;
    }
    if (arg === '--mapping' && argv[i + 1]) {
      options.mapping = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--mapping=')) {
      options.mapping = arg.slice('--mapping='.length);
      continue;
    }
    if (arg === '--output' && argv[i + 1]) {
      options.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
      continue;
    }
    if (arg === '--debug') {
      options.debug = true;
    }
  }
  return options;
}

function validateEnv(currentEnv) {
  const required = ['spaceId', 'environmentId', 'contentTypeId', 'deliveryToken'];
  const missing = required.filter((key) => !currentEnv[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env values: ${missing.join(', ')}`);
  }
}

function readMapping(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const requiredKeys = ['idField', 'fields'];
  const missing = requiredKeys.filter((key) => !parsed[key]);
  if (missing.length > 0) {
    throw new Error(`Invalid IIIF mapping file "${filePath}": missing keys ${missing.join(', ')}`);
  }
  if (!parsed.fields.label || !parsed.fields.summary || !parsed.fields.provider) {
    throw new Error(`Invalid IIIF mapping file "${filePath}": fields.label, fields.summary, and fields.provider are required`);
  }
  return parsed;
}

async function fetchAllEntries({ spaceId, environmentId, contentTypeId, deliveryToken, deliveryHost }) {
  const items = [];
  let skip = 0;
  let total = null;

  while (total === null || skip < total) {
    const url = buildCdaEntriesUrl({
      deliveryHost,
      spaceId,
      environmentId,
      contentTypeId,
      limit: DEFAULT_LIMIT,
      skip
    });
    const response = await fetch(url, { headers: buildCdaHeaders(deliveryToken) });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Contentful CDA HTTP ${response.status}: ${errorText}`);
    }

    const payload = await response.json();
    const batchItems = Array.isArray(payload.items) ? payload.items : [];
    items.push(...batchItems);
    total = Number.isFinite(payload.total) ? payload.total : items.length;
    skip += batchItems.length;

    if (batchItems.length === 0) {
      break;
    }
  }

  return items;
}

function buildManifest({ entry, iabCode, manifestFileName, mapping, defaultLocale, arLocale }) {
  const labelFieldId = mapping.fields.label;
  const summaryFieldId = mapping.fields.summary;
  const providerFieldId = mapping.fields.provider;
  const explicitIiifFieldIds = new Set([labelFieldId, summaryFieldId, providerFieldId].filter(Boolean));
  const explicitMetadataFieldIds = new Set();

  const manifestId = manifestFileName;
  const label = buildLanguageMap(entry, labelFieldId, defaultLocale, arLocale, mapping.localeAliases);
  const summary = buildLanguageMap(entry, summaryFieldId, defaultLocale, arLocale, mapping.localeAliases);
  const providerLabel = buildLanguageMap(entry, providerFieldId, defaultLocale, arLocale, mapping.localeAliases);

  const metadata = [];
  for (const metadataMap of mapping.metadata || []) {
    const fieldId = metadataMap.fieldId;
    if (!fieldId) {
      continue;
    }
    explicitMetadataFieldIds.add(fieldId);
    const value = buildLanguageMap(entry, fieldId, defaultLocale, arLocale, mapping.localeAliases);
    if (Object.keys(value).length === 0) {
      continue;
    }
    const labelText = normalizeLabelMap(metadataMap.label, defaultLocale, arLocale, mapping.localeAliases);
    metadata.push({ label: labelText, value });
  }

  for (const fieldId of Object.keys(entry?.fields || {})) {
    if (explicitIiifFieldIds.has(fieldId) || explicitMetadataFieldIds.has(fieldId)) {
      continue;
    }

    const value = buildLanguageMap(entry, fieldId, defaultLocale, arLocale, mapping.localeAliases);
    if (Object.keys(value).length === 0) {
      continue;
    }

    const labelText = autoMetadataLabel(fieldId, defaultLocale, arLocale, mapping.localeAliases);
    metadata.push({ label: labelText, value });
  }

  return {
    '@context': 'http://iiif.io/api/presentation/3/context.json',
    id: manifestId,
    type: 'Manifest',
    label: withFallbackLabel(label, iabCode),
    summary,
    provider: Object.keys(providerLabel).length > 0
      ? [
          {
            id: `providers/${encodeURIComponent(iabCode)}`,
            type: 'Agent',
            label: providerLabel
          }
        ]
      : undefined,
    metadata,
    items: []
  };
}

function buildCollection({ collectionId, collectionLabel, manifests, defaultLocale, arLocale }) {
  const items = Object.entries(manifests)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, meta]) => ({
      id: meta.fileName,
      type: 'Manifest'
    }));

  return {
    '@context': 'http://iiif.io/api/presentation/3/context.json',
    id: collectionId,
    type: 'Collection',
    label: normalizeLabelMap(collectionLabel, defaultLocale, arLocale, {
      [defaultLocale]: 'en',
      [arLocale]: 'ar'
    }),
    items
  };
}

function normalizeLabelMap(labelConfig, defaultLocale, arLocale, localeAliases) {
  const defaultLabel = { en: ['Collection'] };
  if (!labelConfig || typeof labelConfig !== 'object') {
    return defaultLabel;
  }

  const out = {};
  for (const [locale, text] of Object.entries(labelConfig)) {
    const normalized = normalizeString(text);
    if (!normalized) {
      continue;
    }
    const lang = toIiifLanguage(locale, localeAliases, defaultLocale, arLocale);
    out[lang] = [normalized];
  }
  return Object.keys(out).length > 0 ? out : defaultLabel;
}

function buildLanguageMap(entry, fieldId, defaultLocale, arLocale, localeAliases) {
  const value = entry?.fields?.[fieldId];
  if (value === null || value === undefined) {
    return {};
  }

  const out = {};
  if (isLocaleMap(value)) {
    const locales = [defaultLocale, arLocale];
    for (const locale of locales) {
      const raw = value?.[locale];
      const stringValue = formatFieldValue(raw);
      if (!stringValue) {
        continue;
      }
      const lang = toIiifLanguage(locale, localeAliases, defaultLocale, arLocale);
      out[lang] = [stringValue];
    }
    return out;
  }

  const fallbackValue = formatFieldValue(value);
  if (fallbackValue) {
    const lang = toIiifLanguage(defaultLocale, localeAliases, defaultLocale, arLocale);
    out[lang] = [fallbackValue];
  }

  return out;
}

function getLocalizedField(entry, fieldId, defaultLocale, arLocale) {
  const field = entry?.fields?.[fieldId];
  if (field === null || field === undefined) {
    return null;
  }

  if (!isLocaleMap(field)) {
    return field;
  }

  const direct = field[defaultLocale] || field[arLocale];
  if (direct !== undefined && direct !== null) {
    return direct;
  }

  for (const value of Object.values(field)) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function formatFieldValue(value) {
  if (Array.isArray(value)) {
    const parts = value.map((item) => normalizeString(item)).filter(Boolean);
    return parts.length > 0 ? parts.join('; ') : null;
  }
  if (isLocaleMap(value)) {
    return safeJson(value);
  }
  return normalizeString(value);
}

function toIiifLanguage(locale, localeAliases, defaultLocale, arLocale) {
  const aliases = localeAliases || {
    [defaultLocale]: 'en',
    [arLocale]: 'ar'
  };
  return aliases[locale] || locale;
}

function withFallbackLabel(labelMap, fallbackValue) {
  if (Object.keys(labelMap).length > 0) {
    return labelMap;
  }
  return {
    none: [fallbackValue]
  };
}

function sanitizeFileName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_');
}

function removeStaleManifests({ outputDir, nextIndex, previousIndex, collectionFileName }) {
  let removed = 0;
  const nextKeys = new Set(Object.keys(nextIndex.manifests));
  const previousManifests = previousIndex?.manifests || {};

  for (const [iabCode, meta] of Object.entries(previousManifests)) {
    if (nextKeys.has(iabCode)) {
      continue;
    }
    const fileName = meta?.fileName;
    if (!fileName || fileName === collectionFileName || fileName === 'index.json') {
      continue;
    }
    if (path.isAbsolute(fileName)) {
      continue;
    }
    const filePath = path.resolve(outputDir, fileName);
    if (!isPathInsideDirectory(outputDir, filePath)) {
      continue;
    }
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function validateDeliveryHost(hostValue) {
  const normalized = String(hostValue || '').trim().toLowerCase();
  if (!normalized) {
    throw new Error('CONTENTFUL_DELIVERY_HOST is required');
  }

  if (
    normalized.includes('://') ||
    normalized.includes('/') ||
    normalized.includes('?') ||
    normalized.includes('#') ||
    normalized.includes('@')
  ) {
    throw new Error(
      'Invalid CONTENTFUL_DELIVERY_HOST format. Use hostname only (for example: cdn.contentful.com).'
    );
  }

  let parsed;
  try {
    parsed = new URL(`https://${normalized}`);
  } catch {
    throw new Error(`Invalid CONTENTFUL_DELIVERY_HOST: ${hostValue}`);
  }

  if (parsed.port) {
    throw new Error('Invalid CONTENTFUL_DELIVERY_HOST: custom ports are not allowed.');
  }

  if (parsed.hostname !== normalized || !ALLOWED_DELIVERY_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Unsupported CONTENTFUL_DELIVERY_HOST: ${hostValue}. Allowed hosts: ${Array.from(ALLOWED_DELIVERY_HOSTS).join(', ')}`
    );
  }

  return parsed.hostname;
}

function buildCdaEntriesUrl({ deliveryHost, spaceId, environmentId, contentTypeId, limit, skip }) {
  const url = new URL(
    `https://${deliveryHost}/spaces/${encodeURIComponent(spaceId)}/environments/${encodeURIComponent(environmentId)}/entries`
  );
  url.searchParams.set('content_type', contentTypeId);
  url.searchParams.set('locale', '*');
  url.searchParams.set('include', '0');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('skip', String(skip));
  return url.toString();
}

function buildCdaHeaders(deliveryToken) {
  return {
    Authorization: `Bearer ${deliveryToken}`
  };
}

function isPathInsideDirectory(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const relativePath = path.relative(resolvedBase, resolvedTarget);
  return relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function normalizeString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = String(value).trim();
  return trimmed || null;
}

function autoMetadataLabel(fieldId, defaultLocale, arLocale, localeAliases) {
  const humanLabel = String(fieldId)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const cased = humanLabel
    .split(' ')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  const lang = toIiifLanguage(defaultLocale, localeAliases, defaultLocale, arLocale);
  return {
    [lang]: [cased || fieldId]
  };
}

function isLocaleMap(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function printSummary({ mode: currentMode, outputDir, collectionFileName, counters: currentCounters }) {
  console.log(`Mode: ${currentMode}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Fetched entries: ${currentCounters.fetched}`);
  console.log(`Manifests written: ${currentCounters.written}`);
  console.log(`Unchanged skipped: ${currentCounters.skippedUnchanged}`);
  console.log(`Missing iabCode skipped: ${currentCounters.skippedMissingIabCode}`);
  console.log(`Stale manifests removed: ${currentCounters.removedStale}`);
  console.log(`Errors: ${currentCounters.errors}`);
  console.log(`Collection: ${path.join(outputDir, collectionFileName)}`);
  console.log(`Index: ${path.join(outputDir, 'index.json')}`);
}

export {
  buildCdaEntriesUrl,
  buildCdaHeaders,
  isPathInsideDirectory,
  parseCliOptions,
  removeStaleManifests,
  validateDeliveryHost
};
