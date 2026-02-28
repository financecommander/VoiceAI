/**
 * Environment Validation — Fail-Fast Startup Checks
 *
 * Validates all required environment variables are set before the server
 * accepts connections. Groups vars by severity:
 *   FATAL:   Server cannot start (API keys, DB, telephony)
 *   WARNING: Degraded functionality (optional integrations)
 */

import type { Logger } from 'pino';

interface EnvVar {
  name: string;
  severity: 'fatal' | 'warning';
  description: string;
  validate?: (value: string) => boolean;
}

const REQUIRED_VARS: EnvVar[] = [
  // --- Telephony (fatal) ---
  { name: 'TWILIO_ACCOUNT_SID', severity: 'fatal', description: 'Twilio account SID for call handling' },
  { name: 'TWILIO_AUTH_TOKEN', severity: 'fatal', description: 'Twilio auth token for webhook validation' },

  // --- LLM Providers (fatal — need at least one) ---
  { name: 'OPENAI_API_KEY', severity: 'fatal', description: 'OpenAI API key for GPT-4o' },
  { name: 'ANTHROPIC_API_KEY', severity: 'fatal', description: 'Anthropic API key for Claude' },

  // --- STT/TTS (fatal) ---
  { name: 'DEEPGRAM_API_KEY', severity: 'fatal', description: 'Deepgram API key for speech-to-text' },
  { name: 'CARTESIA_API_KEY', severity: 'fatal', description: 'Cartesia API key for text-to-speech' },

  // --- Database (fatal) ---
  { name: 'DATABASE_URL', severity: 'fatal', description: 'PostgreSQL connection string',
    validate: (v) => v.startsWith('postgres') },

  // --- CRM (warning — degraded but functional) ---
  { name: 'GHL_API_KEY', severity: 'warning', description: 'GoHighLevel API key for CRM sync' },
  { name: 'GHL_LOCATION_ID', severity: 'warning', description: 'GoHighLevel location ID' },
  { name: 'HUBSPOT_ACCESS_TOKEN', severity: 'warning', description: 'HubSpot access token for CRM sync' },

  // --- Optional Integrations (warning) ---
  { name: 'REDIS_URL', severity: 'warning', description: 'Redis connection string for session caching' },
  { name: 'GROK_API_KEY', severity: 'warning', description: 'xAI Grok API key for voice-to-voice' },

  // --- Phone Numbers (warning — defaults to DMC) ---
  { name: 'PHONE_DMC', severity: 'warning', description: 'Inbound phone number for DMC model' },
  { name: 'PHONE_CT', severity: 'warning', description: 'Inbound phone number for Constitutional Tender' },
  { name: 'PHONE_TILT', severity: 'warning', description: 'Inbound phone number for TILT lending' },
  { name: 'PHONE_MORTGAGE', severity: 'warning', description: 'Inbound phone number for Mortgage' },
  { name: 'PHONE_REAL_ESTATE', severity: 'warning', description: 'Inbound phone number for Real Estate' },
  { name: 'PHONE_EUREKA', severity: 'warning', description: 'Inbound phone number for Eureka settlement' },
  { name: 'PHONE_LOAN_SERVICING', severity: 'warning', description: 'Inbound phone number for Loan Servicing' },
  { name: 'PHONE_IFSE', severity: 'warning', description: 'Inbound phone number for IFSE treasury' },
];

export interface ValidationResult {
  valid: boolean;
  fatal: string[];
  warnings: string[];
}

export function validateEnvironment(logger?: Logger): ValidationResult {
  const fatal: string[] = [];
  const warnings: string[] = [];

  for (const v of REQUIRED_VARS) {
    const value = process.env[v.name];

    if (!value || value.trim() === '') {
      if (v.severity === 'fatal') {
        fatal.push(`${v.name} — ${v.description}`);
      } else {
        warnings.push(`${v.name} — ${v.description}`);
      }
      continue;
    }

    if (v.validate && !v.validate(value)) {
      fatal.push(`${v.name} — invalid format (${v.description})`);
    }
  }

  const result: ValidationResult = {
    valid: fatal.length === 0,
    fatal,
    warnings,
  };

  if (logger) {
    if (warnings.length > 0) {
      logger.warn({ missing: warnings }, `${warnings.length} optional env var(s) not set — some features disabled`);
    }
    if (fatal.length > 0) {
      logger.error({ missing: fatal }, `${fatal.length} required env var(s) missing — server cannot start`);
    }
    if (result.valid) {
      logger.info('Environment validation passed');
    }
  }

  return result;
}

/**
 * Call at server startup. Throws if fatal vars are missing.
 */
export function requireValidEnvironment(logger?: Logger): void {
  const result = validateEnvironment(logger);
  if (!result.valid) {
    const msg = [
      '═══ FATAL: Missing required environment variables ═══',
      '',
      ...result.fatal.map(f => `  ✗ ${f}`),
      '',
      'Copy .env.example → .env and fill in the required values.',
      '═════════════════════════════════════════════════════════',
    ].join('\n');

    // Log and throw — don't just exit, let the caller handle it
    if (logger) logger.fatal(msg);
    throw new Error(`Missing ${result.fatal.length} required environment variable(s)`);
  }
}
