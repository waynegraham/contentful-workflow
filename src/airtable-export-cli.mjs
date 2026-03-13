import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { listAirtableRecords, listAirtableTableFields } from './airtable-client.mjs';

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
  const options = parseExportCliOptions(process.argv.slice(2));
  const output = await exportAirtableSnapshot({
    apiKey: process.env.AIRTABLE_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID,
    tableName: process.env.AIRTABLE_TABLE_NAME,
    maxRecords: options.maxRecords,
    view: options.view,
    filterByFormula: options.filterByFormula
  });

  if (options.stdoutOnly) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const reportPath = writeExportReport(output, options.outputPath);
  console.log(`Wrote Airtable export: ${reportPath}`);
}

export function parseExportCliOptions(argv) {
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
  }

  return options;
}

export async function exportAirtableSnapshot(options = {}) {
  const [fields, records] = await Promise.all([
    listAirtableTableFields(options),
    listAirtableRecords({
      ...options,
      fields: null
    })
  ]);

  return {
    generatedAt: new Date().toISOString(),
    airtable: {
      baseId: options.baseId,
      tableName: options.tableName,
      view: options.view || null,
      filterByFormula: options.filterByFormula || null,
      maxRecords: Number.isFinite(options.maxRecords) ? options.maxRecords : null
    },
    totals: {
      fields: fields.length,
      records: records.length
    },
    fields,
    records
  };
}

export function defaultExportPath(now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return path.join('reports', `airtable-export-${timestamp}.json`);
}

export function writeExportReport(report, outputPath = null) {
  const reportPath = outputPath || defaultExportPath();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}
