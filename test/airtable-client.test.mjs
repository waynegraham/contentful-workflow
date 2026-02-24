import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRecordsUrl,
  listCatalogFields,
  parseAirtableCliOptions
} from '../src/airtable-client.mjs';

test('parseAirtableCliOptions reads supported flags', () => {
  const options = parseAirtableCliOptions([
    '--max=25',
    '--view',
    'Ready',
    '--json',
    '--filter-by-formula',
    '{Ready for Import}=1'
  ]);

  assert.deepEqual(options, {
    maxRecords: 25,
    view: 'Ready',
    json: true,
    filterByFormula: '{Ready for Import}=1'
  });
});

test('buildRecordsUrl includes selected fields and optional filters', () => {
  const url = buildRecordsUrl({
    apiBase: 'https://api.airtable.com/v0',
    baseId: 'app123',
    tableName: 'Catalog Table',
    fields: ['IAB Code', 'Title of Object'],
    pageSize: 50,
    offset: 'abc',
    view: 'Ready for Import',
    filterByFormula: '{Ready for Import}=1'
  });

  assert.equal(url.includes('/app123/Catalog%20Table?'), true);
  assert.equal(url.includes('fields%5B%5D=IAB+Code'), true);
  assert.equal(url.includes('fields%5B%5D=Title+of+Object'), true);
  assert.equal(url.includes('pageSize=50'), true);
  assert.equal(url.includes('offset=abc'), true);
  assert.equal(url.includes('view=Ready+for+Import'), true);
  assert.equal(url.includes('filterByFormula=%7BReady+for+Import%7D%3D1'), true);
});

test('listCatalogFields paginates and returns mapped field names', async () => {
  const responses = [
    {
      ok: true,
      payload: {
        records: [
          {
            id: 'rec1',
            fields: {
              'IAB Code': 'A-1',
              'Title of Object': 'Lamp',
              Description: 'Bronze lamp'
            }
          }
        ],
        offset: 'next-page-token'
      }
    },
    {
      ok: true,
      payload: {
        records: [
          {
            id: 'rec2',
            fields: {
              'IAB Code': 'A-2',
              'Title of Object': 'Map',
              Description: 'Folded map'
            }
          }
        ]
      }
    }
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const next = responses.shift();
    assert.ok(next, `Unexpected fetch call: ${url}`);

    return {
      ok: next.ok,
      status: 200,
      async json() {
        return next.payload;
      }
    };
  };

  try {
    const rows = await listCatalogFields({
      apiKey: 'key',
      baseId: 'app123',
      tableName: 'Catalog Table'
    });

    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      id: 'rec1',
      iabCode: 'A-1',
      titleOfObject: 'Lamp',
      description: 'Bronze lamp'
    });
    assert.deepEqual(rows[1], {
      id: 'rec2',
      iabCode: 'A-2',
      titleOfObject: 'Map',
      description: 'Folded map'
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
