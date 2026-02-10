import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTransform,
  findDuplicates,
  norm,
  parseCliOptions,
  resolveTranslationModel,
  shouldTranslateAr,
  splitDateParts,
  validateCsvHeaders,
  validateEnvForMode,
  validateMappingShape
} from '../src/import-cli.mjs';

test('parseCliOptions parses supported flags', () => {
  const options = parseCliOptions([
    '--csv',
    'data.csv',
    '--mapping',
    'config/mapping.json',
    '--progress=ON'
  ]);

  assert.deepEqual(options, {
    csv: 'data.csv',
    mapping: 'config/mapping.json',
    progress: 'on'
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

test('validateCsvHeaders fails when mapped headers are missing', () => {
  const mapping = {
    fieldMappings: [
      {
        fieldId: 'title',
        source: { 'en-US': 'Title', ar: 'Title AR' }
      }
    ]
  };
  const rows = [{ Title: 'Sample title' }];

  assert.throws(() => validateCsvHeaders(mapping, rows), /CSV missing mapped header/);
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

test('resolveTranslationModel uses explicit model when provided', () => {
  const model = resolveTranslationModel('openai', 'custom-model');
  assert.equal(model, 'custom-model');
});
