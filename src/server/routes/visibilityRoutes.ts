import { Router, Response } from 'express';
import { DatabaseRepository } from '../db/repository';
import { createAuthMiddleware, requireRole } from '../middleware/auth';
import { AuthRequest } from '../types';
import { VisibilityImportRecord, VisibilityMetricRecord } from '../../domain/monitoring/aiVisibilityTypes';

function parseCsvLines(csvText: string): string[][] {
  const lines: string[][] = [];
  const rawLines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);

  for (const line of rawLines) {
    const row: string[] = [];
    let inQuotes = false;
    let currentCell = '';

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          currentCell += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        row.push(currentCell.trim());
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    row.push(currentCell.trim());
    lines.push(row);
  }

  return lines;
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

  // POST /api/visibility/upload — Merchant CSV analytics ingestion with deduplication
  router.post('/upload', requireAuth, requireRole(['owner', 'admin']), async (req: AuthRequest, res: Response) => {
    try {
      const workspaceId = req.workspace!.id;
      const { csvContent, filename, sourcePlatform } = req.body || {};

      if (!csvContent || typeof csvContent !== 'string') {
        return res.status(400).json({ error: 'Missing csvContent string in request body' });
      }

      const rows = parseCsvLines(csvContent);
      if (rows.length < 2) {
        return res.status(400).json({ error: 'CSV file must include a header line and at least one data row' });
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

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.length === 0 || row.every((c) => !c)) continue;

        const rawDate = (row[dateIdx] || '').trim();
        const observationDate = /^\d{4}-\d{2}-\d{2}/.test(rawDate)
          ? rawDate.slice(0, 10)
          : new Date().toISOString().slice(0, 10);

        const platform = (platformIdx >= 0 && row[platformIdx] ? row[platformIdx] : sourcePlatform || 'ChatGPT Search').trim();
        const topic = (topicIdx >= 0 && row[topicIdx] ? row[topicIdx] : '').trim();

        const parseNonNegInt = (idx: number, fallback: number) => {
          if (idx < 0 || !row[idx]) return fallback;
          const n = parseInt(row[idx], 10);
          return !isNaN(n) && n >= 0 ? n : fallback;
        };

        const brandMentions = parseNonNegInt(brandMentionsIdx, 0);
        const productMentions = parseNonNegInt(productMentionsIdx, 0);
        const websiteClicks = parseNonNegInt(clicksIdx, 0);
        const evidenceSource = evidenceIdx >= 0 && row[evidenceIdx] ? row[evidenceIdx].trim() : filename || 'merchant_csv';

        const dedupeKey = `${observationDate}::${platform.toLowerCase()}::${topic.toLowerCase()}`;
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
            observationDate,
            platform,
            brandMentions,
            productMentions,
            websiteClicks,
            discoveryTopic: topic || null,
            evidenceSource,
            createdAt: nowIso,
          });
        }
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
        reportingPeriodStart: dates[0] || null,
        reportingPeriodEnd: dates[dates.length - 1] || null,
        sourcePlatform: typeof sourcePlatform === 'string' && sourcePlatform.trim() ? sourcePlatform.trim() : 'merchant_csv_upload',
        createdAt: nowIso,
      };

      await repo.saveVisibilityImport(importRecord);
      await repo.saveVisibilityMetrics(parsedMetrics);

      const summary = await repo.getVisibilitySummary(workspaceId);

      return res.json({
        success: true,
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
