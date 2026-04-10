/**
 * GCP Secret Manager loader — pre-populates process.env at startup
 *
 * Called once before validateEnvironment(). Fetches secrets from GCP SM
 * and sets them in process.env, so the rest of the app reads them normally.
 *
 * Only runs when SECRETS_BACKEND=gcp (or GCP_PROJECT_ID is set).
 * Falls back to existing process.env values if a secret isn't found in SM.
 *
 * Activation:
 *   Set SECRETS_BACKEND=gcp in your systemd unit / startup script.
 *   GCP_PROJECT_ID and SECRET_PREFIX must also be set.
 *
 * On GCP VMs with the correct service account attached, no credentials
 * are needed — ADC (Application Default Credentials) handles auth.
 *
 * Usage (in index.ts, before requireValidEnvironment):
 *   import { loadSecretsFromGCP } from './config/load-secrets.js';
 *   await loadSecretsFromGCP();
 *   requireValidEnvironment(logger);
 */

import type { Logger } from 'pino';

// All secret keys VoiceAI needs — maps to GCP secret names: {PREFIX}-{KEY}
const SECRET_KEYS = [
  // Telephony
  'TELNYX_API_KEY',
  'TELNYX_CONNECTION_ID',
  // LLM
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'XAI_API_KEY',
  // STT / TTS
  'DEEPGRAM_API_KEY',
  'CARTESIA_API_KEY',
  // Database
  'DATABASE_URL',
  'REDIS_URL',
  // CRM
  'HUBSPOT_ACCESS_TOKEN',
  'GHL_API_KEY',
  'GHL_LOCATION_ID_CT',
  'GHL_LOCATION_ID_TILT',
  'GHL_LOCATION_ID_EUREKA',
  // Internal services
  'OPENCLAW_API_KEY',
  'AI_PORTAL_API_KEY',
  'SWARM_API_KEY',
  // JWT
  'JWT_SECRET',
] as const;

export async function loadSecretsFromGCP(logger?: Logger): Promise<void> {
  const backend = process.env.SECRETS_BACKEND;
  const projectId = process.env.GCP_PROJECT_ID;

  // Only activate if explicitly configured
  if (backend !== 'gcp' && !projectId) {
    logger?.debug('GCP secrets loader: skipped (SECRETS_BACKEND != gcp and GCP_PROJECT_ID not set)');
    return;
  }

  if (!projectId) {
    throw new Error('GCP_PROJECT_ID must be set when SECRETS_BACKEND=gcp');
  }

  const prefix = process.env.SECRET_PREFIX ?? 'portal';

  logger?.info({ projectId, prefix, keyCount: SECRET_KEYS.length }, 'Loading secrets from GCP Secret Manager');

  // Lazy import — only load the GCP library when actually needed
  // @ts-ignore — optional dependency, installed on GCP nodes only
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager').catch(() => {
    throw new Error(
      'GCP Secret Manager client not installed. Run: npm install @google-cloud/secret-manager'
    );
  });

  const client = new SecretManagerServiceClient();

  let loaded = 0;
  let skipped = 0;
  const failures: string[] = [];

  await Promise.all(SECRET_KEYS.map(async (key) => {
    // Don't overwrite if already set (allows local override for dev)
    if (process.env[key]) {
      skipped++;
      return;
    }

    const secretName = `projects/${projectId}/secrets/${prefix}-${key}/versions/latest`;

    try {
      const [version] = await client.accessSecretVersion({ name: secretName });
      const value = version.payload?.data?.toString();

      if (value) {
        process.env[key] = value;
        loaded++;
      } else {
        logger?.warn({ key }, 'GCP secret found but empty');
        failures.push(key);
      }
    } catch {
      // Secret doesn't exist in SM — not necessarily an error if it's optional
      logger?.debug({ key, secretName }, 'Secret not found in GCP SM — will rely on env');
      failures.push(key);
    }
  }));

  logger?.info(
    { loaded, skipped, notFound: failures.length },
    'GCP secrets loaded',
  );

  if (failures.length > 0) {
    logger?.debug({ failures }, 'Keys not found in GCP SM (will use existing env or fail validation)');
  }
}
