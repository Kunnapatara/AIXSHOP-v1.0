import net from 'node:net';
import tls from 'node:tls';

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
}

export interface SentEmailRecord extends OutgoingEmail {
  sentAt: string;
  mode: EmailDeliveryResult['mode'];
}

export type EmailTransportFn = (email: OutgoingEmail) => Promise<EmailDeliveryResult>;

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

/**
 * Standards-compliant SMTP delivery client using Node's built-in net/tls sockets.
 * Supports SMTPS (port 465 / SMTP_SECURE=true), STARTTLS negotiation, multi-line EHLO parsing,
 * and AUTH PLAIN / AUTH LOGIN without logging credentials or sensitive message contents.
 */
async function sendViaSmtp(email: OutgoingEmail): Promise<EmailDeliveryResult> {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
  const starttlsPref = (process.env.SMTP_STARTTLS || '').trim().toLowerCase();
  const user = process.env.SMTP_USER?.trim() || '';
  const pass = process.env.SMTP_PASS || '';
  const fromRaw = process.env.SMTP_FROM?.trim() || user || 'no-reply@aixshop.local';
  const fromAddress = sanitizeHeaderValue(fromRaw).replace(/^.*<([^>]+)>$/, '$1');
  const toAddress = sanitizeHeaderValue(email.to);

  if (!host) {
    return { delivered: false, mode: 'unconfigured', error: 'SMTP_HOST is not configured.' };
  }

  return new Promise<EmailDeliveryResult>((resolve) => {
    const TIMEOUT_MS = 10000;
    let settled = false;
    let socket: net.Socket | tls.TLSSocket = secure
      ? tls.connect({
          host,
          port,
          servername: host,
          rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false',
        })
      : net.connect({ host, port });

    let buffer = '';
    let pendingLines: string[] = [];
    const waiters: Array<{
      resolve: (res: SmtpResponse) => void;
      reject: (err: Error) => void;
    }> = [];

    const finish = (result: EmailDeliveryResult) => {
      if (settled) return;
      settled = true;
      while (waiters.length > 0) {
        const w = waiters.shift();
        w?.reject(new Error(result.error || 'SMTP transport closed'));
      }
      try {
        socket.removeAllListeners();
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    const attachSocketListeners = (sock: net.Socket | tls.TLSSocket) => {
      sock.setTimeout(TIMEOUT_MS, () => {
        finish({ delivered: false, mode: 'smtp', error: `SMTP connection timed out after ${TIMEOUT_MS}ms` });
      });

      sock.on('error', (err) => {
        finish({ delivered: false, mode: 'smtp', error: err?.message || 'SMTP socket error' });
      });

      sock.on('end', () => {
        if (!settled) {
          finish({ delivered: false, mode: 'smtp', error: 'SMTP server closed connection unexpectedly.' });
        }
      });

      sock.on('close', () => {
        if (!settled) {
          finish({ delivered: false, mode: 'smtp', error: 'SMTP socket closed before transaction completed.' });
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
          return finish({ delivered: false, mode: 'smtp', error: `SMTP greeting failed: ${greeting.code}` });
        }

        const ehloHost = 'aixshop.local';
        let ehlo = await sendCommand(`EHLO ${ehloHost}`);
        if (ehlo.code >= 400) {
          return finish({ delivered: false, mode: 'smtp', error: `SMTP EHLO failed: ${ehlo.code}` });
        }

        const shouldTryStarttls = !secure && starttlsPref !== 'false' && starttlsPref !== 'off';
        const requireStarttls = starttlsPref === 'true' || starttlsPref === 'require' || starttlsPref === 'required';
        const serverSupportsStarttls = ehloSupports(ehlo.lines, 'STARTTLS');
        if (!secure && requireStarttls && !serverSupportsStarttls) {
          return finish({
            delivered: false,
            mode: 'smtp',
            error: 'SMTP server did not advertise STARTTLS, which is required by SMTP_STARTTLS.',
          });
        }

        if (shouldTryStarttls && serverSupportsStarttls) {
          const starttls = await sendCommand('STARTTLS');
          if (starttls.code !== 220) {
            return finish({
              delivered: false,
              mode: 'smtp',
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
                rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false',
              },
              () => resTls(tlsSock)
            );
            tlsSock.once('error', rejTls);
          });

          socket = upgraded;
          socket.removeAllListeners('error');
          attachSocketListeners(socket);

          ehlo = await sendCommand(`EHLO ${ehloHost}`);
          if (ehlo.code >= 400) {
            return finish({ delivered: false, mode: 'smtp', error: `SMTP EHLO post-TLS failed: ${ehlo.code}` });
          }
        }

        if (user && pass) {
          const mechanisms = getSmtpAuthMechanisms(ehlo.lines);
          const supportsPlain = mechanisms.has('PLAIN') || mechanisms.size === 0;
          const supportsLogin = mechanisms.has('LOGIN');

          if (supportsLogin && !mechanisms.has('PLAIN')) {
            const loginInit = await sendCommand('AUTH LOGIN');
            if (loginInit.code !== 334) {
              return finish({ delivered: false, mode: 'smtp', error: `SMTP AUTH LOGIN rejected: ${loginInit.code}` });
            }
            const userResp = await sendCommand(Buffer.from(user, 'utf8').toString('base64'));
            if (userResp.code !== 334) {
              return finish({ delivered: false, mode: 'smtp', error: `SMTP AUTH LOGIN username rejected: ${userResp.code}` });
            }
            const passResp = await sendCommand(Buffer.from(pass, 'utf8').toString('base64'));
            if (passResp.code >= 400) {
              return finish({ delivered: false, mode: 'smtp', error: `SMTP authentication failed: ${passResp.code}` });
            }
          } else if (supportsPlain) {
            const authToken = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
            const authRes = await sendCommand(`AUTH PLAIN ${authToken}`);
            if (authRes.code >= 400) {
              return finish({ delivered: false, mode: 'smtp', error: `SMTP authentication failed: ${authRes.code}` });
            }
          } else {
            return finish({
              delivered: false,
              mode: 'smtp',
              error: 'SMTP server did not advertise a supported authentication mechanism (PLAIN or LOGIN).',
            });
          }
        }

        const mailFrom = await sendCommand(`MAIL FROM:<${fromAddress}>`);
        if (mailFrom.code >= 400) {
          return finish({ delivered: false, mode: 'smtp', error: `SMTP MAIL FROM rejected: ${mailFrom.code}` });
        }

        const rcptTo = await sendCommand(`RCPT TO:<${toAddress}>`);
        if (rcptTo.code >= 400) {
          return finish({ delivered: false, mode: 'smtp', error: `SMTP RCPT TO rejected: ${rcptTo.code}` });
        }

        const dataCmd = await sendCommand('DATA');
        if (dataCmd.code >= 400) {
          return finish({ delivered: false, mode: 'smtp', error: `SMTP DATA rejected: ${dataCmd.code}` });
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
          return finish({ delivered: false, mode: 'smtp', error: `SMTP message rejected: ${dataDone.code}` });
        }

        await sendCommand('QUIT').catch(() => {});
        return finish({ delivered: true, mode: 'smtp', messageId });
      } catch (err: any) {
        return finish({ delivered: false, mode: 'smtp', error: err?.message || 'SMTP send failure' });
      }
    })();
  });
}

export async function sendTransactionalEmail(email: OutgoingEmail): Promise<EmailDeliveryResult> {
  if (customEmailTransport) {
    const res = await customEmailTransport(email);
    recordDevOutbox(email, 'custom_transport');
    return res;
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
    };
  }

  console.warn('[AIXSHOP Mail] Password reset email skipped: SMTP_HOST is not configured in production.');
  return {
    delivered: false,
    mode: 'unconfigured',
    error: 'SMTP transport is not configured in production.',
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
