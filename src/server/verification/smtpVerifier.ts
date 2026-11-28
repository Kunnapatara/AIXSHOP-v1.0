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

const SIMPLE_EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

const ALL_SMTP_CHECK_DEFS: Array<{ testId: string; name: string; purpose: string }> = [
  {
    testId: 'S3-CONFIG-POLICY',
    name: 'SMTP host, port, TLS/STARTTLS, auth, sender & test recipient validation',
    purpose: 'Verify provider-independent SMTP configuration, non-.local sender policy, and controlled SMTP_TEST_RECIPIENT',
  },
  {
    testId: 'S3-HANDSHAKE-AUTH',
    name: 'Live SMTP TCP/TLS/STARTTLS, EHLO & AUTH handshake verification',
    purpose: 'Verify real SMTP server TCP connection, TLS/STARTTLS negotiation, EHLO, and authentication without sending email',
  },
  {
    testId: 'S3-SMOKE-SEND',
    name: 'Real SMTP smoke-test message send & 250 relay acceptance',
    purpose: 'Send tagged test email exclusively to SMTP_TEST_RECIPIENT and record SMTP 250 acceptance + Message-ID',
  },
  {
    testId: 'S3-INBOX-DELIVERY',
    name: 'Recipient inbox delivery confirmation (separate from SMTP relay acceptance)',
    purpose: 'Verify actual recipient inbox receipt via provider delivery evidence or manual inbox confirmation',
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

  // Check 1: Config Validation (including recipient validation)
  const cfg = validateSmtpConfig({ isProd: false });
  const recipientValid = SIMPLE_EMAIL_RE.test(recipient);
  const configErrors = [...cfg.missingOrInvalid];
  if (!recipientValid) {
    configErrors.push('SMTP_TEST_RECIPIENT (invalid email format)');
  }
  const configOk = cfg.valid && recipientValid;

  checks.push({
    testId: 'S3-CONFIG-POLICY',
    stage: 'stage_3_smtp',
    name: ALL_SMTP_CHECK_DEFS[0].name,
    purpose: ALL_SMTP_CHECK_DEFS[0].purpose,
    status: configOk ? 'PASS' : 'FAIL',
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
      recipientDomain: recipient.includes('@') ? recipient.split('@')[1] : 'invalid',
      rejectUnauthorized: cfg.rejectUnauthorized,
    },
    ...(configOk ? {} : { blockerOrFailure: redactSecrets(configErrors.join('; ')) }),
  });

  if (!configOk) {
    for (const def of ALL_SMTP_CHECK_DEFS.slice(1)) {
      checks.push({
        testId: def.testId,
        stage: 'stage_3_smtp',
        name: def.name,
        purpose: def.purpose,
        status: 'BLOCKED',
        executionMode: 'external_provider',
        targetEnvironment: `${host}:${cfg.port}`,
        executedAt: nowIso(),
        blockerOrFailure: 'Blocked because S3-CONFIG-POLICY failed.',
      });
    }
    return summarizeStage('stage_3_smtp', 'Stage 3 — Real SMTP Provider', checks, []);
  }

  // Check 2: Connection + TLS/STARTTLS + EHLO + Auth probe
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
      tlsNegotiated: Boolean(probe.tlsNegotiated),
      tlsProtocol: probe.tlsProtocol || null,
      authMechanism: probe.authMechanism || null,
      smtp_message_accepted: probe.smtp_message_accepted,
      inbox_delivery_confirmed: false,
    },
    ...(probe.smtp_connection_verified
      ? {}
      : { blockerOrFailure: redactSecrets(probe.connectionError || 'SMTP handshake/auth failed') }),
  });

  // Check 3: Real Smoke-Test Send (exclusively to SMTP_TEST_RECIPIENT)
  const tSend = Date.now();
  let smokeMessageId: string | null = null;
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

    const is250Accepted =
      sendRes.smtpResponseCode === undefined || sendRes.smtpResponseCode === null
        ? Boolean(sendRes.smtp_message_accepted)
        : sendRes.smtpResponseCode === 250;
    const passed = Boolean(
      sendRes.delivered &&
        sendRes.mode === 'smtp' &&
        sendRes.smtp_message_accepted &&
        is250Accepted &&
        sendRes.messageId
    );
    smokeMessageId = sendRes.messageId || null;

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
        messageId: smokeMessageId,
        smtpResponseCode: sendRes.smtpResponseCode ?? null,
        smtpResponseText: sendRes.smtpResponseText ? redactSecrets(sendRes.smtpResponseText) : null,
        tlsNegotiated: Boolean(sendRes.tlsNegotiated),
        tlsProtocol: sendRes.tlsProtocol || null,
        authMechanism: sendRes.authMechanism || null,
        smtp_configuration_valid: sendRes.smtp_configuration_valid,
        smtp_connection_verified: sendRes.smtp_connection_verified,
        smtp_message_accepted: sendRes.smtp_message_accepted,
        inbox_delivery_confirmed: false,
      },
      ...(passed ? {} : { blockerOrFailure: redactSecrets(sendRes.error || 'SMTP send was not accepted with 250 OK') }),
    });
  }

  // Check 4: Separate Inbox Delivery Confirmation item (never claimed from SMTP 250 OK)
  checks.push({
    testId: 'S3-INBOX-DELIVERY',
    stage: 'stage_3_smtp',
    name: ALL_SMTP_CHECK_DEFS[3].name,
    purpose: ALL_SMTP_CHECK_DEFS[3].purpose,
    status: 'NOT RUN',
    executionMode: 'external_provider',
    targetEnvironment: recipient.split('@')[1] || 'recipient-inbox',
    executedAt: nowIso(),
    evidence: {
      messageId: smokeMessageId,
      inbox_delivery_confirmed: false,
    },
    blockerOrFailure:
      'SMTP 250 OK proves relay acceptance only. Confirm actual recipient inbox delivery via provider delivery webhook/API or manual inbox inspection.',
  });

  return summarizeStage('stage_3_smtp', 'Stage 3 — Real SMTP Provider', checks, []);
}
