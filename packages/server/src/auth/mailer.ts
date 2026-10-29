import nodemailer, { type Transporter } from 'nodemailer';
import type { ServerConfig } from '../config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** The action link (verification / reset). Kept separate so the dev outbox can show it. */
  link: string;
  kind: 'verify-email' | 'reset-password';
}

/** Outgoing account emails. Implementations must never log message bodies or links. */
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * Development/test mailer: keeps the last messages in memory so a developer (or
 * a test) can open the link. Exposed over HTTP only when DEV_MAIL_OUTBOX is on,
 * which production refuses.
 */
export class OutboxMailer implements Mailer {
  readonly messages: (MailMessage & { at: number })[] = [];

  async send(message: MailMessage): Promise<void> {
    this.messages.push({ ...message, at: Date.now() });
    if (this.messages.length > 200) this.messages.shift();
  }

  /** Most recent message for an address (and kind), if any. */
  latest(to: string, kind?: MailMessage['kind']): MailMessage | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m && m.to.toLowerCase() === to.toLowerCase() && (!kind || m.kind === kind)) return m;
    }
    return undefined;
  }
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text });
  }
}

export function createMailer(config: ServerConfig): Mailer {
  if (config.mailMode === 'smtp' && config.smtpUrl) return new SmtpMailer(config.smtpUrl, config.mailFrom);
  return new OutboxMailer();
}
