import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCdaEntriesUrl,
  buildCdaHeaders,
  removeStaleManifests,
  validateDeliveryHost
} from '../src/export-iiif-cli.mjs';

test('validateDeliveryHost accepts allowed Contentful hosts', () => {
  assert.equal(validateDeliveryHost('cdn.contentful.com'), 'cdn.contentful.com');
  assert.equal(validateDeliveryHost('preview.contentful.com'), 'preview.contentful.com');
});

test('validateDeliveryHost rejects untrusted or malformed hosts', () => {
  assert.throws(() => validateDeliveryHost('evil.example.com'), /Unsupported CONTENTFUL_DELIVERY_HOST/);
  assert.throws(
    () => validateDeliveryHost('cdn.contentful.com/path'),
    /Invalid CONTENTFUL_DELIVERY_HOST format/
  );
  assert.throws(
    () => validateDeliveryHost('cdn.contentful.com:8443'),
    /custom ports are not allowed/
  );
  assert.throws(
    () => validateDeliveryHost('https://cdn.contentful.com'),
    /Invalid CONTENTFUL_DELIVERY_HOST format/
  );
});

test('buildCdaEntriesUrl excludes access_token query params and uses expected filters', () => {
  const url = buildCdaEntriesUrl({
    deliveryHost: 'cdn.contentful.com',
    spaceId: 'space123',
    environmentId: 'master',
    contentTypeId: 'article',
    limit: 1000,
    skip: 2000
  });

  assert.equal(url.includes('access_token='), false);
  assert.equal(url.includes('content_type=article'), true);
  assert.equal(url.includes('limit=1000'), true);
  assert.equal(url.includes('skip=2000'), true);
});

test('buildCdaHeaders uses Authorization bearer token header', () => {
  const headers = buildCdaHeaders('secret-token');
  assert.deepEqual(headers, { Authorization: 'Bearer secret-token' });
});

test('removeStaleManifests only deletes files within outputDir boundary', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-security-'));
  const outputDir = path.join(tempRoot, 'manifests');
  const outsideFile = path.join(tempRoot, 'outside.json');
  const staleManifest = path.join(outputDir, 'stale.json');

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outsideFile, '{"outside":true}\n', 'utf8');
  fs.writeFileSync(staleManifest, '{"stale":true}\n', 'utf8');

  const removed = removeStaleManifests({
    outputDir,
    nextIndex: { manifests: {} },
    previousIndex: {
      manifests: {
        safe: { fileName: 'stale.json' },
        malicious: { fileName: '../outside.json' }
      }
    },
    collectionFileName: 'collection.json'
  });

  assert.equal(removed, 1);
  assert.equal(fs.existsSync(staleManifest), false);
  assert.equal(fs.existsSync(outsideFile), true);

  fs.rmSync(tempRoot, { recursive: true, force: true });
});
