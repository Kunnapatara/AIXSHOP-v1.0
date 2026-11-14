import crypto from 'crypto';
import { Router, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, requireRole } from '../middleware/auth';
import { AuthRequest } from '../types';
import {
  VisibilityImportRecord,
  VisibilityImportRowError,
  VisibilityMetricRecord,
} from '../../domain/monitoring/aiVisibilityTypes';

const MAX_CSV_BYTES = 1_048_576; // 1 MB safety limit
const MAX_CSV_ROWS = 5000;

const SUPPORTED_AI_PLATFORMS: Readonly<Record<string, string>> = {
  'chatgpt search': 'ChatGPT Search',
  'chatgpt': 'ChatGPT Search',
  'openai': 'ChatGPT Search',
  'perplexity shopping': 'Perplexity Shopping',
  'perplexity': 'Perplexity',
  'google ai overviews': 'Google AI Overviews',
  'ai overviews': 'Google AI Overviews',
  'google gemini': 'Google Gemini',
  'gemini': 'Google Gemini',
  'microsoft copilot': 'Microsoft Copilot',
  'copilot': 'Microsoft Copilot',
  'bing copilot': 'Microsoft Copilot',
  'claude': 'Claude',
  'anthropic claude': 'Claude',
  'meta ai': 'Meta AI',
};

type CsvParserState = 'FIELD_START' | 'UNQUOTED' | 'IN_QUOTES' | 'AFTER_CLOSING_QUOTE';

/**
 * Strict RFC-4180 finite-state CSV parser.
 * Contract:
 * - Tracks 4 states: FIELD_START, UNQUOTED, IN_QUOTES, AFTER_CLOSING_QUOTE.
 * - Quoted fields must begin at FIELD_START and end with a closing `"`.
 * - Escaped quotes inside quoted fields must be doubled (`""`).
 * - After a closing quote (AFTER_CLOSING_QUOTE), ONLY comma `,`, `\r`, `\n`, or EOF are valid;
 *   any other character (including `"value"unexpected` or trailing spaces outside quotes) throws with 1-based row number.
 * - Supports commas and embedded newlines (`\n` / `\r\n`) inside quoted fields.
 * - Preserves empty fields and trailing empty fields (e.g. `a,b,` -> ['a', 'b', '']).
 */
export function parseCsvRfc4180(csvText: string): string[][] {
  const input = csvText.startsWith('\uFEFF') ? csvText.slice(1) : csvText;
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let state: CsvParserState = 'FIELD_START';
  let rowHasDelimiterOrContent = false;
  let rowNumber = 1;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (state === 'IN_QUOTES') {
      if (char === '"') {
        if (input[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          state = 'AFTER_CLOSING_QUOTE';
        }
      } else {
        currentCell += char;
      }
      continue;
    }

    if (state === 'AFTER_CLOSING_QUOTE') {
      if (char === ',') {
        currentRow.push(currentCell.trim());
        currentCell = '';
        state = 'FIELD_START';
        rowHasDelimiterOrContent = true;
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && input[i + 1] === '\n') {
          i++;
        }
        currentRow.push(currentCell.trim());
        rows.push(currentRow);
        currentRow = [];
        currentCell = '';
        state = 'FIELD_START';
        rowHasDelimiterOrContent = false;
        rowNumber++;
      } else {
        throw new Error(
          `Malformed CSV at row ${rowNumber}: unexpected character ${JSON.stringify(char)} after closing quote.`
        );
      }
      continue;
    }

    if (state === 'FIELD_START') {
      if (char === '"') {
        state = 'IN_QUOTES';
        rowHasDelimiterOrContent = true;
      } else if (char === ',') {
        currentRow.push('');
        rowHasDelimiterOrContent = true;
      } else if (char === '\r' || char === '\n') {
        if (char === '\r' && input[i + 1] === '\n') {
          i++;
        }
        if (rowHasDelimiterOrContent) {
          currentRow.push('');
          rows.push(currentRow);
        }
        currentRow = [];
        currentCell = '';
        state = 'FIELD_START';
        rowHasDelimiterOrContent = false;
        rowNumber++;
      } else {
        currentCell += char;
        state = 'UNQUOTED';
        rowHasDelimiterOrContent = true;
      }
      continue;
    }

    // state === 'UNQUOTED'
    if (char === '"') {
      throw new Error(`Malformed CSV at row ${rowNumber}: unexpected quote inside unquoted field.`);
    } else if (char === ',') {
      currentRow.push(currentCell.trim());
      currentCell = '';
      state = 'FIELD_START';
      rowHasDelimiterOrContent = true;
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && input[i + 1] === '\n') {
        i++;
      }
      currentRow.push(currentCell.trim());
      rows.push(currentRow);
      currentRow = [];
      currentCell = '';
      state = 'FIELD_START';
      rowHasDelimiterOrContent = false;
      rowNumber++;
    } else {
      currentCell += char;
    }
  }

  if (state === 'IN_QUOTES') {
    throw new Error(`Malformed CSV at row ${rowNumber}: unclosed quoted field at end of input.`);
  }

  if (rowHasDelimiterOrContent || currentRow.length > 0 || state === 'AFTER_CLOSING_QUOTE') {
    currentRow.push(currentCell.trim());
    rows.push(currentRow);
  }

  return rows;
}

function isValidStrictIsoDate(raw: string): { valid: boolean; reason?: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { valid: false, reason: 'Date must strictly match YYYY-MM-DD format.' };
  }
  const [yStr, mStr, dStr] = raw.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return { valid: false, reason: `Calendar date "${raw}" does not exist.` };
  }

  const maxAllowed = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (raw < '2020-01-01' || raw > maxAllowed) {
    return { valid: false, reason: `Date "${raw}" is outside valid observation range (2020-01-01 to ${maxAllowed}).` };
  }
  return { valid: true };
}

function normalizeSupportedPlatform(rawPlatform: string): string | null {
  const key = rawPlatform.trim().toLowerCase().replace(/\s+/g, ' ');
  return SUPPORTED_AI_PLATFORMS[key] || null;
}

export function computeCsvContentHash(csvContent: string): string {
  const canonical = csvContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function createVisibilityRoutes(repo: DatabaseRepository): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(repo);

  // GET /api/visibility/summary — Evidence-backed AI Visibility Monitoring
  router.get('/summary', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const summary = await repo.getVisibilitySummary(workspaceId);

      return res.json({
        success: true,
        summary,
      });
    } catch (err: any) {
      console.error('[Visibility API] Error retrieving summary:', err);
      return res.status(500).json({ error: 'Failed to retrieve visibility summary' });
    }
  });

  // POST /api/visibility/upload — Strict transactional CSV analytics ingestion with deduplication
  router.post('/upload', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const { csvContent, filename, sourcePlatform } = req.body || {};

      if (!csvContent || typeof csvContent !== 'string') {
        return res.status(400).json({ error: 'Missing csvContent string in request body' });
      }

      if (Buffer.byteLength(csvContent, 'utf8') > MAX_CSV_BYTES) {
        return res.status(413).json({
          error: `CSV payload exceeds maximum allowed size of ${MAX_CSV_BYTES} bytes.`,
        });
      }

      let rows: string[][];
      try {
        rows = parseCsvRfc4180(csvContent);
      } catch (parseErr: any) {
        return res.status(400).json({ error: parseErr.message || 'Invalid CSV syntax' });
      }

      if (rows.length < 2) {
        return res.status(400).json({ error: 'CSV file must include a header line and at least one data row' });
      }

      if (rows.length - 1 > MAX_CSV_ROWS) {
        return res.status(400).json({
          error: `CSV exceeds maximum allowed ${MAX_CSV_ROWS} data rows per upload.`,
        });
      }

      const rawHeaderCells = rows[0];
      const expectedColumnCount = rawHeaderCells.length;

      // Reject empty header cells
      if (rawHeaderCells.some((h) => h.trim().length === 0)) {
        return res.status(400).json({
          error: 'Malformed CSV header (row 1): empty column header name is not allowed.',
        });
      }

      const header = rawHeaderCells.map((h) => h.toLowerCase().replace(/[\s_-]+/g, ''));

      // Reject duplicate header names (after canonical normalization)
      const seenHeaders = new Set<string>();
      for (let hIdx = 0; hIdx < header.length; hIdx++) {
        if (seenHeaders.has(header[hIdx])) {
          return res.status(400).json({
            error: `Malformed CSV header (row 1): duplicate column header "${rawHeaderCells[hIdx]}".`,
          });
        }
        seenHeaders.add(header[hIdx]);
      }

      const dateIdx = header.findIndex((h) => h.includes('date') || h.includes('day'));
      const platformIdx = header.findIndex((h) => h.includes('platform') || h.includes('model') || h.includes('engine') || h.includes('source') || h === 'ai');
      const brandMentionsIdx = header.findIndex((h) => h.includes('brandmention') || h === 'brand' || h === 'mentions');
      const productMentionsIdx = header.findIndex((h) => h.includes('productmention') || h.includes('impressions') || h.includes('citations'));
      const clicksIdx = header.findIndex((h) => h.includes('click') || h.includes('visit') || h.includes('referral'));
      const topicIdx = header.findIndex((h) => h.includes('topic') || h.includes('query') || h.includes('keyword') || h.includes('prompt'));
      const evidenceIdx = header.findIndex((h) => h.includes('evidence') || h.includes('url') || h.includes('domain'));

      if (dateIdx === -1) {
        return res.status(400).json({
          error: 'CSV headers must include a "date" or "observation_date" column (e.g. date, platform, brand_mentions, product_mentions, clicks, topic)',
        });
      }

      const importId = `vimp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const nowIso = new Date().toISOString();
      const dedupeMap = new Map<string, VisibilityMetricRecord>();
      const rowErrors: VisibilityImportRowError[] = [];

      const validateNonNegInt = (
        rowIdx: number,
        colIdx: number,
        fieldName: string,
        rawRow: string[]
      ): number => {
        if (colIdx < 0) return 0;
        const raw = (rawRow[colIdx] ?? '').trim();
        if (!raw) {
          rowErrors.push({
            rowNumber: rowIdx + 1,
            field: fieldName,
            value: '',
            reason: `Missing required non-negative integer for "${fieldName}".`,
          });
          return 0;
        }
        if (!/^\d+$/.test(raw)) {
          rowErrors.push({
            rowNumber: rowIdx + 1,
            field: fieldName,
            value: raw,
            reason: `Invalid integer "${raw}" for "${fieldName}". Negative, decimal, or non-numeric values are rejected.`,
          });
          return 0;
        }
        const n = Number(raw);
        if (!Number.isSafeInteger(n) || n < 0) {
          rowErrors.push({
            rowNumber: rowIdx + 1,
            field: fieldName,
            value: raw,
            reason: `Integer overflow or invalid value "${raw}" for "${fieldName}".`,
          });
          return 0;
        }
        return n;
      };

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];

        if (row.length !== expectedColumnCount) {
          rowErrors.push({
            rowNumber: i + 1,
            field: 'row',
            value: `${row.length} column(s)`,
            reason: `Column count mismatch on row ${i + 1}: expected ${expectedColumnCount} column(s) matching header, got ${row.length}.`,
          });
          continue;
        }

        const rawDate = (row[dateIdx] || '').trim();
        const dateCheck = isValidStrictIsoDate(rawDate);
        if (!dateCheck.valid) {
          rowErrors.push({
            rowNumber: i + 1,
            field: 'date',
            value: rawDate,
            reason: dateCheck.reason || 'Invalid date.',
          });
        }

        const rawPlatform = platformIdx >= 0 ? (row[platformIdx] || '').trim() : String(sourcePlatform || '').trim();
        const canonicalPlatform = rawPlatform ? normalizeSupportedPlatform(rawPlatform) : null;
        if (!canonicalPlatform) {
          rowErrors.push({
            rowNumber: i + 1,
            field: 'platform',
            value: rawPlatform,
            reason: rawPlatform
              ? `Unsupported AI platform "${rawPlatform}". Supported: ${Array.from(new Set(Object.values(SUPPORTED_AI_PLATFORMS))).join(', ')}.`
              : 'Platform value is required.',
          });
        }

        const brandMentions = validateNonNegInt(i, brandMentionsIdx, 'brand_mentions', row);
        const productMentions = validateNonNegInt(i, productMentionsIdx, 'product_mentions', row);
        const websiteClicks = validateNonNegInt(i, clicksIdx, 'website_clicks', row);

        if (rowErrors.some((e) => e.rowNumber === i + 1)) {
          continue;
        }

        const topic = (topicIdx >= 0 && row[topicIdx] ? row[topicIdx] : '').trim();
        const evidenceSource = evidenceIdx >= 0 && row[evidenceIdx] ? row[evidenceIdx].trim() : filename || 'merchant_csv';

        const dedupeKey = `${rawDate}::${canonicalPlatform!.toLowerCase()}::${topic.toLowerCase()}`;
        const existing = dedupeMap.get(dedupeKey);

        if (existing) {
          existing.brandMentions += brandMentions;
          existing.productMentions += productMentions;
          existing.websiteClicks += websiteClicks;
        } else {
          dedupeMap.set(dedupeKey, {
            id: `vm_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 6)}`,
            workspaceId,
            importId,
            observationDate: rawDate,
            platform: canonicalPlatform!,
            brandMentions,
            productMentions,
            websiteClicks,
            discoveryTopic: topic || null,
            evidenceSource,
            createdAt: nowIso,
          });
        }
      }

      if (rowErrors.length > 0) {
        return res.status(400).json({
          error: `CSV validation failed on ${rowErrors.length} field(s) (first at row ${rowErrors[0].rowNumber}). No metrics were committed.`,
          status: 'failed',
          acceptedRowCount: 0,
          rejectedRowCount: new Set(rowErrors.map((e) => e.rowNumber)).size,
          errors: rowErrors,
        });
      }

      const parsedMetrics = Array.from(dedupeMap.values());
      if (parsedMetrics.length === 0) {
        return res.status(400).json({ error: 'No valid metric rows could be parsed from CSV' });
      }

      // Check source fingerprint AFTER validation passes so malformed files always fail 400
      const contentHash = computeCsvContentHash(csvContent);
      const duplicateBatch = await repo.getVisibilityImportByHash(workspaceId, contentHash);
      if (duplicateBatch) {
        const summary = await repo.getVisibilitySummary(workspaceId);
        return res.json({
          success: true,
          duplicateImport: true,
          action: 'duplicate_noop',
          acceptedRowCount: 0,
          rejectedRowCount: 0,
          message: 'Identical CSV content was already imported; existing visibility metrics preserved without double-counting.',
          import: duplicateBatch,
          summary,
        });
      }

      const dates = parsedMetrics.map((m) => m.observationDate).sort();

      const importRecord: VisibilityImportRecord = {
        id: importId,
        workspaceId,
        filename: typeof filename === 'string' && filename.trim() ? filename.trim() : 'merchant_analytics.csv',
        contentHash,
        rowCount: parsedMetrics.length,
        rejectedRowCount: 0,
        status: 'completed',
        errors: [],
        reportingPeriodStart: dates[0] || null,
        reportingPeriodEnd: dates[dates.length - 1] || null,
        sourcePlatform: typeof sourcePlatform === 'string' && sourcePlatform.trim() ? sourcePlatform.trim() : 'merchant_csv_upload',
        createdAt: nowIso,
      };

      await repo.saveVisibilityImportAtomic(importRecord, parsedMetrics);

      const summary = await repo.getVisibilitySummary(workspaceId);

      return res.json({
        success: true,
        duplicateImport: false,
        action: 'imported',
        acceptedRowCount: parsedMetrics.length,
        rejectedRowCount: 0,
        import: importRecord,
        summary,
      });
    } catch (err: any) {
      console.error('[Visibility API] Error uploading CSV:', err);
      return res.status(500).json({ error: 'Failed to process visibility data upload' });
    }
  });

  return router;
}
