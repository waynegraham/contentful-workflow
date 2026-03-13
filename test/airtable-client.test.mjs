import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRecordUrl,
  buildSchemaUrl,
  buildRecordsUrl,
  listCatalogFields,
  parseAirtableCliOptions,
  updateAirtableRecord
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

test('buildRecordsUrl omits fields[] when fields are null', () => {
  const url = buildRecordsUrl({
    apiBase: 'https://api.airtable.com/v0',
    baseId: 'app123',
    tableName: 'Catalog Table',
    fields: null,
    pageSize: 10
  });

  assert.equal(url.includes('fields%5B%5D='), false);
  assert.equal(url.includes('pageSize=10'), true);
});

test('buildSchemaUrl points to Airtable metadata tables endpoint', () => {
  const url = buildSchemaUrl({
    schemaApiBase: 'https://api.airtable.com/v0/meta',
    baseId: 'app123'
  });

  assert.equal(url, 'https://api.airtable.com/v0/meta/bases/app123/tables');
});

test('buildRecordUrl points to a single Airtable record endpoint', () => {
  const url = buildRecordUrl({
    apiBase: 'https://api.airtable.com/v0',
    baseId: 'app123',
    tableName: 'Catalog Table',
    recordId: 'rec456'
  });

  assert.equal(url, 'https://api.airtable.com/v0/app123/Catalog%20Table/rec456');
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

test('updateAirtableRecord patches a record field payload', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.airtable.com/v0/app123/Catalog%20Table/rec456');
    assert.equal(options.method, 'PATCH');
    assert.equal(options.headers.Authorization, 'Bearer key');
    assert.deepEqual(JSON.parse(options.body), {
      fields: { contentful_url: 'https://app.contentful.com/spaces/space/environments/master/entries/entry' },
      typecast: false
    });

    return {
      ok: true,
      status: 200,
      async json() {
        return { id: 'rec456' };
      }
    };
  };

  try {
    const result = await updateAirtableRecord({
      apiKey: 'key',
      baseId: 'app123',
      tableName: 'Catalog Table',
      recordId: 'rec456',
      fields: {
        contentful_url: 'https://app.contentful.com/spaces/space/environments/master/entries/entry'
      }
    });

    assert.deepEqual(result, { id: 'rec456' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
