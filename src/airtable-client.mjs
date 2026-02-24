const DEFAULT_API_BASE = 'https://api.airtable.com/v0';
const DEFAULT_FIELDS = ['IAB Code', 'Title of Object', 'Description'];

export function createAirtableClient(options = {}) {
  const apiKey = normalizeRequired(options.apiKey, 'AIRTABLE_API_KEY');
  const baseId = normalizeRequired(options.baseId, 'AIRTABLE_BASE_ID');
  const tableName = normalizeRequired(options.tableName, 'AIRTABLE_TABLE_NAME');
  const apiBase = normalizeApiBase(options.apiBase || DEFAULT_API_BASE);

  return {
    async listRecords(listOptions = {}) {
      return listAirtableRecords({
        apiKey,
        baseId,
        tableName,
        apiBase,
        ...listOptions
      });
    }
  };
}

export async function listAirtableRecords(options = {}) {
  const apiKey = normalizeRequired(options.apiKey, 'AIRTABLE_API_KEY');
  const baseId = normalizeRequired(options.baseId, 'AIRTABLE_BASE_ID');
  const tableName = normalizeRequired(options.tableName, 'AIRTABLE_TABLE_NAME');
  const apiBase = normalizeApiBase(options.apiBase || DEFAULT_API_BASE);

  const fields = Array.isArray(options.fields) && options.fields.length > 0 ? options.fields : DEFAULT_FIELDS;
  const pageSize = clampInt(options.pageSize, 1, 100, 100);
  const maxRecords = clampInt(options.maxRecords, 1, Number.MAX_SAFE_INTEGER, null);

  const records = [];
  let offset;

  while (true) {
    const remaining = maxRecords === null ? null : Math.max(maxRecords - records.length, 0);
    if (remaining !== null && remaining === 0) {
      break;
    }

    const currentPageSize = remaining === null ? pageSize : Math.min(pageSize, remaining);

    const url = buildRecordsUrl({
      apiBase,
      baseId,
      tableName,
      fields,
      pageSize: currentPageSize,
      offset,
      view: options.view,
      filterByFormula: options.filterByFormula
    });

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    const payload = await parseJson(response);
    if (!response.ok) {
      throw new Error(formatAirtableError(response.status, payload));
    }

    const batch = Array.isArray(payload.records) ? payload.records : [];
    records.push(...batch);
    if (!payload.offset) {
      break;
    }
    offset = payload.offset;
  }

  return records;
}

export async function listCatalogFields(options = {}) {
  const records = await listAirtableRecords({
    ...options,
    fields: DEFAULT_FIELDS
  });

  return records.map((record) => {
    const fields = record?.fields || {};
    return {
      id: record?.id || null,
      iabCode: normalizeValue(fields['IAB Code']),
      titleOfObject: normalizeValue(fields['Title of Object']),
      description: normalizeValue(fields.Description)
    };
  });
}

export function parseAirtableCliOptions(argv) {
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--max' && argv[i + 1]) {
      options.maxRecords = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }

    if (arg.startsWith('--max=')) {
      options.maxRecords = Number.parseInt(arg.slice('--max='.length), 10);
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

    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg === '--filter-by-formula' && argv[i + 1]) {
      options.filterByFormula = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--filter-by-formula=')) {
      options.filterByFormula = arg.slice('--filter-by-formula='.length);
    }
  }

  return options;
}

export function buildRecordsUrl({
  apiBase,
  baseId,
  tableName,
  fields,
  pageSize,
  offset,
  view,
  filterByFormula
}) {
  const trimmedBase = normalizeApiBase(apiBase);
  const encodedPath = `${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}`;
  const url = new URL(`${trimmedBase}/${encodedPath}`);

  for (const field of fields) {
    url.searchParams.append('fields[]', field);
  }

  url.searchParams.set('pageSize', String(pageSize));

  if (offset) {
    url.searchParams.set('offset', String(offset));
  }

  if (view) {
    url.searchParams.set('view', String(view));
  }

  if (filterByFormula) {
    url.searchParams.set('filterByFormula', String(filterByFormula));
  }

  return url.toString();
}

function formatAirtableError(status, payload) {
  const errorType = payload?.error?.type;
  const errorMessage = payload?.error?.message;

  if (errorType && errorMessage) {
    return `Airtable request failed (${status}): ${errorType} - ${errorMessage}`;
  }

  if (errorMessage) {
    return `Airtable request failed (${status}): ${errorMessage}`;
  }

  return `Airtable request failed with status ${status}`;
}

async function parseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function normalizeRequired(value, envName) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`${envName} is required`);
  }
  return normalized;
}

function normalizeApiBase(value) {
  const normalized = typeof value === 'string' ? value.trim().replace(/\/$/, '') : '';
  if (!normalized) {
    throw new Error('Airtable API base URL is required');
  }

  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid Airtable API base URL: ${normalized}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Airtable API base URL must use https');
  }

  return parsed.toString().replace(/\/$/, '');
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

function normalizeValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const str = String(value).trim();
  return str === '' ? null : str;
}
