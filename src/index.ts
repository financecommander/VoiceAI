/**
 * Calculus Voice Agent — Entry Point
 *
 * Architecture:
 *   Telephony → Pipeline Controller → { Modular | Grok S2S } → Telephony
 *
 * Modular: Deepgram STT → ComplianceEnforcer → LLM (GPT-4o/Claude) → Cartesia TTS
 * Grok S2S: Audio → Grok Voice API → Audio (informational queries only)
 */

export { VoicePipelineController } from './gateway/pipeline-controller.js';
export { GrokVoiceAdapter } from './gateway/grok-adapter.js';
export { ConversationOrchestrator, routeIntent } from './orchestrator/orchestrator.js';
export { ComplianceEnforcer, DEFAULT_COMPLIANCE_CONFIG } from './compliance/enforcer.js';
export { GHLService, HubSpotService, UnifiedCRMAdapter } from './services/crm/index.js';
export { LLMService, ToolExecutor, buildToolSchemas } from './llm/index.js';
export * from './types.js';
export type * from './services/contracts.js';
