import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const options = parseCliOptions(args);

const reportsDir = options.reportsDir || 'reports';
const outputPath = options.output || path.join(reportsDir, 'human-readable-errors.md');

const reportFiles = listReportFiles(reportsDir);
if (reportFiles.length === 0) {
  console.error(`No report files found in ${reportsDir}`);
  process.exit(1);
}

const selectedFiles = options.all ? reportFiles : [reportFiles[reportFiles.length - 1]];
const reports = selectedFiles.map((filePath) => {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return { filePath, data };
});

const markdown = buildMarkdown(reports);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${markdown}\n`, 'utf8');

console.log(
  `Scanned ${reports.length} report file(s) ${options.all ? '(all)' : '(latest only)'} out of ${reportFiles.length}.`
);
console.log(`Wrote: ${outputPath}`);

function parseCliOptions(argv) {
  const parsed = { all: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--reports-dir' && argv[i + 1]) {
      parsed.reportsDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (argv[i] === '--output' && argv[i + 1]) {
      parsed.output = argv[i + 1];
      i += 1;
      continue;
    }
    if (argv[i] === '--all') {
      parsed.all = true;
    }
  }
  return parsed;
}

function listReportFiles(reportsDirPath) {
  if (!fs.existsSync(reportsDirPath)) {
    return [];
  }

  return fs
    .readdirSync(reportsDirPath)
    .filter((name) => /^import-.*\.json$/i.test(name))
    .sort()
    .map((name) => path.join(reportsDirPath, name));
}

function buildMarkdown(reportItems) {
  const lines = [];
  const generatedAt = new Date().toISOString();
  const allRows = [];

  lines.push('# Import Error Summary');
  lines.push('');
  lines.push(`Generated: ${generatedAt}`);
  lines.push(`Reports scanned: ${reportItems.length}`);
  lines.push('');

  for (const report of reportItems) {
    const rows = Array.isArray(report.data?.rows) ? report.data.rows : [];
    const failingRows = rows.filter((row) => isProblemRow(row));

    allRows.push(...failingRows);
    lines.push(`## ${path.basename(report.filePath)}`);
    lines.push('');
    lines.push(`- Mode: \`${report.data?.mode || 'unknown'}\``);
    lines.push(`- Problem rows: ${failingRows.length}`);
    lines.push('');

    if (failingRows.length === 0) {
      lines.push('_No problem rows in this report._');
      lines.push('');
      continue;
    }

    for (const row of failingRows) {
      lines.push(`### Row ${row.rowNumber} (${row.iabCode || 'no iabCode'})`);
      lines.push('');
      lines.push(`- Status: \`${row.status || 'unknown'}\``);

      if (Array.isArray(row.missingRequired) && row.missingRequired.length > 0) {
        lines.push(`- Missing required: ${row.missingRequired.join(', ')}`);
      }

      const errorEntries = normalizeErrors(row.errors);
      if (errorEntries.length === 0) {
        lines.push('- Error details: none provided');
        lines.push('');
        continue;
      }

      for (let i = 0; i < errorEntries.length; i += 1) {
        const error = errorEntries[i];
        lines.push(`- Error ${i + 1}: ${error.message}`);

        if (error.requestId) {
          lines.push(`- Request ID: \`${error.requestId}\``);
        }

        for (const detail of error.details) {
          const detailValue = detail.value ? ` (value preview: "${detail.value}")` : '';
          lines.push(
            `  - Field: \`${detail.path || 'unknown'}\` -> ${detail.detail || 'No extra detail'}${detailValue}`
          );
          lines.push(`  - Suggested action: ${detail.suggestion}`);
        }
      }

      lines.push('');
    }
  }

  lines.push('## Overall');
  lines.push('');
  lines.push(`Total problem rows across all reports: ${allRows.length}`);
  return lines.join('\n');
}

function isProblemRow(row) {
  if (!row || typeof row !== 'object') {
    return false;
  }

  if (Array.isArray(row.errors) && row.errors.length > 0) {
    return true;
  }

  return ['failed_contentful', 'failed_translation', 'failed_validation', 'skipped_missing_required', 'skipped_invalid_enum'].includes(row.status);
}

function normalizeErrors(rawErrors) {
  if (!Array.isArray(rawErrors) || rawErrors.length === 0) {
    return [];
  }

  const parsed = [];
  for (const raw of rawErrors) {
    parsed.push(parseError(raw));
  }
  return parsed;
}

function parseError(raw) {
  const fallbackMessage = typeof raw === 'string' ? raw : JSON.stringify(raw);

  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      message: parsed.message || fallbackMessage,
      requestId: parsed.requestId || null,
      details: extractDetailErrors(parsed)
    };
  } catch {
    return {
      message: fallbackMessage,
      requestId: null,
      details: []
    };
  }
}

function extractDetailErrors(parsedError) {
  const detailErrors = parsedError?.details?.errors;
  if (!Array.isArray(detailErrors)) {
    return [];
  }

  return detailErrors.map((item) => {
    const fieldPath = Array.isArray(item.path) ? item.path.join('.') : null;
    const valuePreview = previewValue(item.value);
    return {
      path: fieldPath,
      detail: item.details || item.name || 'Unspecified validation error',
      value: valuePreview,
      suggestion: suggestAction(item.details, fieldPath)
    };
  });
}

function previewValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const str = String(value).replace(/\s+/g, ' ').trim();
  if (!str) {
    return null;
  }
  if (str.length <= 80) {
    return str;
  }
  return `${str.slice(0, 77)}...`;
}

function suggestAction(detailText, pathText) {
  const detail = String(detailText || '').toLowerCase();
  const path = String(pathText || '');

  if (detail.includes('maximum symbol length is 255')) {
    return `Trim this value in source data or map \`${path}\` to a Contentful Text field instead of Symbol.`;
  }

  if (detail.includes('required')) {
    return 'Populate the missing required value in Airtable or mapping before rerunning import.';
  }

  if (detail.includes('invalid')) {
    return 'Use one of the allowed enum values configured in the content type.';
  }

  return 'Inspect this field value and mapping, then update source data or content model as needed.';
}
