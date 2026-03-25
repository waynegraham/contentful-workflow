import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeLongTitles,
  parseLongTitlesCliOptions,
  renderLongTitlesCsv,
  suggestShortTitle
} from '../src/airtable-long-titles-cli.mjs';

test('parseLongTitlesCliOptions parses supported flags', () => {
  const options = parseLongTitlesCliOptions([
    '--max=100',
    '--view',
    'Ready for Import',
    '--filter-by-formula',
    '{Ready for Import}=1',
    '--title-min',
    '180',
    '--output',
    'reports/long-titles.csv',
    '--stdout-only'
  ]);

  assert.deepEqual(options, {
    maxRecords: 100,
    view: 'Ready for Import',
    filterByFormula: '{Ready for Import}=1',
    titleMin: 180,
    outputPath: 'reports/long-titles.csv',
    stdoutOnly: true
  });
});

test('suggestShortTitle returns the first comma-separated segment when present', () => {
  assert.equal(
    suggestShortTitle('Short title, MS 123, fol. 4r, Bibliographic note'),
    'Short title'
  );
  assert.equal(suggestShortTitle('Standalone title'), 'Standalone title');
});

test('analyzeLongTitles filters rows above the configured threshold', () => {
  const analysis = analyzeLongTitles(
    [
      {
        id: 'rec1',
        fields: {
          'IAB Code': 'A-1',
          'Title of Object': 'A concise title'
        }
      },
      {
        id: 'rec2',
        fields: {
          'IAB Code': 'A-2',
          'Title of Object':
            'Useful short title, Manuscript collection, Shelfmark 12, fol. 8v, copied in Cairo, late nineteenth century'
        }
      }
    ],
    { titleMin: 50 }
  );

  assert.equal(analysis.totals.recordsScanned, 2);
  assert.equal(analysis.totals.longTitlesFound, 1);
  assert.deepEqual(analysis.rows, [
    {
      recordId: 'rec2',
      iabCode: 'A-2',
      title: 'Useful short title, Manuscript collection, Shelfmark 12, fol. 8v, copied in Cairo, late nineteenth century',
      suggestedShortTitle: 'Useful short title'
    }
  ]);
});

test('renderLongTitlesCsv escapes commas, quotes, and newlines', () => {
  const csv = renderLongTitlesCsv([
    {
      iabCode: 'A-2',
      title: 'Long "quoted" title,\nwith break',
      suggestedShortTitle: 'Short, title'
    }
  ]);

  assert.equal(
    csv,
    'IAB Code,Title,Suggested Short Title\nA-2,"Long ""quoted"" title,\nwith break","Short, title"\n'
  );
});
