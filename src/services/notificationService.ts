import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { createLogger, maskEmail } from '../config/logger';

const logger = createLogger('email');

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.SMTP_URL) return null;
  transporter ??= nodemailer.createTransport(env.SMTP_URL);
  return transporter;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** Sends an email via SMTP_URL, or logs it when SMTP is not configured. Never throws. */
export async function sendMail(mail: Mail): Promise<void> {
  const t = getTransporter();
  if (!t) {
    if (env.isProduction)
      logger.warn({ event: 'email.not_sent', to: maskEmail(mail.to), subject: mail.subject }, 'SMTP_URL not configured — email NOT sent');
    // Dev only: print the full email (including reset links) so flows can be tested without SMTP.
    else
      logger.info(
        { event: 'email.logged', to: mail.to, subject: mail.subject, text: mail.text },
        'Email (SMTP not configured, logging instead)'
      );
    return;
  }
  try {
    await t.sendMail({ from: env.MAIL_FROM, ...mail });
    logger.info({ event: 'email.sent', to: maskEmail(mail.to), subject: mail.subject }, 'Email sent');
  } catch (err) {
    logger.error({ event: 'email.failed', err, to: maskEmail(mail.to), subject: mail.subject }, 'Failed to send email');
  }
}
