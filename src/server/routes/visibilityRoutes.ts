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

/**
 * State-machine RFC-4180 CSV parser supporting newlines inside quoted cells,
 * escaped quotes (""), CRLF/LF line endings, and strict unclosed quote detection.
 */
export function parseCsvRfc4180(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];

    if (inQuotes) {
      if (char === '"') {
        if (csvText[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentCell += char;
      }
      continue;
    }

    if (char === '"') {
      if (currentCell.length === 0) {
        inQuotes = true;
      } else {
        throw new Error('Malformed CSV: unexpected quote inside unquoted field.');
      }
    } else if (char === ',') {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && csvText[i + 1] === '\n') {
        i++;
      }
      currentRow.push(currentCell.trim());
      if (currentRow.some((c) => c.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += char;
    }
  }

  if (inQuotes) {
    throw new Error('Malformed CSV: unclosed quoted field at end of input.');
  }

  currentRow.push(currentCell.trim());
  if (currentRow.some((c) => c.length > 0)) {
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

      const header = rows[0].map((h) => h.toLowerCase().replace(/[\s_-]+/g, ''));
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
        if (row.length === 0 || row.every((c) => !c)) continue;

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
          error: `CSV validation failed on ${rowErrors.length} field(s). No metrics were committed.`,
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

      const dates = parsedMetrics.map((m) => m.observationDate).sort();

      const importRecord: VisibilityImportRecord = {
        id: importId,
        workspaceId,
        filename: typeof filename === 'string' && filename.trim() ? filename.trim() : 'merchant_analytics.csv',
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
