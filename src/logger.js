import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['password', '*.password', 'Password', 'headers.cookie', 'req.headers.cookie', 'cookie', 'sessionSecret'],
    censor: '[redacted]',
  },
});
