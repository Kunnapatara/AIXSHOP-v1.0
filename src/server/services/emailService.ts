import net from 'node:net';
import tls from 'node:tls';
import { BillingEmailEventType } from '../billing/types';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailDeliveryResult {
  delivered: boolean;
  mode: 'smtp' | 'custom_transport' | 'dev_outbox' | 'unconfigured';
  messageId?: string;
  error?: string;
  smtp_configuration_valid?: boolean;
  smtp_connection_verified?: boolean;
  smtp_message_accepted?: boolean;
  inbox_delivery_confirmed?: false;
  tlsNegotiated?: boolean;
  tlsProtocol?: string | null;
  authMechanism?: string | null;
  smtpResponseCode?: number | null;
  smtpResponseText?: string | null;
}

export interface SentEmailRecord extends OutgoingEmail {
  sentAt: string;
  mode: EmailDeliveryResult['mode'];
}

export type EmailTransportFn = (email: OutgoingEmail) => Promise<EmailDeliveryResult>;

export interface SmtpConfigValidationResult {
  configured: boolean;
  valid: boolean;
  missingOrInvalid: string[];
  hostConfigured: boolean;
  port: number;
  portValid: boolean;
  secure: boolean;
  starttlsMode: 'required' | 'opportunistic' | 'disabled' | 'invalid';
  authConfigured: boolean;
  fromAddress?: string;
  fromValid: boolean;
  rejectUnauthorized: boolean;
}

export interface SmtpReadinessReport {
  smtp_configuration_valid: boolean;
  smtp_connection_verified: boolean;
  smtp_message_accepted: boolean | null;
  inbox_delivery_confirmed: false;
  checkedAt: string;
  config: SmtpConfigValidationResult;
  tlsNegotiated?: boolean;
  tlsProtocol?: string | null;
  authMechanism?: string | null;
  connectionError?: string;
}

const MAX_DEV_OUTBOX_ENTRIES = 100;
const devEmailOutbox: SentEmailRecord[] = [];
let customEmailTransport: EmailTransportFn | null = null;

export function setCustomEmailTransport(transport: EmailTransportFn | null): void {
  customEmailTransport = transport;
}

export function getDevEmailOutbox(): SentEmailRecord[] {
  return [...devEmailOutbox];
}

export function clearDevEmailOutbox(): void {
  devEmailOutbox.length = 0;
}

function recordDevOutbox(email: OutgoingEmail, mode: EmailDeliveryResult['mode']): void {
  if (devEmailOutbox.length >= MAX_DEV_OUTBOX_ENTRIES) {
    devEmailOutbox.shift();
  }
  devEmailOutbox.push({
    ...email,
    sentAt: new Date().toISOString(),
    mode,
  });
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

const SMTP_HOST_PLACEHOLDER_RE =
  /(placeholder|changeme|your_smtp|smtp\.example\.com|example\.com|<|>)/i;
const SMTP_PASS_PLACEHOLDER_RE =
  /(placeholder|changeme|your_smtp_pass|your_password|<|>)/i;
const SIMPLE_EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function extractEmailAddress(raw: string): string {
  const sanitized = sanitizeHeaderValue(raw);
  const bracketMatch = sanitized.match(/<([^<>]+)>$/);
  return (bracketMatch ? bracketMatch[1] : sanitized).trim();
}

export function sanitizeSmtpErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
      ? err
      : String(err ?? 'Unknown SMTP failure');

  let sanitized = raw;
  const smtpPass = process.env.SMTP_PASS || '';
  const smtpUser = process.env.SMTP_USER?.trim() || '';
  if (smtpPass) {
    sanitized = sanitized.split(smtpPass).join('[REDACTED_SMTP_PASS]');
    const loginB64 = Buffer.from(smtpPass, 'utf8').toString('base64');
    if (loginB64) {
      sanitized = sanitized.split(loginB64).join('[REDACTED_SMTP_AUTH]');
    }
    if (smtpUser) {
      const plainB64 = Buffer.from(`\0${smtpUser}\0${smtpPass}`, 'utf8').toString('base64');
      if (plainB64) {
        sanitized = sanitized.split(plainB64).join('[REDACTED_SMTP_AUTH]');
      }
    }
  }

  sanitized = sanitized
    .replace(/\b(AUTH\s+(?:PLAIN|LOGIN)\s+)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(password|passwd|secret|smtp_pass)\s*([:=])\s*([^\s,;]+)/gi, '$1$2[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();

  if (!sanitized) return 'SMTP transport error.';
  return sanitized.length > 400 ? `${sanitized.slice(0, 397)}...` : sanitized;
}

/**
 * Validates SMTP transport configuration using existing env vars (preserving SMTP_PASS).
 */
export function validateSmtpConfig(options: { isProd?: boolean } = {}): SmtpConfigValidationResult {
  const isProd = options.isProd ?? process.env.NODE_ENV === 'production';
  const hostRaw = process.env.SMTP_HOST?.trim() || '';
  const portRaw = process.env.SMTP_PORT?.trim() || '';
  const secureEnv = (process.env.SMTP_SECURE || '').trim().toLowerCase();
  const starttlsRaw = (process.env.SMTP_STARTTLS || '').trim().toLowerCase();
  const user = process.env.SMTP_USER?.trim() || '';
  const pass = process.env.SMTP_PASS || '';
  const fromRaw = process.env.SMTP_FROM?.trim() || '';
  const rejectUnauthorized = process.env.SMTP_REJECT_UNAUTHORIZED !== 'false';

  const missingOrInvalid: string[] = [];

  const hostConfigured = Boolean(hostRaw);
  const hostValid =
    hostConfigured &&
    !/[\s\r\n]/.test(hostRaw) &&
    !(isProd && SMTP_HOST_PLACEHOLDER_RE.test(hostRaw));
  if (!hostConfigured) {
    missingOrInvalid.push('SMTP_HOST (missing)');
  } else if (!hostValid) {
    missingOrInvalid.push('SMTP_HOST (invalid or placeholder)');
  }

  let port = 587;
  let portValid = true;
  if (portRaw) {
    const parsedPort = Number(portRaw);
    if (!/^\d+$/.test(portRaw) || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      portValid = false;
      port = 0;
      missingOrInvalid.push('SMTP_PORT (must be an integer between 1 and 65535)');
    } else {
      port = parsedPort;
    }
  }

  let secureValid = true;
  if (secureEnv && secureEnv !== 'true' && secureEnv !== 'false') {
    secureValid = false;
    missingOrInvalid.push('SMTP_SECURE (must be "true" or "false")');
  }
  const secure = secureEnv === 'true' || (secureEnv !== 'false' && port === 465);

  let starttlsMode: SmtpConfigValidationResult['starttlsMode'] = 'opportunistic';
  if (!starttlsRaw || starttlsRaw === 'opportunistic') {
    starttlsMode = 'opportunistic';
  } else if (starttlsRaw === 'true' || starttlsRaw === 'require' || starttlsRaw === 'required') {
    starttlsMode = 'required';
  } else if (starttlsRaw === 'false' || starttlsRaw === 'off') {
    starttlsMode = 'disabled';
  } else {
    starttlsMode = 'invalid';
    missingOrInvalid.push('SMTP_STARTTLS (expected true/require/false/off)');
  }

  if (isProd && !secure && starttlsMode === 'disabled') {
    missingOrInvalid.push('SMTP_STARTTLS / SMTP_SECURE (plaintext SMTP prohibited in production)');
  }
  if (isProd && !rejectUnauthorized) {
    missingOrInvalid.push('SMTP_REJECT_UNAUTHORIZED (TLS certificate verification required in production)');
  }

  const hasUser = Boolean(user);
  const hasPass = Boolean(pass.trim());
  const authConfigured = hasUser && hasPass;

  if (hasUser && !hasPass) {
    missingOrInvalid.push('SMTP_PASS (required when SMTP_USER is set)');
  } else if (!hasUser && hasPass) {
    missingOrInvalid.push('SMTP_USER (required when SMTP_PASS is set)');
  } else if (isProd && !authConfigured) {
    if (!hasUser) missingOrInvalid.push('SMTP_USER (missing)');
    if (!hasPass) missingOrInvalid.push('SMTP_PASS (missing)');
  }
  if (hasPass && isProd && SMTP_PASS_PLACEHOLDER_RE.test(pass.trim())) {
    missingOrInvalid.push('SMTP_PASS (placeholder value rejected)');
  }

  const effectiveFromRaw = isProd ? fromRaw : (fromRaw || user || 'no-reply@aixshop.local');
  const fromAddress = effectiveFromRaw ? extractEmailAddress(effectiveFromRaw) : undefined;
  let fromValid = Boolean(fromAddress && SIMPLE_EMAIL_RE.test(fromAddress));
  if (fromAddress && isProd) {
    const domain = fromAddress.split('@')[1]?.toLowerCase() || '';
    if (!domain || domain.endsWith('.local') || domain === 'example.com' || domain.endsWith('.example.com')) {
      fromValid = false;
    }
  }
  if (!fromValid) {
    missingOrInvalid.push(
      isProd && !fromRaw
        ? 'SMTP_FROM (missing)'
        : 'SMTP_FROM (valid non-local sender address required)'
    );
  }

  return {
    configured: hostConfigured,
    valid: hostValid && portValid && secureValid && starttlsMode !== 'invalid' && fromValid && missingOrInvalid.length === 0,
    missingOrInvalid,
    hostConfigured,
    port,
    portValid,
    secure,
    starttlsMode,
    authConfigured,
    fromAddress,
    fromValid,
    rejectUnauthorized,
  };
}

interface SmtpResponse {
  code: number;
  text: string;
  lines: string[];
}

function ehloSupports(lines: string[], capability: string): boolean {
  const re = new RegExp(`^250[- ]${capability}(?:\\s|$|=)`, 'i');
  return lines.some((line) => re.test(line));
}

function getSmtpAuthMechanisms(lines: string[]): Set<string> {
  const mechs = new Set<string>();
  for (const line of lines) {
    const m = line.match(/^250[- ]AUTH(?:=|\s+)(.+)$/i);
    if (m?.[1]) {
      for (const token of m[1].trim().split(/\s+/)) {
        if (token) mechs.add(token.toUpperCase());
      }
    }
  }
  return mechs;
}

interface SmtpSessionOutcome {
  success: boolean;
  connectionVerified: boolean;
  messageAccepted: boolean | null;
  messageId?: string;
  tlsNegotiated?: boolean;
  tlsProtocol?: string | null;
  authMechanism?: string | null;
  smtpResponseCode?: number | null;
  smtpResponseText?: string | null;
  error?: string;
}

/**
 * Shared low-level SMTP session runner using Node net/tls sockets.
 * When `email` is omitted, executes connection/TLS/STARTTLS/EHLO/AUTH verification and QUIT only.
 * When `email` is provided, sends the message after authentication and reports SMTP acceptance.
 */
async function runSmtpSession(
  email?: OutgoingEmail,
  options: { timeoutMs?: number } = {}
): Promise<SmtpSessionOutcome> {
  const host = process.env.SMTP_HOST?.trim() || '';
  const cfg = validateSmtpConfig();
  if (!host || !cfg.valid) {
    return {
      success: false,
      connectionVerified: false,
      messageAccepted: email ? false : null,
      error: cfg.missingOrInvalid.join('; ') || 'SMTP configuration is invalid.',
    };
  }

  const port = cfg.port;
  const secure = cfg.secure;
  const user = process.env.SMTP_USER?.trim() || '';
  const pass = process.env.SMTP_PASS || '';
  const fromRaw = process.env.SMTP_FROM?.trim() || user || 'no-reply@aixshop.local';
  const fromAddress = cfg.fromAddress || extractEmailAddress(fromRaw);
  const toAddress = email ? sanitizeHeaderValue(email.to) : '';
  const configuredTimeout = Number(process.env.SMTP_TIMEOUT_MS || 10000);
  const TIMEOUT_MS =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 10000;

  return new Promise<SmtpSessionOutcome>((resolve) => {
    let settled = false;
    let connectionVerified = false;
    let tlsNegotiated = secure;
    let tlsProtocol: string | null = null;
    let authMechanism: string | null = null;
    let socket: net.Socket | tls.TLSSocket = secure
      ? tls.connect({
          host,
          port,
          servername: host,
          rejectUnauthorized: cfg.rejectUnauthorized,
        })
      : net.connect({ host, port });

    let buffer = '';
    let pendingLines: string[] = [];
    const waiters: Array<{
      resolve: (res: SmtpResponse) => void;
      reject: (err: Error) => void;
    }> = [];

    const finish = (outcome: SmtpSessionOutcome) => {
      if (settled) return;
      settled = true;
      const safeError = outcome.error ? sanitizeSmtpErrorMessage(outcome.error) : undefined;
      while (waiters.length > 0) {
        const w = waiters.shift();
        w?.reject(new Error(safeError || 'SMTP transport closed'));
      }
      try {
        socket.removeAllListeners();
        socket.destroy();
      } catch {
        // ignore
      }
      resolve({
        ...outcome,
        ...(safeError ? { error: safeError } : {}),
      });
    };

    const attachSocketListeners = (sock: net.Socket | tls.TLSSocket) => {
      sock.setTimeout(TIMEOUT_MS, () => {
        finish({
          success: false,
          connectionVerified,
          messageAccepted: email ? false : null,
          error: `SMTP connection timed out after ${TIMEOUT_MS}ms`,
        });
      });

      sock.on('error', (err) => {
        finish({
          success: false,
          connectionVerified,
          messageAccepted: email ? false : null,
          error: sanitizeSmtpErrorMessage(err),
        });
      });

      sock.on('end', () => {
        if (!settled) {
          finish({
            success: false,
            connectionVerified,
            messageAccepted: email ? false : null,
            error: 'SMTP server closed connection unexpectedly.',
          });
        }
      });

      sock.on('close', () => {
        if (!settled) {
          finish({
            success: false,
            connectionVerified,
            messageAccepted: email ? false : null,
            error: 'SMTP socket closed before transaction completed.',
          });
        }
      });

      sock.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, '');
          buffer = buffer.slice(idx + 1);
          const match = line.match(/^(\d{3})([- ])(.*)$/);
          if (!match) continue;
          pendingLines.push(line);
          if (match[2] === ' ') {
            const code = parseInt(match[1], 10);
            const lines = pendingLines;
            pendingLines = [];
            const nextWaiter = waiters.shift();
            if (nextWaiter) {
              nextWaiter.resolve({ code, text: line, lines });
            }
          }
        }
      });
    };

    const readResponse = (): Promise<SmtpResponse> =>
      new Promise((resWaiter, rejWaiter) => {
        if (settled) {
          return rejWaiter(new Error('SMTP connection already closed'));
        }
        waiters.push({ resolve: resWaiter, reject: rejWaiter });
      });

    const sendCommand = async (cmd: string): Promise<SmtpResponse> => {
      const waiter = readResponse();
      socket.write(`${cmd}\r\n`);
      return waiter;
    };

    attachSocketListeners(socket);

    (async () => {
      try {
        const greeting = await readResponse();
        if (greeting.code >= 400) {
          return finish({
            success: false,
            connectionVerified: false,
            messageAccepted: email ? false : null,
            error: `SMTP greeting failed: ${greeting.code}`,
          });
        }

        const ehloHost = 'aixshop.local';
        let ehlo = await sendCommand(`EHLO ${ehloHost}`);
        if (ehlo.code >= 400) {
          return finish({
            success: false,
            connectionVerified: false,
            messageAccepted: email ? false : null,
            error: `SMTP EHLO failed: ${ehlo.code}`,
          });
        }

        const shouldTryStarttls = !secure && cfg.starttlsMode !== 'disabled';
        const requireStarttls = cfg.starttlsMode === 'required';
        const serverSupportsStarttls = ehloSupports(ehlo.lines, 'STARTTLS');
        if (!secure && requireStarttls && !serverSupportsStarttls) {
          return finish({
            success: false,
            connectionVerified: false,
            messageAccepted: email ? false : null,
            error: 'SMTP server did not advertise STARTTLS, which is required by SMTP_STARTTLS.',
          });
        }

        if (shouldTryStarttls && serverSupportsStarttls) {
          const starttls = await sendCommand('STARTTLS');
          if (starttls.code !== 220) {
            return finish({
              success: false,
              connectionVerified: false,
              messageAccepted: email ? false : null,
              error: `SMTP STARTTLS rejected with code ${starttls.code}`,
            });
          }

          const previousSocket = socket;
          previousSocket.removeAllListeners();
          buffer = '';
          pendingLines = [];

          const upgraded = await new Promise<tls.TLSSocket>((resTls, rejTls) => {
            const tlsSock = tls.connect(
              {
                socket: previousSocket,
                servername: host,
                rejectUnauthorized: cfg.rejectUnauthorized,
              },
              () => resTls(tlsSock)
            );
            tlsSock.setTimeout(TIMEOUT_MS, () => {
              rejTls(new Error(`SMTP STARTTLS handshake timed out after ${TIMEOUT_MS}ms`));
            });
            tlsSock.once('error', rejTls);
          });

          socket = upgraded;
          tlsNegotiated = true;
          tlsProtocol = typeof upgraded.getProtocol === 'function' ? upgraded.getProtocol() : null;
          socket.removeAllListeners('error');
          attachSocketListeners(socket);

          ehlo = await sendCommand(`EHLO ${ehloHost}`);
          if (ehlo.code >= 400) {
            return finish({
              success: false,
              connectionVerified: false,
              messageAccepted: email ? false : null,
              error: `SMTP EHLO post-TLS failed: ${ehlo.code}`,
            });
          }
        } else if (secure && typeof (socket as tls.TLSSocket).getProtocol === 'function') {
          tlsProtocol = (socket as tls.TLSSocket).getProtocol();
        }

        if (user && pass) {
          const mechanisms = getSmtpAuthMechanisms(ehlo.lines);
          const supportsPlain = mechanisms.has('PLAIN') || mechanisms.size === 0;
          const supportsLogin = mechanisms.has('LOGIN');

          if (supportsLogin && !mechanisms.has('PLAIN')) {
            authMechanism = 'LOGIN';
            const loginInit = await sendCommand('AUTH LOGIN');
            if (loginInit.code !== 334) {
              return finish({
                success: false,
                connectionVerified: false,
                messageAccepted: email ? false : null,
                error: `SMTP AUTH LOGIN rejected: ${loginInit.code}`,
              });
            }
            const userResp = await sendCommand(Buffer.from(user, 'utf8').toString('base64'));
            if (userResp.code !== 334) {
              return finish({
                success: false,
                connectionVerified: false,
                messageAccepted: email ? false : null,
                error: `SMTP AUTH LOGIN username rejected: ${userResp.code}`,
              });
            }
            const passResp = await sendCommand(Buffer.from(pass, 'utf8').toString('base64'));
            if (passResp.code >= 400) {
              return finish({
                success: false,
                connectionVerified: false,
                messageAccepted: email ? false : null,
                error: `SMTP authentication failed: ${passResp.code}`,
              });
            }
          } else if (supportsPlain) {
            authMechanism = 'PLAIN';
            const authToken = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
            const authRes = await sendCommand(`AUTH PLAIN ${authToken}`);
            if (authRes.code >= 400) {
              return finish({
                success: false,
                connectionVerified: false,
                messageAccepted: email ? false : null,
                error: `SMTP authentication failed: ${authRes.code}`,
              });
            }
          } else {
            return finish({
              success: false,
              connectionVerified: false,
              messageAccepted: email ? false : null,
              error: 'SMTP server did not advertise a supported authentication mechanism (PLAIN or LOGIN).',
            });
          }
        }

        connectionVerified = true;

        // Connection-only verification path (verifySmtpConnection)
        if (!email) {
          await sendCommand('QUIT').catch(() => {});
          return finish({
            success: true,
            connectionVerified: true,
            messageAccepted: null,
            tlsNegotiated,
            tlsProtocol,
            authMechanism,
          });
        }

        const mailFrom = await sendCommand(`MAIL FROM:<${fromAddress}>`);
        if (mailFrom.code >= 400) {
          return finish({
            success: false,
            connectionVerified,
            messageAccepted: false,
            error: `SMTP MAIL FROM rejected: ${mailFrom.code}`,
          });
        }

        const rcptTo = await sendCommand(`RCPT TO:<${toAddress}>`);
        if (rcptTo.code >= 400) {
          return finish({
            success: false,
            connectionVerified,
            messageAccepted: false,
            error: `SMTP RCPT TO rejected: ${rcptTo.code}`,
          });
        }

        const dataCmd = await sendCommand('DATA');
        if (dataCmd.code >= 400) {
          return finish({
            success: false,
            connectionVerified,
            messageAccepted: false,
            error: `SMTP DATA rejected: ${dataCmd.code}`,
          });
        }

        const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@aixshop>`;
        const escapedBody = email.text
          .replace(/\r?\n/g, '\r\n')
          .replace(/^\./gm, '..');
        const payload = [
          `From: ${sanitizeHeaderValue(fromRaw)}`,
          `To: <${toAddress}>`,
          `Subject: ${sanitizeHeaderValue(email.subject)}`,
          `Message-ID: ${messageId}`,
          `Date: ${new Date().toUTCString()}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
          escapedBody,
          '.',
        ].join('\r\n');

        const dataDone = await sendCommand(payload);
        if (dataDone.code >= 400) {
          return finish({
            success: false,
            connectionVerified,
            messageAccepted: false,
            tlsNegotiated,
            tlsProtocol,
            authMechanism,
            smtpResponseCode: dataDone.code,
            smtpResponseText: sanitizeSmtpErrorMessage(dataDone.text),
            error: `SMTP message rejected: ${dataDone.code}`,
          });
        }

        await sendCommand('QUIT').catch(() => {});
        return finish({
          success: true,
          connectionVerified: true,
          messageAccepted: dataDone.code >= 200 && dataDone.code < 300,
          messageId,
          tlsNegotiated,
          tlsProtocol,
          authMechanism,
          smtpResponseCode: dataDone.code,
          smtpResponseText: sanitizeSmtpErrorMessage(dataDone.text),
        });
      } catch (err: any) {
        return finish({
          success: false,
          connectionVerified,
          messageAccepted: email ? false : null,
          error: sanitizeSmtpErrorMessage(err),
        });
      }
    })();
  });
}

/**
 * Explicitly verifies live SMTP connectivity, TLS/STARTTLS handshake, and authentication
 * without sending an email message. Distinguishes config validity, verified connection,
 * SMTP message acceptance (null here), and inbox delivery confirmation (always false).
 */
export async function verifySmtpConnection(
  options: { timeoutMs?: number } = {}
): Promise<SmtpReadinessReport> {
  const checkedAt = new Date().toISOString();
  const config = validateSmtpConfig();

  if (!config.configured || !config.valid) {
    return {
      smtp_configuration_valid: config.valid,
      smtp_connection_verified: false,
      smtp_message_accepted: null,
      inbox_delivery_confirmed: false,
      checkedAt,
      config,
      connectionError: !config.configured
        ? 'SMTP_HOST is not configured.'
        : `Invalid SMTP configuration: ${config.missingOrInvalid.join(', ')}`,
    };
  }

  const outcome = await runSmtpSession(undefined, { timeoutMs: options.timeoutMs ?? 5000 });
  return {
    smtp_configuration_valid: true,
    smtp_connection_verified: outcome.success && outcome.connectionVerified,
    smtp_message_accepted: null,
    inbox_delivery_confirmed: false,
    checkedAt,
    config,
    tlsNegotiated: outcome.tlsNegotiated,
    tlsProtocol: outcome.tlsProtocol,
    authMechanism: outcome.authMechanism,
    ...(outcome.success ? {} : { connectionError: outcome.error || 'SMTP connection verification failed.' }),
  };
}

/**
 * Standards-compliant SMTP delivery client using Node's built-in net/tls sockets.
 * Supports SMTPS (port 465 / SMTP_SECURE=true), STARTTLS negotiation, multi-line EHLO parsing,
 * and AUTH PLAIN / AUTH LOGIN without logging credentials or sensitive message contents.
 */
async function sendViaSmtp(email: OutgoingEmail): Promise<EmailDeliveryResult> {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    return {
      delivered: false,
      mode: 'unconfigured',
      error: 'SMTP_HOST is not configured.',
      smtp_configuration_valid: false,
      smtp_connection_verified: false,
      smtp_message_accepted: false,
      inbox_delivery_confirmed: false,
    };
  }

  const cfg = validateSmtpConfig();
  if (!cfg.valid) {
    return {
      delivered: false,
      mode: 'smtp',
      error: `Invalid SMTP configuration: ${cfg.missingOrInvalid.join(', ')}`,
      smtp_configuration_valid: false,
      smtp_connection_verified: false,
      smtp_message_accepted: false,
      inbox_delivery_confirmed: false,
    };
  }

  const outcome = await runSmtpSession(email);
  if (!outcome.success) {
    return {
      delivered: false,
      mode: 'smtp',
      error: outcome.error || 'SMTP send failure',
      smtp_configuration_valid: true,
      smtp_connection_verified: outcome.connectionVerified,
      smtp_message_accepted: false,
      inbox_delivery_confirmed: false,
      tlsNegotiated: outcome.tlsNegotiated,
      tlsProtocol: outcome.tlsProtocol,
      authMechanism: outcome.authMechanism,
      smtpResponseCode: outcome.smtpResponseCode,
      smtpResponseText: outcome.smtpResponseText,
    };
  }

  return {
    delivered: true,
    mode: 'smtp',
    messageId: outcome.messageId,
    smtp_configuration_valid: true,
    smtp_connection_verified: outcome.connectionVerified,
    smtp_message_accepted: Boolean(outcome.messageAccepted),
    // Note: SMTP 250 OK proves relay acceptance only — never claims recipient inbox delivery.
    inbox_delivery_confirmed: false,
    tlsNegotiated: outcome.tlsNegotiated,
    tlsProtocol: outcome.tlsProtocol,
    authMechanism: outcome.authMechanism,
    smtpResponseCode: outcome.smtpResponseCode,
    smtpResponseText: outcome.smtpResponseText,
  };
}

export function checkEmailTransportAvailability(
  options: { isProd?: boolean } = {}
): { available: boolean; usesSmtpSocket: boolean; reason?: string } {
  const isProd = options.isProd ?? process.env.NODE_ENV === 'production';
  if (customEmailTransport) {
    return { available: true, usesSmtpSocket: false };
  }
  if (process.env.SMTP_HOST?.trim()) {
    const cfg = validateSmtpConfig({ isProd });
    if (!cfg.valid) {
      return {
        available: false,
        usesSmtpSocket: true,
        reason: `Invalid SMTP configuration: ${cfg.missingOrInvalid.join(', ')}`,
      };
    }
    return { available: true, usesSmtpSocket: true };
  }
  if (isProd) {
    return {
      available: false,
      usesSmtpSocket: false,
      reason: 'SMTP transport is not configured in production.',
    };
  }
  return { available: true, usesSmtpSocket: false };
}

export async function sendTransactionalEmail(email: OutgoingEmail): Promise<EmailDeliveryResult> {
  if (customEmailTransport) {
    const res = await customEmailTransport(email);
    recordDevOutbox(email, 'custom_transport');
    return {
      ...res,
      smtp_message_accepted: res.delivered,
      inbox_delivery_confirmed: false,
    };
  }

  if (process.env.SMTP_HOST?.trim()) {
    return sendViaSmtp(email);
  }

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    // Development & automated test fallback sink; never exposed via API responses.
    recordDevOutbox(email, 'dev_outbox');
    return {
      delivered: true,
      mode: 'dev_outbox',
      smtp_configuration_valid: false,
      smtp_connection_verified: false,
      smtp_message_accepted: false,
      inbox_delivery_confirmed: false,
    };
  }

  console.warn('[AIXSHOP Mail] Password reset email skipped: SMTP_HOST is not configured in production.');
  return {
    delivered: false,
    mode: 'unconfigured',
    error: 'SMTP transport is not configured in production.',
    smtp_configuration_valid: false,
    smtp_connection_verified: false,
    smtp_message_accepted: false,
    inbox_delivery_confirmed: false,
  };
}

export async function sendPasswordResetEmail(params: {
  to: string;
  fullName: string;
  resetUrl: string;
  ttlMinutes: number;
}): Promise<EmailDeliveryResult> {
  const safeName = params.fullName?.trim() || 'Merchant';
  const subject = 'Reset your AIXSHOP password';
  const text = [
    `Hello ${safeName},`,
    '',
    'We received a request to reset the password for your AIXSHOP account.',
    `Use the single-use link below within ${params.ttlMinutes} minutes:`,
    '',
    params.resetUrl,
    '',
    'If you did not request a password reset, you can safely ignore this email.',
  ].join('\n');

  return sendTransactionalEmail({
    to: params.to,
    subject,
    text,
  });
}

export interface BillingLifecycleEmailParams {
  to: string;
  fullName?: string;
  workspaceName?: string;
  workspaceId: string;
  eventType: BillingEmailEventType;
  tier: string;
  previousTier?: string;
  amountCents?: number | null;
  currency?: string;
  billingInterval?: string;
  subscriptionStatus: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  settingsUrl?: string;
  supportEmail?: string;
}

export function formatBillingAmount(amountCents?: number | null, currency: string = 'USD'): string {
  if (typeof amountCents !== 'number' || !Number.isFinite(amountCents)) {
    return 'N/A';
  }
  const iso = (currency || 'USD').toUpperCase();
  const symbol = iso === 'EUR' ? '€' : iso === 'GBP' ? '£' : '$';
  const amount = (amountCents / 100).toFixed(2);
  return `${symbol}${amount} ${iso}`;
}

function formatBillingDateUtc(iso?: string): string {
  if (!iso) return 'N/A';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return 'N/A';
  return parsed.toISOString().slice(0, 10);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderBillingLifecycleEmail(params: BillingLifecycleEmailParams): OutgoingEmail {
  const safeName = sanitizeHeaderValue(params.fullName || '') || 'Merchant';
  const safeWorkspace = sanitizeHeaderValue(params.workspaceName || '') || params.workspaceId;
  const safeTier = sanitizeHeaderValue(params.tier || 'Starter');
  const safePrevTier = params.previousTier ? sanitizeHeaderValue(params.previousTier) : undefined;
  const currency = (params.currency || 'USD').toUpperCase();
  const formattedAmount = formatBillingAmount(params.amountCents, currency);
  const periodStart = formatBillingDateUtc(params.currentPeriodStart);
  const periodEnd = formatBillingDateUtc(params.currentPeriodEnd);
  const supportEmail =
    sanitizeHeaderValue(params.supportEmail || process.env.SUPPORT_EMAIL || '') ||
    'support@aixshop.app';
  const baseAppUrl = (process.env.APP_URL || 'http://localhost:3000').trim().replace(/\/+$/, '');
  const settingsUrl =
    params.settingsUrl || `${baseAppUrl}/?page=settings&tab=subscription`;

  let subject = `AIXSHOP: Subscription Update — ${safeTier}`;
  let headline = 'Subscription Update';
  let summaryLine = `Your AIXSHOP subscription for workspace "${safeWorkspace}" has been updated.`;

  switch (params.eventType) {
    case 'initial_payment_confirmed':
      subject = `AIXSHOP: Payment Confirmed — ${safeTier} Plan Active`;
      headline = `Welcome to AIXSHOP ${safeTier}`;
      summaryLine = `Thank you for subscribing! Your payment of ${formattedAmount} (${params.billingInterval || 'month'}) for workspace "${safeWorkspace}" is confirmed and full catalog audit reports are now unlocked.`;
      break;
    case 'recurring_renewal':
      subject = `AIXSHOP: Subscription Renewed — ${safeTier} Plan`;
      headline = `Subscription Renewal Receipt`;
      summaryLine = `Your recurring ${safeTier} subscription for workspace "${safeWorkspace}" has renewed (${formattedAmount}).`;
      break;
    case 'plan_changed':
      subject = `AIXSHOP: Plan Updated to ${safeTier}`;
      headline = `Subscription Plan Changed`;
      summaryLine = safePrevTier
        ? `Your workspace "${safeWorkspace}" subscription plan changed from ${safePrevTier} to ${safeTier} (${formattedAmount}/${params.billingInterval || 'month'}).`
        : `Your workspace "${safeWorkspace}" subscription plan is now ${safeTier} (${formattedAmount}/${params.billingInterval || 'month'}).`;
      break;
    case 'subscription_canceled':
      subject = `AIXSHOP: Subscription Canceled — ${safeWorkspace}`;
      headline = params.cancelAtPeriodEnd
        ? `Subscription Scheduled for Cancellation`
        : `Subscription Canceled`;
      summaryLine = params.cancelAtPeriodEnd
        ? `Your ${safeTier} subscription for workspace "${safeWorkspace}" is scheduled to cancel at the end of the current billing period (${periodEnd}).`
        : `Your subscription for workspace "${safeWorkspace}" has been canceled and the workspace returned to the Free Audit tier without deleting your catalog data.`;
      break;
    case 'payment_failed':
      subject = `AIXSHOP: Payment Action Required — ${safeTier} Plan`;
      headline = `Subscription Payment Failed`;
      summaryLine = `We could not collect the renewal payment of ${formattedAmount} for workspace "${safeWorkspace}". Please update your payment method in Billing Settings to restore full audit access.`;
      break;
  }

  const detailsLines = [
    `Workspace: ${safeWorkspace}`,
    `Recipient: ${safeName} (${sanitizeHeaderValue(params.to)})`,
    `Plan Tier: ${safeTier}`,
    ...(safePrevTier ? [`Previous Plan: ${safePrevTier}`] : []),
    `Amount: ${formattedAmount}`,
    `Subscription Status: ${params.subscriptionStatus}`,
    `Billing Period: ${periodStart} to ${periodEnd}`,
    `Manage Billing: ${settingsUrl}`,
    `Support Contact: ${supportEmail}`,
  ];

  const text = [
    `Hello ${safeName},`,
    '',
    headline,
    '',
    summaryLine,
    '',
    'Subscription Details:',
    ...detailsLines.map((line) => `- ${line}`),
    '',
    'AIXSHOP Billing Operations',
  ].join('\n');

  const html = [
    `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:0 auto;color:#1c1917;line-height:1.5;">`,
    `  <h2 style="margin:0 0 12px;font-size:18px;color:#0c0a09;">${escapeHtml(headline)}</h2>`,
    `  <p style="margin:0 0 12px;">Hello ${escapeHtml(safeName)},</p>`,
    `  <p style="margin:0 0 16px;">${escapeHtml(summaryLine)}</p>`,
    `  <table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;border:1px solid #e7e5e4;">`,
    `    <tbody>`,
    `      <tr><td style="padding:8px 12px;border-bottom:1px solid #e7e5e4;color:#57534e;">Workspace</td><td style="padding:8px 12px;border-bottom:1px solid #e7e5e4;font-weight:600;">${escapeHtml(safeWorkspace)}</td></tr>`,
    `      <tr><td style="padding:8px 12px;border-bottom:1px solid #e7e5e4;color:#57534e;">Plan Tier</td><td style="padding:8px 12px;border-bottom:1px solid #e7e5e4;font-weight:600;">${escapeHtml(safeTier)}</td></tr>`,
    ...(safePrevTier
      ? [`      <tr><td style="padding:8px 12px;border-bottom:1px solid #e7e5e4;color:#57534e;">Previous Plan</td><td style="padding:8px 12px;border-bottom:1px solid #e7e5e4;">${escapeHtml(safePrevTier)}</td></tr>`]
      : []),
    `      <tr><td style="padding:8px 12px;border-bottom:1px solid #e7e5e4;color:#57534e;">Amount</td><td style="padding:8px 12px;border-bottom:1px solid #e7e5e4;font-family:monospace;">${escapeHtml(formattedAmount)}</td></tr>`,
    `      <tr><td style="padding:8px 12px;border-bottom:1px solid #e7e5e4;color:#57534e;">Status</td><td style="padding:8px 12px;border-bottom:1px solid #e7e5e4;font-family:monospace;">${escapeHtml(params.subscriptionStatus)}</td></tr>`,
    `      <tr><td style="padding:8px 12px;color:#57534e;">Billing Period</td><td style="padding:8px 12px;font-family:monospace;">${escapeHtml(periodStart)} &rarr; ${escapeHtml(periodEnd)}</td></tr>`,
    `    </tbody>`,
    `  </table>`,
    `  <p style="margin:16px 0;"><a href="${escapeHtml(settingsUrl)}" style="display:inline-block;padding:10px 16px;background:#ea580c;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:13px;">Manage Billing &amp; Subscription</a></p>`,
    `  <p style="margin:16px 0 0;font-size:12px;color:#78716c;">Questions? Contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>`,
    `</div>`,
  ].join('\n');

  return {
    to: sanitizeHeaderValue(params.to),
    subject,
    text,
    html,
  };
}

export async function sendBillingLifecycleEmail(
  params: BillingLifecycleEmailParams
): Promise<EmailDeliveryResult> {
  const outgoing = renderBillingLifecycleEmail(params);
  return sendTransactionalEmail(outgoing);
}

