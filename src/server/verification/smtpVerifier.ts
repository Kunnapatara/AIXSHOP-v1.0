import {
  VerificationCheckResult,
  StageVerificationSummary,
  evaluateCommercialReadiness,
  summarizeStage,
  redactSecrets,
} from './statusModel';
import {
  sendTransactionalEmail,
  validateSmtpConfig,
  verifySmtpConnection,
} from '../services/emailService';

export interface SmtpExternalVerifyOptions {
  targetEnvironment?: string;
  timeoutMs?: number;
}

const ALL_SMTP_CHECK_DEFS: Array<{ testId: string; name: string; purpose: string }> = [
  {
    testId: 'S3-CONFIG-POLICY',
    name: 'SMTP host, port, TLS/STARTTLS, auth & sender validation',
    purpose: 'Verify provider-independent SMTP configuration and non-.local sender policy',
  },
  {
    testId: 'S3-HANDSHAKE-AUTH',
    name: 'Live SMTP TCP/TLS/STARTTLS & AUTH handshake verification',
    purpose: 'Verify real SMTP server connection, TLS negotiation, EHLO, and credentials without sending email',
  },
  {
    testId: 'S3-SMOKE-SEND',
    name: 'Real SMTP smoke-test message send & relay acceptance',
    purpose: 'Send tagged test email to SMTP_TEST_RECIPIENT and record SMTP acceptance + Message-ID',
  },
];

export async function runSmtpExternalVerification(
  options: SmtpExternalVerifyOptions = {}
): Promise<StageVerificationSummary> {
  const readiness = evaluateCommercialReadiness();
  const stageReadiness = readiness.integrations.stage_3_smtp;
  const host = process.env.SMTP_HOST?.trim() || 'unconfigured-smtp';
  const targetEnv = options.targetEnvironment || host;
  const nowIso = () => new Date().toISOString();

  if (stageReadiness.status !== 'READY') {
    const blockedChecks: VerificationCheckResult[] = ALL_SMTP_CHECK_DEFS.map((def) => ({
      testId: def.testId,
      stage: 'stage_3_smtp',
      name: def.name,
      purpose: def.purpose,
      status: 'BLOCKED',
      executionMode: 'external_provider',
      targetEnvironment: targetEnv,
      executedAt: nowIso(),
      blockerOrFailure: `Missing prerequisites: ${stageReadiness.missingEnvVars.join(', ')}`,
    }));

    return summarizeStage(
      'stage_3_smtp',
      'Stage 3 — Real SMTP Provider',
      blockedChecks,
      stageReadiness.missingEnvVars
    );
  }

  const recipient = process.env.SMTP_TEST_RECIPIENT!.trim();
  const checks: VerificationCheckResult[] = [];

  // Check 1: Config Validation
  const cfg = validateSmtpConfig({ isProd: false });
  checks.push({
    testId: 'S3-CONFIG-POLICY',
    stage: 'stage_3_smtp',
    name: ALL_SMTP_CHECK_DEFS[0].name,
    purpose: ALL_SMTP_CHECK_DEFS[0].purpose,
    status: cfg.valid ? 'PASS' : 'FAIL',
    executionMode: 'external_provider',
    targetEnvironment: `${host}:${cfg.port}`,
    executedAt: nowIso(),
    evidence: {
      host,
      port: cfg.port,
      secure: cfg.secure,
      starttlsMode: cfg.starttlsMode,
      authConfigured: cfg.authConfigured,
      fromAddress: cfg.fromAddress,
      rejectUnauthorized: cfg.rejectUnauthorized,
    },
    ...(cfg.valid ? {} : { blockerOrFailure: cfg.missingOrInvalid.join('; ') }),
  });

  // Check 2: Connection + TLS + Auth probe
  const tProbe = Date.now();
  const probe = await verifySmtpConnection({ timeoutMs: options.timeoutMs ?? 10000 });
  checks.push({
    testId: 'S3-HANDSHAKE-AUTH',
    stage: 'stage_3_smtp',
    name: ALL_SMTP_CHECK_DEFS[1].name,
    purpose: ALL_SMTP_CHECK_DEFS[1].purpose,
    status: probe.smtp_connection_verified ? 'PASS' : 'FAIL',
    executionMode: 'external_provider',
    targetEnvironment: `${host}:${cfg.port}`,
    executedAt: nowIso(),
    durationMs: Date.now() - tProbe,
    evidence: {
      smtp_configuration_valid: probe.smtp_configuration_valid,
      smtp_connection_verified: probe.smtp_connection_verified,
      smtp_message_accepted: probe.smtp_message_accepted,
      inbox_delivery_confirmed: probe.inbox_delivery_confirmed,
    },
    ...(probe.smtp_connection_verified
      ? {}
      : { blockerOrFailure: redactSecrets(probe.connectionError || 'SMTP handshake/auth failed') }),
  });

  // Check 3: Real Smoke-Test Send
  const tSend = Date.now();
  if (!probe.smtp_connection_verified) {
    checks.push({
      testId: 'S3-SMOKE-SEND',
      stage: 'stage_3_smtp',
      name: ALL_SMTP_CHECK_DEFS[2].name,
      purpose: ALL_SMTP_CHECK_DEFS[2].purpose,
      status: 'BLOCKED',
      executionMode: 'external_provider',
      targetEnvironment: `${host}:${cfg.port}`,
      executedAt: nowIso(),
      blockerOrFailure: 'Blocked because S3-HANDSHAKE-AUTH failed.',
    });
  } else {
    const runTag = `smtp_${Date.now()}`;
    const sendRes = await sendTransactionalEmail({
      to: recipient,
      subject: `[AIXSHOP Commercial Verification] SMTP Smoke Test (${runTag})`,
      text: [
        'AIXSHOP v1.0 — Stage 3 Real SMTP Provider Verification',
        `Run Tag: ${runTag}`,
        `Timestamp: ${nowIso()}`,
        `SMTP Host: ${host}:${cfg.port}`,
        '',
        'Note: SMTP 250 OK confirms relay acceptance only. Confirm recipient inbox receipt separately.',
      ].join('\n'),
    });

    const passed = Boolean(sendRes.delivered && sendRes.mode === 'smtp' && sendRes.smtp_message_accepted);
    checks.push({
      testId: 'S3-SMOKE-SEND',
      stage: 'stage_3_smtp',
      name: ALL_SMTP_CHECK_DEFS[2].name,
      purpose: ALL_SMTP_CHECK_DEFS[2].purpose,
      status: passed ? 'PASS' : 'FAIL',
      executionMode: 'external_provider',
      targetEnvironment: `${host}:${cfg.port}`,
      executedAt: nowIso(),
      durationMs: Date.now() - tSend,
      evidence: {
        mode: sendRes.mode,
        recipientDomain: recipient.split('@')[1] || 'unknown',
        messageId: sendRes.messageId || null,
        smtp_configuration_valid: sendRes.smtp_configuration_valid,
        smtp_connection_verified: sendRes.smtp_connection_verified,
        smtp_message_accepted: sendRes.smtp_message_accepted,
        // Explicitly false: relay acceptance does not prove inbox placement
        inbox_delivery_confirmed: false,
      },
      ...(passed ? {} : { blockerOrFailure: redactSecrets(sendRes.error || 'SMTP send rejected') }),
    });
  }

  return summarizeStage('stage_3_smtp', 'Stage 3 — Real SMTP Provider', checks, []);
}
