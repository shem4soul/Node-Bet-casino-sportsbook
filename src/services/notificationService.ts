import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../config/logger';

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
    if (env.isProduction) logger.warn({ to: mail.to, subject: mail.subject }, 'SMTP_URL not configured — email NOT sent');
    else logger.info({ mail }, 'Email (SMTP not configured, logging instead)');
    return;
  }
  try {
    await t.sendMail({ from: env.MAIL_FROM, ...mail });
  } catch (err) {
    logger.error({ err, to: mail.to }, 'Failed to send email');
  }
}
