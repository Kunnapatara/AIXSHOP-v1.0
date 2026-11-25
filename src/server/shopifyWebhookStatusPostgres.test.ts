import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { getPostgresPoolConfig } from './db/index';
import { PostgresRepository } from './db/postgresRepository';

const hasLivePg = Boolean(process.env.DATABASE_URL || process.env.SQL_HOST || process.env.PGHOST);

describe('PostgreSQL 16 Regression: updateShopifyWebhookEventStatus', () => {
  test(
    'supports all status transitions, lease ownership enforcement, expired lease rejection, and non-lease updates',
    { skip: !hasLivePg },
    async () => {
      const pgConfig = getPostgresPoolConfig();
      assert.ok(pgConfig, 'Live PostgreSQL config must exist when test runs');

      const pool = new Pool(pgConfig);
      const pgRepo = new PostgresRepository(pool);
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const userId = `u_wh_status_${suffix}`;
      const wsId = `ws_wh_status_${suffix}`;
      const shopDomain = `wh-status-${suffix.replace(/_/g, '-')}.myshopify.com`;
      const topic = 'products/update';

      const selectEventRow = async (eventId: string) => {
        const res = await pool.query<{
          status: string;
          last_error: string | null;
          lease_owner: string | null;
          lease_expires_at: Date | null;
          processed_at: Date | null;
          updated_at: Date | null;
        }>(
          `SELECT status, last_error, lease_owner, lease_expires_at, processed_at, updated_at
           FROM shopify_webhook_events
           WHERE shop_domain = $1 AND topic = $2 AND event_id = $3`,
          [shopDomain, topic, eventId]
        );
        assert.equal(res.rows.length, 1, `Expected 1 row for event ${eventId}`);
        return res.rows[0];
      };

      const claimEvent = async (eventId: string, leaseOwner: string, leaseDurationMs = 60_000) => {
        const nowIso = new Date().toISOString();
        const claim = await pgRepo.claimShopifyWebhookEvent(
          {
            id: `whevt_${suffix}_${eventId}`,
            workspaceId: wsId,
            shopDomain,
            eventId,
            topic,
            deliveryId: `deliv_${eventId}`,
            payload: { id: eventId },
            status: 'processing',
            retryCount: 0,
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          { leaseOwner, leaseDurationMs }
        );
        assert.equal(claim.claimed, true);
        assert.equal(claim.leaseOwner, leaseOwner);
        return claim;
      };

      try {
        await pgRepo.createUser({
          id: userId,
          email: `wh_status_${suffix}@example.com`,
          passwordHash: 'hash_unused',
          fullName: 'Webhook Status Tester',
        });
        await pgRepo.createWorkspace(
          { id: wsId, name: 'Webhook Status Store', slug: `wh-status-${suffix}` },
          userId
        );

        // A. Update to 'processing': preserves lease_expires_at and does not populate processed_at
        const evtProcessing = `evt_proc_${suffix}`;
        const ownerProcessing = `worker_proc_${suffix}`;
        await claimEvent(evtProcessing, ownerProcessing);
        const beforeProcessingRow = await selectEventRow(evtProcessing);
        assert.ok(beforeProcessingRow.lease_expires_at, 'Claimed row must have lease_expires_at');
        assert.equal(beforeProcessingRow.processed_at, null);

        await pgRepo.updateShopifyWebhookEventStatus(
          evtProcessing,
          shopDomain,
          topic,
          'processing',
          'retrying chunk',
          ownerProcessing
        );
        const afterProcessingRow = await selectEventRow(evtProcessing);
        assert.equal(afterProcessingRow.status, 'processing');
        assert.equal(afterProcessingRow.last_error, 'retrying chunk');
        assert.equal(afterProcessingRow.lease_owner, ownerProcessing);
        assert.ok(afterProcessingRow.lease_expires_at, 'lease_expires_at must remain set when status is processing');
        assert.equal(
          afterProcessingRow.lease_expires_at!.getTime(),
          beforeProcessingRow.lease_expires_at!.getTime(),
          'lease_expires_at must be preserved when staying in processing'
        );
        assert.equal(afterProcessingRow.processed_at, null, 'processed_at must remain null when processing');
        assert.ok(afterProcessingRow.updated_at);

        // B. Update to 'processed': clears lease_expires_at and populates processed_at
        await pgRepo.updateShopifyWebhookEventStatus(
          evtProcessing,
          shopDomain,
          topic,
          'processed',
          undefined,
          ownerProcessing
        );
        const afterProcessedRow = await selectEventRow(evtProcessing);
        assert.equal(afterProcessedRow.status, 'processed');
        assert.equal(afterProcessedRow.last_error, null);
        assert.equal(afterProcessedRow.lease_expires_at, null, 'lease_expires_at must be cleared on processed');
        assert.ok(afterProcessedRow.processed_at instanceof Date, 'processed_at must be populated on processed');

        // C. Update to 'failed': clears lease_expires_at, persists last_error, leaves processed_at null
        const evtFailed = `evt_fail_${suffix}`;
        const ownerFailed = `worker_fail_${suffix}`;
        await claimEvent(evtFailed, ownerFailed);
        await pgRepo.updateShopifyWebhookEventStatus(
          evtFailed,
          shopDomain,
          topic,
          'failed',
          'simulated downstream timeout',
          ownerFailed
        );
        const afterFailedRow = await selectEventRow(evtFailed);
        assert.equal(afterFailedRow.status, 'failed');
        assert.equal(afterFailedRow.last_error, 'simulated downstream timeout');
        assert.equal(afterFailedRow.lease_expires_at, null, 'lease_expires_at must be cleared on failed');
        assert.equal(afterFailedRow.processed_at, null, 'processed_at must not be populated on failed');

        // D. Update to 'ignored': clears lease_expires_at and persists optional reason
        const evtIgnored = `evt_ign_${suffix}`;
        const ownerIgnored = `worker_ign_${suffix}`;
        await claimEvent(evtIgnored, ownerIgnored);
        await pgRepo.updateShopifyWebhookEventStatus(
          evtIgnored,
          shopDomain,
          topic,
          'ignored',
          'stale out-of-order event',
          ownerIgnored
        );
        const afterIgnoredRow = await selectEventRow(evtIgnored);
        assert.equal(afterIgnoredRow.status, 'ignored');
        assert.equal(afterIgnoredRow.last_error, 'stale out-of-order event');
        assert.equal(afterIgnoredRow.lease_expires_at, null, 'lease_expires_at must be cleared on ignored');
        assert.equal(afterIgnoredRow.processed_at, null);

        // E1. Wrong leaseOwner rejects cleanly and leaves row unchanged
        const evtLease = `evt_lease_${suffix}`;
        const rightOwner = `worker_right_${suffix}`;
        const wrongOwner = `worker_wrong_${suffix}`;
        await claimEvent(evtLease, rightOwner);
        await assert.rejects(
          () =>
            pgRepo.updateShopifyWebhookEventStatus(
              evtLease,
              shopDomain,
              topic,
              'processed',
              undefined,
              wrongOwner
            ),
          /lease ownership lost or expired/i
        );
        const afterWrongOwnerRow = await selectEventRow(evtLease);
        assert.equal(afterWrongOwnerRow.status, 'processing');
        assert.equal(afterWrongOwnerRow.lease_owner, rightOwner);
        assert.ok(afterWrongOwnerRow.lease_expires_at);
        assert.equal(afterWrongOwnerRow.processed_at, null);

        // E2. Expired lease rejects even for matching leaseOwner and leaves row unchanged
        await pool.query(
          `UPDATE shopify_webhook_events
           SET lease_expires_at = clock_timestamp() - INTERVAL '10 seconds'
           WHERE shop_domain = $1 AND topic = $2 AND event_id = $3`,
          [shopDomain, topic, evtLease]
        );
        await assert.rejects(
          () =>
            pgRepo.updateShopifyWebhookEventStatus(
              evtLease,
              shopDomain,
              topic,
              'processed',
              undefined,
              rightOwner
            ),
          /lease ownership lost or expired/i
        );
        const afterExpiredRow = await selectEventRow(evtLease);
        assert.equal(afterExpiredRow.status, 'processing');
        assert.equal(afterExpiredRow.lease_owner, rightOwner);
        assert.equal(afterExpiredRow.processed_at, null);

        // F. Non-lease update path (leaseOwner omitted) updates cleanly
        await pgRepo.updateShopifyWebhookEventStatus(
          evtLease,
          shopDomain,
          topic,
          'processed',
          undefined
        );
        const afterNonLeaseRow = await selectEventRow(evtLease);
        assert.equal(afterNonLeaseRow.status, 'processed');
        assert.equal(afterNonLeaseRow.lease_expires_at, null);
        assert.ok(afterNonLeaseRow.processed_at instanceof Date);
      } finally {
        await pool.query('DELETE FROM shopify_webhook_events WHERE workspace_id = $1', [wsId]).catch(() => {});
        await pool.query('DELETE FROM workspaces WHERE id = $1', [wsId]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
        await pool.end();
      }
    }
  );

  test(
    'transactional commitShopifyWebhookMutationAtomic executes updateShopifyWebhookEventStatusWithClient cleanly on PostgreSQL 16',
    { skip: !hasLivePg },
    async () => {
      const pgConfig = getPostgresPoolConfig();
      assert.ok(pgConfig, 'Live PostgreSQL config must exist when test runs');

      const pool = new Pool(pgConfig);
      const pgRepo = new PostgresRepository(pool);
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const userId = `u_wh_tx_${suffix}`;
      const wsId = `ws_wh_tx_${suffix}`;
      const shopDomain = `wh-tx-${suffix.replace(/_/g, '-')}.myshopify.com`;
      const topic = 'products/update';

      try {
        await pgRepo.createUser({
          id: userId,
          email: `wh_tx_${suffix}@example.com`,
          passwordHash: 'hash_unused',
          fullName: 'Webhook TX Tester',
        });
        await pgRepo.createWorkspace(
          { id: wsId, name: 'Webhook TX Store', slug: `wh-tx-${suffix}` },
          userId
        );

        // 1. Atomic ignored mutation (with webhookError) inside transaction
        const evtIgnored = `evt_tx_ign_${suffix}`;
        const claimIgnored = await pgRepo.claimShopifyWebhookEvent(
          {
            id: `whevt_${suffix}_${evtIgnored}`,
            workspaceId: wsId,
            shopDomain,
            eventId: evtIgnored,
            topic,
            deliveryId: `deliv_${evtIgnored}`,
            payload: { id: evtIgnored },
            status: 'processing',
            retryCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { leaseOwner: `tx_worker_${suffix}`, leaseDurationMs: 60_000 }
        );
        assert.equal(claimIgnored.claimed, true);

        const ignResult = await pgRepo.commitShopifyWebhookMutationAtomic({
          workspaceId: wsId,
          shopDomain,
          topic,
          eventId: evtIgnored,
          leaseOwner: claimIgnored.leaseOwner,
          defaultWebhookStatus: 'processed',
          applyMutation: async () => ({
            webhookStatus: 'ignored',
            webhookError: 'Out-of-order timestamp ignored',
            result: 'ignored_ok',
          }),
        });
        assert.equal(ignResult.result, 'ignored_ok');

        const ignRowRes = await pool.query<{
          status: string;
          last_error: string | null;
          lease_expires_at: Date | null;
          processed_at: Date | null;
        }>(
          `SELECT status, last_error, lease_expires_at, processed_at
           FROM shopify_webhook_events
           WHERE shop_domain = $1 AND topic = $2 AND event_id = $3`,
          [shopDomain, topic, evtIgnored]
        );
        assert.equal(ignRowRes.rows[0].status, 'ignored');
        assert.equal(ignRowRes.rows[0].last_error, 'Out-of-order timestamp ignored');
        assert.equal(ignRowRes.rows[0].lease_expires_at, null);
        assert.equal(ignRowRes.rows[0].processed_at, null);

        // 2. Atomic processed mutation inside transaction
        const evtProcessed = `evt_tx_proc_${suffix}`;
        const claimProcessed = await pgRepo.claimShopifyWebhookEvent(
          {
            id: `whevt_${suffix}_${evtProcessed}`,
            workspaceId: wsId,
            shopDomain,
            eventId: evtProcessed,
            topic,
            deliveryId: `deliv_${evtProcessed}`,
            payload: { id: evtProcessed },
            status: 'processing',
            retryCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { leaseOwner: `tx_worker2_${suffix}`, leaseDurationMs: 60_000 }
        );
        assert.equal(claimProcessed.claimed, true);

        const procResult = await pgRepo.commitShopifyWebhookMutationAtomic({
          workspaceId: wsId,
          shopDomain,
          topic,
          eventId: evtProcessed,
          leaseOwner: claimProcessed.leaseOwner,
          defaultWebhookStatus: 'processed',
          applyMutation: async () => ({
            webhookStatus: 'processed',
            result: 'processed_ok',
          }),
        });
        assert.equal(procResult.result, 'processed_ok');

        const procRowRes = await pool.query<{
          status: string;
          last_error: string | null;
          lease_expires_at: Date | null;
          processed_at: Date | null;
        }>(
          `SELECT status, last_error, lease_expires_at, processed_at
           FROM shopify_webhook_events
           WHERE shop_domain = $1 AND topic = $2 AND event_id = $3`,
          [shopDomain, topic, evtProcessed]
        );
        assert.equal(procRowRes.rows[0].status, 'processed');
        assert.equal(procRowRes.rows[0].last_error, null);
        assert.equal(procRowRes.rows[0].lease_expires_at, null);
        assert.ok(procRowRes.rows[0].processed_at instanceof Date);
      } finally {
        await pool.query('DELETE FROM shopify_webhook_events WHERE workspace_id = $1', [wsId]).catch(() => {});
        await pool.query('DELETE FROM workspaces WHERE id = $1', [wsId]).catch(() => {});
        await pool.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
        await pool.end();
      }
    }
  );
});
