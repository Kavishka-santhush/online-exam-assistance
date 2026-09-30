/**
 * Validated environment configuration.
 *
 * Every other module imports `env` from here instead of touching
 * `process.env` directly, so a missing variable fails fast at boot with a
 * readable message rather than an undefined at runtime.
 */

const path = require('node:path');
const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const csv = z
  .string()
  .optional()
  .transform((value) => (value ? value.split(',').map((item) => item.trim()).filter(Boolean) : []));

const bool = z
  .string()
  .optional()
  .transform((value) => value === 'true' || value === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),
  API_BASE_URL: z.string().url().default('http://localhost:5000'),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  CORS_ORIGINS: csv,
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('debug'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),

  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().min(1),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('openai/gpt-4o'),
  OPENROUTER_FALLBACK_MODEL: z.string().default('openai/gpt-4o-mini'),
  OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  OPENROUTER_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_DAILY_LIMIT_FREE: z.coerce.number().int().min(0).default(0),
  AI_DAILY_LIMIT_STARTER: z.coerce.number().int().min(0).default(20),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_CURRENCY: z.string().default('usd'),

  UPLOAD_DIR: z.string().default('uploads'),
  MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(50),
  ALLOWED_IMAGE_TYPES: csv,
  ALLOWED_DOCUMENT_TYPES: csv,
  ALLOWED_MEDIA_TYPES: csv,

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(2525),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM_NAME: z.string().default('Exam Platform'),
  MAIL_FROM_ADDRESS: z.string().default('no-reply@examplatform.local'),

  CERTIFICATE_SECRET: z.string().min(8).default('change-me-certificate-secret'),
  JWT_ACCESS_SECRET: z.string().min(8).default('change-me-internal-jwt-secret'),
  INTERNAL_API_TOKEN: z.string().optional(),

  CODE_EXECUTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  CODE_EXECUTION_MEMORY_MB: z.coerce.number().int().positive().default(128),
  CODE_EXECUTION_MAX_TESTS: z.coerce.number().int().positive().default(20),
  CODE_RUNNER: z.enum(['isolated-vm', 'disabled']).default('isolated-vm'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  AI_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  EXAM_SUBMIT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),

  AUTOSAVE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  AUTO_SUBMIT_SWEEP_CRON: z.string().default('*/1 * * * *'),
  REMINDER_SWEEP_CRON: z.string().default('*/5 * * * *'),
  CLEANUP_SWEEP_CRON: z.string().default('0 3 * * *'),
  EXAM_SCHEDULER_CRON: z.string().default('*/1 * * * *'),
  VIOLATION_AUTO_TERMINATE_COUNT: z.coerce.number().int().positive().default(8),

  PUPPETEER_ARGS: csv,
  PDF_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),

  ENABLE_WEBSOCKET_PROCTORING: bool,
  ENABLE_ADAPTIVE_TESTING: bool,
  ENABLE_LIVE_QUIZ: bool,
  ENABLE_PUBLIC_EXAM_CATALOG: bool,
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`✖ invalid environment configuration:\n${details}\n\nCopy .env.example to .env and fill in the values.`);
  process.exit(1);
}

const raw = parsed.data;

const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  uploadRoot: path.resolve(process.cwd(), raw.UPLOAD_DIR),
  corsOrigins: raw.CORS_ORIGINS.length ? raw.CORS_ORIGINS : [raw.CLIENT_URL],
  maxFileBytes: raw.MAX_FILE_SIZE_MB * 1024 * 1024,
  allowedUploadMimeTypes: [
    ...raw.ALLOWED_IMAGE_TYPES,
    ...raw.ALLOWED_DOCUMENT_TYPES,
    ...raw.ALLOWED_MEDIA_TYPES,
  ],
};

module.exports = env;
