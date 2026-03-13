import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTransform,
  buildContentfulEntryUrl,
  extractFootnoteNumbers,
  findDuplicates,
  formatFootnotes,
  linkDescriptionFootnotes,
  norm,
  parseCliOptions,
  resolveTranslationModel,
  selectProcessableRecords,
  shouldTranslateAr,
  splitDateParts,
  validateAirtableFields,
  validateEnvForMode,
  validateMappingShape
} from '../src/import-cli.mjs';

test('parseCliOptions parses supported flags', () => {
  const options = parseCliOptions([
    '--mapping',
    'config/mapping.json',
    '--progress=ON',
    '--max',
    '50',
    '--redo'
  ]);

  assert.deepEqual(options, {
    mapping: 'config/mapping.json',
    progress: 'on',
    maxRecords: 50,
    redo: true
  });
});

test('norm trims and converts common NA markers to null', () => {
  assert.equal(norm(' value '), 'value');
  assert.equal(norm('N/A'), null);
  assert.equal(norm('na'), null);
  assert.equal(norm('-'), null);
  assert.equal(norm(''), null);
});

test('splitDateParts normalizes unicode dashes in date values', () => {
  const [hijri, gregorian] = splitDateParts('1445–01–01 / 2024—01—11');
  assert.equal(hijri, '1445-01-01');
  assert.equal(gregorian, '2024-01-11');
});

test('applyTransform split_to_array splits by delimiters and title-cases', () => {
  const transformed = applyTransform('paper; CLOTH,  vellum', {
    transform: 'split_to_array',
    arrayDelimiters: [',', ';'],
    arrayItemCase: 'title'
  });

  assert.deepEqual(transformed, ['Paper', 'Cloth', 'Vellum']);
});

test('validateMappingShape fails when fieldIds are duplicated', () => {
  assert.throws(
    () =>
      validateMappingShape({
        fieldMappings: [{ fieldId: 'iabCode' }, { fieldId: 'iabCode' }]
      }),
    /duplicate fieldId/
  );
});

test('validateAirtableFields fails when mapped Airtable fields are missing', () => {
  const mapping = {
    fieldMappings: [
      {
        fieldId: 'title',
        source: { 'en-US': 'Title', ar: 'Title AR' }
      }
    ]
  };
  const fields = [{ name: 'Title' }];

  assert.throws(
    () => validateAirtableFields(mapping, fields, 'contentful_url'),
    /Airtable missing mapped field/
  );
});

test('shouldTranslateAr only returns true for translate mode and missing Arabic value', () => {
  assert.equal(shouldTranslateAr(null, 'translate_if_empty'), true);
  assert.equal(shouldTranslateAr('موجود', 'translate_if_empty'), false);
  assert.equal(shouldTranslateAr(null, 'keep_source_only'), false);
});

test('validateEnvForMode only requires provider key for non-validate modes when translation is enabled', () => {
  const baseEnv = {
    spaceId: 'space',
    envId: 'master',
    contentTypeId: 'alMadarCsv',
    managementToken: 'token',
    airtableApiKey: 'airtable-token',
    airtableBaseId: 'app123',
    airtableTableName: 'Catalog',
    defaultLocale: 'en-US',
    arLocale: 'ar',
    translationProvider: 'openai',
    openaiApiKey: null
  };
  const mappingWithTranslation = {
    options: { translateMissingArabic: true }
  };

  assert.doesNotThrow(() => validateEnvForMode(baseEnv, 'validate', mappingWithTranslation));
  assert.throws(
    () => validateEnvForMode(baseEnv, 'dry-run', mappingWithTranslation),
    /OPENAI_API_KEY is required/
  );
});

test('findDuplicates returns each duplicated value once', () => {
  const duplicates = findDuplicates(['a', 'b', 'a', 'c', 'b', 'b']);
  assert.deepEqual(duplicates.sort(), ['a', 'b']);
});

test('selectProcessableRecords keeps only rows without contentful_url by default', () => {
  const records = [
    { id: 'rec1', fields: { 'IAB Code': 'A-1', contentful_url: '' } },
    { id: 'rec2', fields: { 'IAB Code': 'A-2', contentful_url: 'https://app.contentful.com/...' } }
  ];

  const filtered = selectProcessableRecords(records, {
    mode: 'apply',
    redo: false,
    contentfulUrlField: 'contentful_url'
  });

  assert.deepEqual(filtered.map((record) => record.id), ['rec1']);
});

test('selectProcessableRecords keeps all rows in redo mode', () => {
  const records = [
    { id: 'rec1', fields: { contentful_url: '' } },
    { id: 'rec2', fields: { contentful_url: 'https://app.contentful.com/...' } }
  ];

  const filtered = selectProcessableRecords(records, {
    mode: 'apply',
    redo: true,
    contentfulUrlField: 'contentful_url'
  });

  assert.equal(filtered.length, 2);
});

test('resolveTranslationModel uses explicit model when provided', () => {
  const model = resolveTranslationModel('openai', 'custom-model');
  assert.equal(model, 'custom-model');
});

test('buildContentfulEntryUrl builds standard Contentful app entry links', () => {
  const url = buildContentfulEntryUrl({
    spaceId: 'space123',
    envId: 'master',
    entryId: 'entry456'
  });

  assert.equal(url, 'https://app.contentful.com/spaces/space123/environments/master/entries/entry456');
});

test('extractFootnoteNumbers returns footnote ids from numbered lines', () => {
  const numbers = extractFootnoteNumbers('39.See source one\n40. See source two');
  assert.deepEqual(Array.from(numbers).sort(), ['39', '40']);
});

test('formatFootnotes wraps each footnote number with anchor span id', () => {
  const formatted = formatFootnotes('39.See source one\n40. See source two');
  assert.equal(
    formatted,
    '<span id="fn39">39.</span> See source one\n<span id="fn40">40.</span> See source two'
  );
});

test('linkDescriptionFootnotes converts inline numeric markers to superscript links', () => {
  const linked = linkDescriptionFootnotes(
    '...around the world.39\n\nSecond sentence.',
    new Set(['39'])
  );
  assert.equal(
    linked,
    '...around the world.<sup><a href="#fn39">39</a></sup>\n\nSecond sentence.'
  );
});
