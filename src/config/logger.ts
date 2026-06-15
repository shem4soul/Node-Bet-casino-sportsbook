import pino from 'pino';
import { env } from './env';

export const logger = pino({
  name: env.APP_NAME,
  level: env.isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-paystack-signature"]',
      '*.password',
      '*.passwordHash',
      '*.password_hash',
      '*.refreshToken',
      '*.token',
    ],
    censor: '[redacted]',
  },
  ...(env.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
        },
      }),
});
