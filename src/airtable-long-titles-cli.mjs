import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { listAirtableRecords } from './airtable-client.mjs';

const DEFAULT_TITLE_MIN = 150;

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
  const options = parseLongTitlesCliOptions(process.argv.slice(2));
  const titleMin = clampInt(options.titleMin, 1, 5000, DEFAULT_TITLE_MIN);

  const records = await listAirtableRecords({
    apiKey: process.env.AIRTABLE_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID,
    tableName: process.env.AIRTABLE_TABLE_NAME,
    fields: ['IAB Code', 'Title of Object'],
    maxRecords: options.maxRecords,
    view: options.view,
    filterByFormula: options.filterByFormula
  });

  const report = analyzeLongTitles(records, { titleMin });
  const csv = renderLongTitlesCsv(report.rows);

  if (options.stdoutOnly) {
    process.stdout.write(csv);
    return;
  }

  const outputPath = writeLongTitlesReport(csv, options.outputPath);
  console.log(`Wrote long titles report: ${outputPath}`);
  console.log(`Records scanned: ${report.totals.recordsScanned}`);
  console.log(`Long titles found: ${report.totals.longTitlesFound}`);
}

export function parseLongTitlesCliOptions(argv) {
  const options = {
    outputPath: null,
    stdoutOnly: false
  };

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
    if (arg === '--filter-by-formula' && argv[i + 1]) {
      options.filterByFormula = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--filter-by-formula=')) {
      options.filterByFormula = arg.slice('--filter-by-formula='.length);
      continue;
    }
    if (arg === '--title-min' && argv[i + 1]) {
      options.titleMin = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg.startsWith('--title-min=')) {
      options.titleMin = Number.parseInt(arg.slice('--title-min='.length), 10);
      continue;
    }
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
      options.stdoutOnly = true;
      continue;
    }
    if (arg === '--write-report') {
      options.outputPath = defaultLongTitlesReportPath();
    }
  }

  return options;
}

export function analyzeLongTitles(records, options = {}) {
  const titleMin = clampInt(options.titleMin, 1, 5000, DEFAULT_TITLE_MIN);
  const rows = [];

  for (const record of records) {
    const fields = record?.fields || {};
    const iabCode = normalizeValue(fields['IAB Code']);
    const title = normalizeValue(fields['Title of Object']);

    if (!title || title.length <= titleMin) {
      continue;
    }

    rows.push({
      recordId: record?.id || null,
      iabCode,
      title,
      suggestedShortTitle: suggestShortTitle(title)
    });
  }

  rows.sort((left, right) => {
    return compareNullableStrings(left.iabCode, right.iabCode) || left.title.localeCompare(right.title);
  });

  return {
    generatedAt: new Date().toISOString(),
    thresholds: {
      titleMin
    },
    totals: {
      recordsScanned: records.length,
      longTitlesFound: rows.length
    },
    rows
  };
}

export function suggestShortTitle(title) {
  const normalizedTitle = normalizeValue(title);
  if (!normalizedTitle) {
    return '';
  }

  const parts = normalizedTitle
    .split(',')
    .map((part) => normalizeInlineWhitespace(part))
    .filter(Boolean);

  if (parts.length < 2) {
    return normalizedTitle;
  }

  const candidate = parts[0];
  if (!candidate || candidate.length >= normalizedTitle.length) {
    return normalizedTitle;
  }

  return candidate;
}

export function renderLongTitlesCsv(rows) {
  const lines = ['IAB Code,Title,Suggested Short Title'];

  for (const row of rows) {
    lines.push(
      [row.iabCode || '', row.title || '', row.suggestedShortTitle || ''].map(escapeCsvValue).join(',')
    );
  }

  return `${lines.join('\n')}\n`;
}

function writeLongTitlesReport(csv, explicitPath) {
  const reportPath = explicitPath || defaultLongTitlesReportPath();
  const absolutePath = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, csv, 'utf8');
  return absolutePath;
}

function defaultLongTitlesReportPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('reports', `airtable-long-titles-${timestamp}.csv`);
}

function escapeCsvValue(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll('"', '""')}"`;
}

function normalizeValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const str = String(value).trim();
  return str === '' ? null : str;
}

function normalizeInlineWhitespace(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function compareNullableStrings(left, right) {
  if (left === right) {
    return 0;
  }
  if (left === null || left === undefined) {
    return 1;
  }
  if (right === null || right === undefined) {
    return -1;
  }
  return String(left).localeCompare(String(right));
}

function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value) || Number.isNaN(value)) {
    return fallback;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
