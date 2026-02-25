import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSuggestedMappings,
  inferColumnsFromRecords,
  parseMapCliOptions
} from '../src/airtable-map-cli.mjs';

test('parseMapCliOptions reads supported flags', () => {
  const options = parseMapCliOptions([
    '--output',
    'reports/map.json',
    '--table=Catalog',
    '--content-type',
    'alMadarCsv',
    '--sample-size=30',
    '--view',
    'Ready for Import',
    '--filter-by-formula',
    '{Ready for Import}=1',
    '--json',
    '--skip-contentful'
  ]);

  assert.deepEqual(options, {
    outputPath: 'reports/map.json',
    sampleSize: 30,
    json: true,
    skipContentful: true,
    tableName: 'Catalog',
    contentTypeId: 'alMadarCsv',
    view: 'Ready for Import',
    filterByFormula: '{Ready for Import}=1'
  });
});

test('inferColumnsFromRecords returns unique trimmed keys', () => {
  const columns = inferColumnsFromRecords([
    { fields: { ' IAB Code ': 'A-1', Description: 'x' } },
    { fields: { Description: 'y', 'Title of Object': 'Lamp' } }
  ]);

  assert.deepEqual(columns.sort(), ['Description', 'IAB Code', 'Title of Object']);
});

test('buildSuggestedMappings suggests high-confidence matches', () => {
  const mappings = buildSuggestedMappings(
    ['IAB Code', 'Title of Object', 'Unknown Column'],
    [
      { id: 'iabCode', name: 'IAB Code' },
      { id: 'title', name: 'Title' }
    ]
  );

  assert.deepEqual(mappings, [
    {
      airtableField: 'IAB Code',
      contentfulFieldId: 'iabCode',
      confidence: 'high'
    },
    {
      airtableField: 'Title of Object',
      contentfulFieldId: 'title',
      confidence: 'medium'
    },
    {
      airtableField: 'Unknown Column',
      contentfulFieldId: null,
      confidence: 'none'
    }
  ]);
});
