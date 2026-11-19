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

/**
 * Minimal standards-compliant SMTP delivery client using Node's built-in net/tls sockets.
 * Supports SMTPS (port 465 / SMTP_SECURE=true), STARTTLS (port 587), and AUTH PLAIN/LOGIN.
 */
async function sendViaSmtp(email: OutgoingEmail): Promise<EmailDeliveryResult> {
  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;
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
      ? tls.connect({ host, port, servername: host, rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false' })
      : net.connect({ host, port });

    const finish = (result: EmailDeliveryResult) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(result);
    };

    socket.setTimeout(TIMEOUT_MS, () => {
      finish({ delivered: false, mode: 'smtp', error: `SMTP connection timed out after ${TIMEOUT_MS}ms` });
    });

    let buffer = '';
    const waiters: Array<(line: { code: number; text: string }) => void> = [];

    const attachSocketListeners = (sock: net.Socket | tls.TLSSocket) => {
      sock.on('error', (err) => {
        finish({ delivered: false, mode: 'smtp', error: err?.message || 'SMTP socket error' });
      });

      sock.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (/^\d{3} /.test(line)) {
            const code = parseInt(line.slice(0, 3), 10);
            const nextWaiter = waiters.shift();
            if (nextWaiter) {
              nextWaiter({ code, text: line });
            }
          }
        }
      });
    };

    const readResponse = (): Promise<{ code: number; text: string }> =>
      new Promise((resWaiter) => {
        waiters.push(resWaiter);
      });

    const sendCommand = async (cmd: string): Promise<{ code: number; text: string }> => {
      const waiter = readResponse();
      socket.write(`${cmd}\r\n`);
      return waiter;
    };

    attachSocketListeners(socket);

    (async () => {
      try {
        const greeting = await readResponse();
        if (greeting.code >= 400) {
          return finish({ delivered: false, mode: 'smtp', error: `SMTP greeting failed: ${greeting.text}` });
        }

        const ehloHost = 'aixshop.local';
        let ehlo = await sendCommand(`EHLO ${ehloHost}`);
        if (ehlo.code >= 400) {
          return finish({ delivered: false, mode: 'smtp', error: `SMTP EHLO failed: ${ehlo.text}` });
        }

        if (!secure && port === 587) {
          const starttls = await sendCommand('STARTTLS');
          if (starttls.code === 220) {
            const upgraded = tls.connect({
              socket,
              servername: host,
              rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false',
            });
            socket.removeAllListeners();
            socket = upgraded;
            socket.setTimeout(TIMEOUT_MS, () => {
              finish({ delivered: false, mode: 'smtp', error: `SMTP TLS timed out after ${TIMEOUT_MS}ms` });
            });
            attachSocketListeners(socket);
            ehlo = await sendCommand(`EHLO ${ehloHost}`);
            if (ehlo.code >= 400) {
              return finish({ delivered: false, mode: 'smtp', error: `SMTP EHLO post-TLS failed: ${ehlo.text}` });
            }
          }
        }

        if (user && pass) {
          const authToken = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
          const authRes = await sendCommand(`AUTH PLAIN ${authToken}`);
          if (authRes.code >= 400) {
            return finish({ delivered: false, mode: 'smtp', error: `SMTP authentication failed: ${authRes.text}` });
          }
        }

        const mailFrom = await sendCommand(`MAIL FROM:<${fromAddress}>`);
        if (mailFrom.code >= 400) {
          return finish({ delivered: false, mode: 'smtp', error: `SMTP MAIL FROM rejected: ${mailFrom.text}` });
        }

        const rcptTo = await sendCommand(`RCPT TO:<${toAddress}>`);
        if (rcptTo.code >= 400) {
          return finish({ delivered: false, mode: 'smtp', error: `SMTP RCPT TO rejected: ${rcptTo.text}` });
        }

        const dataCmd = await sendCommand('DATA');
        if (dataCmd.code >= 400) {
          return finish({ delivered: false, mode: 'smtp', error: `SMTP DATA rejected: ${dataCmd.text}` });
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
          return finish({ delivered: false, mode: 'smtp', error: `SMTP message rejected: ${dataDone.text}` });
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
