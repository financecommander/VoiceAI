/**
 * Swarm Guard — VoiceAI Sandbox Enforcement
 *
 * Ensures VoiceAI only executes on authorised Swarm VMs.
 * Fails closed (process.exit(1)) if the environment is not a recognised
 * Swarm node. This is not a soft warning — the server will not start.
 *
 * Authorised nodes (DIRECTIVE-259):
 *   swarm-mainframe  34.148.140.31   orchestration / agents / directives
 *   swarm-gpu        35.227.111.161  inference engine
 *   fc-ai-portal     34.139.78.75    API hub / LLM key store
 *
 * Required env vars on each Swarm node:
 *   SWARM_ENVIRONMENT_ID=swarm
 *   SWARM_NODE_NAME=<swarm-mainframe|swarm-gpu|fc-ai-portal>
 *
 * Dev bypass (local development only):
 *   NODE_ENV=development  AND  VOICEAI_SWARM_BYPASS=true
 *   Both must be explicitly set — neither alone is sufficient.
 */

import os from 'os';
import type { Logger } from 'pino';

// ============================================================================
// Authorised Node Registry
// ============================================================================

export interface SwarmNode {
  name: string;
  externalIp: string;
  role: string;
}

export const SWARM_NODES: SwarmNode[] = [
  { name: 'swarm-mainframe', externalIp: '34.148.140.31',  role: 'orchestration' },
  { name: 'swarm-gpu',       externalIp: '35.227.111.161', role: 'inference' },
  { name: 'fc-ai-portal',    externalIp: '34.139.78.75',   role: 'api-hub' },
];

const ALLOWED_NODE_NAMES = new Set(SWARM_NODES.map(n => n.name));

// ============================================================================
// Guard
// ============================================================================

export interface SwarmGuardResult {
  allowed: boolean;
  reason: string;
  node: SwarmNode | null;
  bypass: boolean;
}

export function checkSwarmEnvironment(): SwarmGuardResult {
  const envId   = process.env.SWARM_ENVIRONMENT_ID ?? '';
  const nodeName = process.env.SWARM_NODE_NAME ?? '';
  const nodeEnv  = process.env.NODE_ENV ?? 'production';
  const bypass   = process.env.VOICEAI_SWARM_BYPASS === 'true';

  // Dev bypass — both flags must be set
  if (nodeEnv === 'development' && bypass) {
    return {
      allowed: true,
      reason: 'dev_bypass — VOICEAI_SWARM_BYPASS=true with NODE_ENV=development',
      node: null,
      bypass: true,
    };
  }

  // SWARM_ENVIRONMENT_ID must equal 'swarm'
  if (envId !== 'swarm') {
    return {
      allowed: false,
      reason: `SWARM_ENVIRONMENT_ID='${envId || '(unset)'}' — must be 'swarm'`,
      node: null,
      bypass: false,
    };
  }

  // SWARM_NODE_NAME must be a registered Swarm node
  if (!ALLOWED_NODE_NAMES.has(nodeName)) {
    return {
      allowed: false,
      reason: `SWARM_NODE_NAME='${nodeName || '(unset)'}' — not a recognised Swarm node (${[...ALLOWED_NODE_NAMES].join(', ')})`,
      node: null,
      bypass: false,
    };
  }

  const node = SWARM_NODES.find(n => n.name === nodeName)!;

  return {
    allowed: true,
    reason: `running on ${node.name} (${node.role})`,
    node,
    bypass: false,
  };
}

// ============================================================================
// Startup Enforcer — call this before the server accepts connections
// ============================================================================

export function requireSwarmEnvironment(logger: Logger): void {
  const result = checkSwarmEnvironment();
  const hostname = os.hostname();

  if (!result.allowed) {
    const lines = [
      '╔══════════════════════════════════════════════════════════════╗',
      '║  VOICEAI SANDBOX VIOLATION — SERVER WILL NOT START           ║',
      '╠══════════════════════════════════════════════════════════════╣',
      `║  Reason:    ${result.reason.padEnd(50)}║`,
      `║  Hostname:  ${hostname.padEnd(50)}║`,
      '╠══════════════════════════════════════════════════════════════╣',
      '║  VoiceAI is sandboxed to Swarm VMs only:                     ║',
      '║    swarm-mainframe  34.148.140.31  (orchestration)           ║',
      '║    swarm-gpu        35.227.111.161 (inference)               ║',
      '║    fc-ai-portal     34.139.78.75   (api-hub)                 ║',
      '╠══════════════════════════════════════════════════════════════╣',
      '║  Required env vars on each Swarm node:                       ║',
      '║    SWARM_ENVIRONMENT_ID=swarm                                ║',
      '║    SWARM_NODE_NAME=<node-name>                               ║',
      '║  Dev bypass (local only):                                    ║',
      '║    NODE_ENV=development  +  VOICEAI_SWARM_BYPASS=true        ║',
      '╚══════════════════════════════════════════════════════════════╝',
    ].join('\n');

    logger.fatal({ reason: result.reason, hostname, swarmEnvironmentId: process.env.SWARM_ENVIRONMENT_ID ?? '(unset)', swarmNodeName: process.env.SWARM_NODE_NAME ?? '(unset)' }, 'SWARM_GUARD_FAIL — VoiceAI sandbox violation');
    console.error('\n' + lines + '\n');
    process.exit(1);
  }

  if (result.bypass) {
    logger.warn({ hostname, reason: result.reason }, 'SWARM_GUARD_BYPASS — dev mode, sandbox suspended');
    return;
  }

  // Hostname cross-check (defence-in-depth; warn only — hostname may differ from node name on GCP)
  if (hostname !== result.node!.name && !hostname.startsWith(result.node!.name)) {
    logger.warn({
      hostname,
      swarmNodeName: result.node!.name,
    }, 'SWARM_GUARD_HOSTNAME_MISMATCH — os.hostname() does not match SWARM_NODE_NAME (non-fatal, verify GCP instance name)');
  }

  logger.info({
    node: result.node!.name,
    role: result.node!.role,
    externalIp: result.node!.externalIp,
    hostname,
  }, 'SWARM_GUARD_OK — VoiceAI sandbox check passed');
}
