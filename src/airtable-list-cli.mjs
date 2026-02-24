import { pathToFileURL } from 'node:url';

import { listCatalogFields, parseAirtableCliOptions } from './airtable-client.mjs';

const args = process.argv.slice(2);
const options = parseAirtableCliOptions(args);

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
  const rows = await listCatalogFields({
    apiKey: process.env.AIRTABLE_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID,
    tableName: process.env.AIRTABLE_TABLE_NAME,
    maxRecords: options.maxRecords,
    view: options.view,
    filterByFormula: options.filterByFormula
  });

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No records found.');
    return;
  }

  for (const row of rows) {
    console.log(`${row.iabCode || ''}\t${row.titleOfObject || ''}\t${row.description || ''}`);
  }
}
