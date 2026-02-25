import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { listAirtableRecords } from './airtable-client.mjs';

const DEFAULT_TITLE_MAX = 255;
const ISSUE_MULTIPLE_IAB_CODES = 'multiple_iab_codes';
const ISSUE_IAB_CODE_CONTAINS_PAGE = 'iab_code_contains_page';
const ISSUE_TITLE_TOO_LONG = 'title_too_long';

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
  const options = parseIssuesCliOptions(process.argv.slice(2));
  const titleMax = clampInt(options.titleMax, 1, 5000, DEFAULT_TITLE_MAX);

  const records = await listAirtableRecords({
    apiKey: process.env.AIRTABLE_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID,
    tableName: process.env.AIRTABLE_TABLE_NAME,
    fields: ['IAB Code', 'Title of Object'],
    maxRecords: options.maxRecords,
    view: options.view,
    filterByFormula: options.filterByFormula
  });

  const analysis = analyzeAirtableIssues(records, { titleMax });

  if (options.outputPath !== null) {
    const reportPath = writeIssuesReport(analysis, options.outputPath);
    console.log(`Wrote issues report: ${reportPath}`);
  }

  if (options.json) {
    console.log(JSON.stringify(analysis, null, 2));
    return;
  }

  printIssuesSummary(analysis);
}

export function parseIssuesCliOptions(argv) {
  const options = {
    json: false,
    outputPath: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--max' && argv[i + 1]) {
      options.maxRecords = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg.startsWith('--max=')) {
      options.maxRecords = Number.parseInt(arg.slice('--max='.length), 10);
      continue;
    }
    if (arg === '--view' && argv[i + 1]) {
      options.view = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--view=')) {
      options.view = arg.slice('--view='.length);
      continue;
    }
    if (arg === '--filter-by-formula' && argv[i + 1]) {
      options.filterByFormula = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--filter-by-formula=')) {
      options.filterByFormula = arg.slice('--filter-by-formula='.length);
      continue;
    }
    if (arg === '--title-max' && argv[i + 1]) {
      options.titleMax = Number.parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (arg.startsWith('--title-max=')) {
      options.titleMax = Number.parseInt(arg.slice('--title-max='.length), 10);
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--output' && argv[i + 1]) {
      options.outputPath = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      options.outputPath = arg.slice('--output='.length);
      continue;
    }
    if (arg === '--write-report') {
      options.outputPath = defaultIssuesReportPath();
      continue;
    }
  }

  return options;
}

export function analyzeAirtableIssues(records, options = {}) {
  const titleMax = clampInt(options.titleMax, 1, 5000, DEFAULT_TITLE_MAX);
  const output = {
    generatedAt: new Date().toISOString(),
    checks: {
      iabCode: {
        commaSeparatedMultipleCodes: true,
        containsPageSubstring: true
      },
      title: {
        maxLength: titleMax
      }
    },
    totals: {
      recordsScanned: 0,
      recordsWithIssues: 0,
      issuesByType: {
        [ISSUE_MULTIPLE_IAB_CODES]: 0,
        [ISSUE_IAB_CODE_CONTAINS_PAGE]: 0,
        [ISSUE_TITLE_TOO_LONG]: 0
      }
    },
    issues: []
  };

  for (const record of records) {
    output.totals.recordsScanned += 1;
    const fields = record?.fields || {};
    const iabCode = normalizeValue(fields['IAB Code']);
    const title = normalizeValue(fields['Title of Object']);
    const recordIssues = [];

    if (hasMultipleIabCodes(iabCode)) {
      recordIssues.push({
        type: ISSUE_MULTIPLE_IAB_CODES,
        message: 'IAB Code contains a comma, which suggests multiple codes in one record.'
      });
    }

    if (containsPageText(iabCode)) {
      recordIssues.push({
        type: ISSUE_IAB_CODE_CONTAINS_PAGE,
        message: 'IAB Code contains "page".'
      });
    }

    if (title && title.length > titleMax) {
      recordIssues.push({
        type: ISSUE_TITLE_TOO_LONG,
        message: `Title exceeds ${titleMax} characters.`,
        details: {
          titleLength: title.length
        }
      });
    }

    if (recordIssues.length === 0) {
      continue;
    }

    output.totals.recordsWithIssues += 1;
    for (const issue of recordIssues) {
      output.totals.issuesByType[issue.type] += 1;
    }

    output.issues.push({
      recordId: record?.id || null,
      iabCode,
      title,
      issues: recordIssues
    });
  }

  return output;
}

export function hasMultipleIabCodes(iabCode) {
  if (!iabCode) {
    return false;
  }
  return iabCode.includes(',');
}

export function containsPageText(iabCode) {
  if (!iabCode) {
    return false;
  }
  return /page/i.test(iabCode);
}

function printIssuesSummary(analysis) {
  console.log(`Records scanned: ${analysis.totals.recordsScanned}`);
  console.log(`Records with issues: ${analysis.totals.recordsWithIssues}`);
  console.log(`- ${ISSUE_MULTIPLE_IAB_CODES}: ${analysis.totals.issuesByType[ISSUE_MULTIPLE_IAB_CODES]}`);
  console.log(`- ${ISSUE_IAB_CODE_CONTAINS_PAGE}: ${analysis.totals.issuesByType[ISSUE_IAB_CODE_CONTAINS_PAGE]}`);
  console.log(`- ${ISSUE_TITLE_TOO_LONG}: ${analysis.totals.issuesByType[ISSUE_TITLE_TOO_LONG]}`);

  if (analysis.issues.length === 0) {
    console.log('No issues found.');
    return;
  }

  console.log('');
  console.log('Affected records:');
  for (const item of analysis.issues) {
    const issueTypes = item.issues.map((issue) => issue.type).join(', ');
    const titleLength = item.title ? item.title.length : 0;
    console.log(`${item.recordId || '(no id)'}\t${issueTypes}\t${item.iabCode || ''}\ttitleLength=${titleLength}`);
  }
}

function writeIssuesReport(analysis, explicitPath) {
  const reportPath = explicitPath || defaultIssuesReportPath();
  const absolutePath = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, `${JSON.stringify(analysis, null, 2)}\n`, 'utf8');
  return absolutePath;
}

function defaultIssuesReportPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join('reports', `airtable-issues-${timestamp}.json`);
}

function normalizeValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const str = String(value).trim();
  return str === '' ? null : str;
}

function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}
