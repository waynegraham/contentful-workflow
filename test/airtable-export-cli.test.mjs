import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  defaultExportPath,
  exportAirtableSnapshot,
  parseExportCliOptions,
  writeExportReport
} from '../src/airtable-export-cli.mjs';

test('parseExportCliOptions reads supported flags', () => {
  const options = parseExportCliOptions([
    '--max=25',
    '--view',
    'Ready',
    '--filter-by-formula',
    '{Ready for Import}=1',
    '--output',
    'tmp/export.json',
    '--stdout-only'
  ]);

  assert.deepEqual(options, {
    maxRecords: 25,
    view: 'Ready',
    filterByFormula: '{Ready for Import}=1',
    outputPath: 'tmp/export.json',
    stdoutOnly: true
  });
});

test('exportAirtableSnapshot includes schema and full records', async () => {
  const responses = [
    {
      ok: true,
      status: 200,
      payload: {
        tables: [
          {
            id: 'tbl123',
            name: 'Catalog Table',
            fields: [
              { id: 'fld1', name: 'IAB Code', type: 'singleLineText' },
              { id: 'fld2', name: 'Description', type: 'multilineText' }
            ]
          }
        ]
      }
    },
    {
      ok: true,
      status: 200,
      payload: {
        records: [
          {
            id: 'rec1',
            createdTime: '2026-03-13T00:00:00.000Z',
            fields: {
              'IAB Code': 'A-1',
              Description: 'Bronze lamp',
              Extra: ['attachment-or-linked-data']
            }
          }
        ]
      }
    }
  ];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const next = responses.shift();
    assert.ok(next, 'Unexpected fetch call');
    return {
      ok: next.ok,
      status: next.status,
      async json() {
        return next.payload;
      }
    };
  };

  try {
    const report = await exportAirtableSnapshot({
      apiKey: 'key',
      baseId: 'app123',
      tableName: 'Catalog Table'
    });

    assert.equal(report.airtable.baseId, 'app123');
    assert.equal(report.airtable.tableName, 'Catalog Table');
    assert.equal(report.totals.fields, 2);
    assert.equal(report.totals.records, 1);
    assert.deepEqual(report.fields, [
      { id: 'fld1', name: 'IAB Code', type: 'singleLineText' },
      { id: 'fld2', name: 'Description', type: 'multilineText' }
    ]);
    assert.deepEqual(report.records, [
      {
        id: 'rec1',
        createdTime: '2026-03-13T00:00:00.000Z',
        fields: {
          'IAB Code': 'A-1',
          Description: 'Bronze lamp',
          Extra: ['attachment-or-linked-data']
        }
      }
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('defaultExportPath creates timestamped report filename', () => {
  const outputPath = defaultExportPath(new Date('2026-03-13T14:41:45.157Z'));
  assert.equal(outputPath, 'reports/airtable-export-2026-03-13T14-41-45-157Z.json');
});

test('writeExportReport writes JSON file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airtable-export-test-'));
  const outputPath = path.join(tempDir, 'snapshot.json');

  writeExportReport({ ok: true }, outputPath);

  const contents = fs.readFileSync(outputPath, 'utf8');
  assert.deepEqual(JSON.parse(contents), { ok: true });
});
