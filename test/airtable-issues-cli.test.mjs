import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeAirtableIssues,
  containsPageText,
  hasMultipleIabCodes,
  parseIssuesCliOptions
} from '../src/airtable-issues-cli.mjs';

test('parseIssuesCliOptions parses supported flags', () => {
  const options = parseIssuesCliOptions([
    '--max=100',
    '--view',
    'Ready for Import',
    '--filter-by-formula',
    '{Ready for Import}=1',
    '--title-max',
    '180',
    '--json',
    '--output',
    'reports/custom-issues.json'
  ]);

  assert.deepEqual(options, {
    maxRecords: 100,
    view: 'Ready for Import',
    filterByFormula: '{Ready for Import}=1',
    titleMax: 180,
    json: true,
    outputPath: 'reports/custom-issues.json'
  });
});

test('hasMultipleIabCodes returns true when IAB code contains comma', () => {
  assert.equal(hasMultipleIabCodes('A-1, A-2'), true);
  assert.equal(hasMultipleIabCodes('A-1'), false);
});

test('containsPageText returns true when IAB code contains page text', () => {
  assert.equal(containsPageText('page 12'), true);
  assert.equal(containsPageText('PAGe 12'), true);
  assert.equal(containsPageText('A-12'), false);
});

test('analyzeAirtableIssues finds iab code and title length issues', () => {
  const longTitle = 'x'.repeat(256);
  const analysis = analyzeAirtableIssues(
    [
      {
        id: 'rec1',
        fields: {
          'IAB Code': 'A-1, A-2',
          'Title of Object': 'Valid title'
        }
      },
      {
        id: 'rec2',
        fields: {
          'IAB Code': 'page 99',
          'Title of Object': longTitle
        }
      },
      {
        id: 'rec3',
        fields: {
          'IAB Code': 'A-3',
          'Title of Object': 'Short title'
        }
      }
    ],
    { titleMax: 255 }
  );

  assert.equal(analysis.totals.recordsScanned, 3);
  assert.equal(analysis.totals.recordsWithIssues, 2);
  assert.equal(analysis.totals.issuesByType.multiple_iab_codes, 1);
  assert.equal(analysis.totals.issuesByType.iab_code_contains_page, 1);
  assert.equal(analysis.totals.issuesByType.title_too_long, 1);
  assert.equal(analysis.issues.length, 2);
});
