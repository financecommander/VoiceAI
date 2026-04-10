/**
 * LLM Provider — Multi-Model Response Generation
 *
 * Manages conversation with GPT-4o (fast) and Claude (complex/compliance).
 * Handles:
 *   - System prompt construction per model + intent
 *   - Conversation history management
 *   - Tool definition + execution loop
 *   - Latency budget enforcement with fallback
 *   - Response post-processing (length, compliance checks)
 *
 * This is the "brain" layer between the orchestrator and the TTS output.
 * The orchestrator decides WHICH LLM to call; this module executes the call.
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import type { Logger } from 'pino';
import type { CalcModel, AuthTier, Intent } from '../types.js';
import type { LLMProvider as LLMProviderType, PipelineMode } from '../orchestrator/orchestrator.js';
import { isOpenClawConfigured } from '../services/openclaw-client.js';
import { isSwarmConfigured } from '../services/swarm-gateway.js';

// ============================================================================
// Configuration
// ============================================================================

export interface LLMConfig {
  openaiApiKey: string;
  anthropicApiKey: string;

  /** GPT-4o model string */
  gpt4oModel: string;

  /** Claude model string */
  claudeModel: string;

  /** Max tokens per response (voice — keep short) */
  maxTokens: number;

  /** Temperature by provider */
  temperature: {
    'gpt-4o': number;
    claude: number;
    'grok'?: number;
  };

  /**
   * Optional AI Portal base URL for unified LLM routing.
   * When set, OpenAI calls route through the portal's OpenAI-compatible endpoint.
   * This enables centralized key management and model access via fc-ai-portal.
   */
  aiPortalUrl?: string;

  /** API key for AI Portal authentication */
  aiPortalApiKey?: string;

  xaiApiKey?: string;
  grokModel?: string;
}

export const DEFAULT_LLM_CONFIG: Partial<LLMConfig> = {
  gpt4oModel: 'gpt-4o',
  claudeModel: 'claude-sonnet-4-5-20250929',
  maxTokens: 300,   // ~20 seconds of speech at normal pace
  temperature: {
    'gpt-4o': 0.3,   // Low — factual, consistent
    claude: 0.4,      // Slightly higher — nuanced reasoning
    'grok': 0.3,
  },
};

// ============================================================================
// Conversation Message Types
// ============================================================================

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;          // Tool name for tool results
  toolCallId?: string;    // For tool result messages
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  text: string;
  provider: LLMProviderType;
  toolCalls: ToolCallRequest[];
  latencyMs: number;
  tokensUsed: number;
  wasFallback: boolean;
}

/**
 * Router training log entry emitted after every LLM call.
 * Consumed by the router logger callback — written to telemetry_snapshots
 * and router_training_log tables for adaptive_provider_router training data.
 */
export interface RouterLogEntry {
  requestId: string;
  telemetrySnapshotId: string;
  conversationId: string;
  provider: LLMProviderType;
  taskType: string;
  actualLatencyMs: number;
  callSuccess: boolean;
  wasFallback: boolean;
}

// ============================================================================
// LLM Service
// ============================================================================

export class LLMService {
  private openai: OpenAI;
  private anthropic: Anthropic;
  private xai?: OpenAI;
  private config: LLMConfig;
  private logger: Logger;
  private costGuard?: import('../services/cost-guard.js').CostGuard;
  private routerLogger?: (entry: RouterLogEntry) => void;

  /** Conversation history per session */
  private history: Map<string, ConversationMessage[]> = new Map();

  setCostGuard(guard: import('../services/cost-guard.js').CostGuard): void {
    this.costGuard = guard;
  }

  /**
   * Attach a router logger callback for adaptive_provider_router training data.
   * The callback is fire-and-forget — errors are swallowed so logging never
   * blocks or fails voice calls.
   */
  setRouterLogger(fn: (entry: RouterLogEntry) => void): void {
    this.routerLogger = fn;
  }

  constructor(config: LLMConfig, logger: Logger) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config } as LLMConfig;
    this.logger = logger.child({ component: 'LLMService' });

    // Route through AI Portal if configured, otherwise direct to providers
    const aiPortalUrl = config.aiPortalUrl || process.env.AI_PORTAL_URL;
    const aiPortalKey = config.aiPortalApiKey || process.env.AI_PORTAL_API_KEY;

    if (aiPortalUrl) {
      this.logger.info({ url: aiPortalUrl }, 'LLM routing through AI Portal');
      // AI Portal exposes OpenAI-compatible endpoint — route GPT-4o calls through it
      this.openai = new OpenAI({
        apiKey: aiPortalKey || config.openaiApiKey,
        baseURL: `${aiPortalUrl}/v1`,
      });
    } else {
      this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    }

    this.anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

    if (config.xaiApiKey || process.env.XAI_API_KEY) {
      this.xai = new OpenAI({
        apiKey: config.xaiApiKey || process.env.XAI_API_KEY || '',
        baseURL: 'https://api.x.ai/v1',
      });
    }
  }

  // ==========================================================================
  // Main Entry Point
  // ==========================================================================

  /**
   * Generate a response from the specified LLM provider.
   * Includes tool execution loop — may make multiple LLM calls
   * if the model requests tool calls.
   */
  async generateResponse(params: {
    conversationId: string;
    provider: LLMProviderType;
    model: CalcModel;
    intent: Intent | null;
    authTier: AuthTier;
    userUtterance: string;
    systemInstruction: string;
    tools: ToolDefinition[];
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    latencyBudgetMs: number;
  }): Promise<LLMResponse> {
    const startTime = Date.now();
    // Pre-allocate IDs for router training log — generated before call so
    // telemetry_snapshot and router_training_log rows share consistent IDs.
    const _routerRequestId = randomUUID();
    const _routerSnapshotId = randomUUID();

    // Get or create conversation history
    if (!this.history.has(params.conversationId)) {
      const systemPrompt = this.buildSystemPrompt(
        params.model,
        params.intent,
        params.authTier,
        params.systemInstruction,
      );
      this.history.set(params.conversationId, [
        { role: 'system', content: systemPrompt },
      ]);
    }

    const messages = this.history.get(params.conversationId)!;

    // Add user message
    messages.push({ role: 'user', content: params.userUtterance });

    // Try primary provider
    try {
      // Cost guard: check budget + circuit breaker before calling
      if (this.costGuard) {
        const budget = await this.costGuard.checkBudget(params.provider, params.conversationId);
        if (!budget.allowed) {
          throw new Error(`CostGuard: ${budget.reason}`);
        }
        if (await this.costGuard.isCircuitOpen(params.provider)) {
          throw new Error(`CostGuard: circuit breaker open for ${params.provider}`);
        }
      }

      const response = await this.callWithTimeout(
        params.provider,
        messages,
        params.tools,
        params.toolExecutor,
        params.latencyBudgetMs,
      );

      // Record usage + success
      if (this.costGuard) {
        await this.costGuard.recordUsage(params.provider, params.conversationId, response.tokensUsed);
        await this.costGuard.recordSuccess(params.provider);
      }

      // Add assistant response to history
      messages.push({ role: 'assistant', content: response.text });

      // Post-process for voice
      response.text = this.postProcessForVoice(response.text);

      response.latencyMs = Date.now() - startTime;

      // Router training log — fire-and-forget, never blocks call path
      if (this.routerLogger) {
        try {
          this.routerLogger({
            requestId: _routerRequestId,
            telemetrySnapshotId: _routerSnapshotId,
            conversationId: params.conversationId,
            provider: params.provider,
            taskType: params.model,
            actualLatencyMs: response.latencyMs,
            callSuccess: true,
            wasFallback: false,
          });
        } catch (_) { /* swallow — logging must never affect call path */ }
      }

      return response;

    } catch (error) {
      // Record error for circuit breaker (skip for budget/circuit errors — not provider faults)
      const errMsg = (error as Error).message;
      if (this.costGuard && !errMsg.startsWith('CostGuard:')) {
        await this.costGuard.recordError(params.provider);
      }

      // Fallback to GPT-4o if primary fails
      if (params.provider !== 'gpt-4o') {
        this.logger.warn({
          provider: params.provider,
          error: errMsg,
        }, 'Primary LLM failed, falling back to GPT-4o');

        try {
          // Check fallback budget too
          if (this.costGuard) {
            const fallbackBudget = await this.costGuard.checkBudget('gpt-4o', params.conversationId);
            if (!fallbackBudget.allowed) throw new Error(`CostGuard: ${fallbackBudget.reason}`);
          }

          const fallback = await this.callWithTimeout(
            'gpt-4o',
            messages,
            params.tools,
            params.toolExecutor,
            5000, // Give fallback generous budget
          );

          if (this.costGuard) {
            await this.costGuard.recordUsage('gpt-4o', params.conversationId, fallback.tokensUsed);
            await this.costGuard.recordSuccess('gpt-4o');
          }

          messages.push({ role: 'assistant', content: fallback.text });
          fallback.text = this.postProcessForVoice(fallback.text);
          fallback.latencyMs = Date.now() - startTime;
          fallback.wasFallback = true;

          // Router training log — fallback call (separate request_id)
          if (this.routerLogger) {
            try {
              this.routerLogger({
                requestId: randomUUID(),
                telemetrySnapshotId: randomUUID(),
                conversationId: params.conversationId,
                provider: 'gpt-4o',
                taskType: params.model,
                actualLatencyMs: fallback.latencyMs,
                callSuccess: true,
                wasFallback: true,
              });
            } catch (_) { /* swallow */ }
          }

          return fallback;

        } catch (fallbackError) {
          this.logger.error({ error: fallbackError }, 'Fallback LLM also failed');
        }
      }

      // Total failure — return safe generic response
      const safeResponse: LLMResponse = {
        text: "I'm having a little trouble right now. Let me connect you with a team member who can help.",
        provider: params.provider,
        toolCalls: [],
        latencyMs: Date.now() - startTime,
        tokensUsed: 0,
        wasFallback: true,
      };
      messages.push({ role: 'assistant', content: safeResponse.text });
      return safeResponse;
    }
  }

  // ==========================================================================
  // Streaming Response Generation
  // ==========================================================================

  /**
   * Generate a streaming response from the specified LLM provider.
   * Buffers tokens until sentence boundaries, then flushes each sentence
   * through the onChunk callback for incremental TTS synthesis.
   */
  async generateResponseStreaming(params: {
    conversationId: string;
    provider: LLMProviderType;
    model: CalcModel;
    intent: Intent | null;
    authTier: AuthTier;
    userUtterance: string;
    systemInstruction: string;
    tools: ToolDefinition[];
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>;
    latencyBudgetMs: number;
    onChunk: (text: string, isDone: boolean) => void;
  }): Promise<LLMResponse> {
    const startTime = Date.now();

    // Get or create conversation history
    if (!this.history.has(params.conversationId)) {
      const systemPrompt = this.buildSystemPrompt(
        params.model,
        params.intent,
        params.authTier,
        params.systemInstruction,
      );
      this.history.set(params.conversationId, [
        { role: 'system', content: systemPrompt },
      ]);
    }

    const messages = this.history.get(params.conversationId)!;
    messages.push({ role: 'user', content: params.userUtterance });

    try {
      let response: LLMResponse;

      if (params.provider === 'gpt-4o') {
        response = await this.streamGPT4o(messages, params.tools, params.toolExecutor, params.onChunk);
      } else if (params.provider === 'claude') {
        response = await this.streamClaude(messages, params.tools, params.toolExecutor, params.onChunk);
      } else {
        // Fallback: non-streaming for unsupported providers
        response = await this.callWithTimeout(
          params.provider,
          messages,
          params.tools,
          params.toolExecutor,
          params.latencyBudgetMs,
        );
        const processed = this.postProcessForVoice(response.text);
        params.onChunk(processed, false);
        params.onChunk('', true);
      }

      messages.push({ role: 'assistant', content: response.text });
      response.latencyMs = Date.now() - startTime;
      return response;

    } catch (error) {
      this.logger.error({ error: (error as Error).message }, 'Streaming LLM failed');

      const safeResponse: LLMResponse = {
        text: "I'm having a little trouble right now. Let me connect you with a team member who can help.",
        provider: params.provider,
        toolCalls: [],
        latencyMs: Date.now() - startTime,
        tokensUsed: 0,
        wasFallback: true,
      };
      messages.push({ role: 'assistant', content: safeResponse.text });
      params.onChunk(safeResponse.text, false);
      params.onChunk('', true);
      return safeResponse;
    }
  }

  // --------------------------------------------------------------------------
  // Streaming — GPT-4o
  // --------------------------------------------------------------------------

  private async streamGPT4o(
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    onChunk: (text: string, isDone: boolean) => void,
  ): Promise<LLMResponse> {
    const openaiMessages = messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant' | 'tool',
      content: m.content,
      ...(m.name && { name: m.name }),
      ...(m.toolCallId && { tool_call_id: m.toolCallId }),
    }));

    const openaiTools = tools.length > 0
      ? tools.map(t => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined;

    let totalTokens = 0;
    const allToolCalls: ToolCallRequest[] = [];

    // Stream from the start — no probe call. Tool calls are detected mid-stream.
    // This eliminates the 200-500ms latency from the old probe-then-stream pattern.
    let maxRounds = 5;
    while (maxRounds-- > 0) {
      const stream = await this.openai.chat.completions.create({
        model: this.config.gpt4oModel,
        messages: openaiMessages as any,
        ...(openaiTools ? { tools: openaiTools } : {}),
        temperature: this.config.temperature['gpt-4o'],
        max_tokens: this.config.maxTokens,
        stream: true,
      });

      let fullText = '';
      let buffer = '';
      // Accumulate tool calls from streamed deltas
      const pendingToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
      let hasToolCalls = false;

      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) continue;

        // Text delta — flush to TTS at phrase boundaries (not just sentences)
        const textDelta = choice.delta?.content ?? '';
        if (textDelta) {
          fullText += textDelta;
          buffer += textDelta;

          // Flush at phrase boundaries: sentence-enders AND commas/dashes after 40+ chars
          // This streams audio ~2x faster than waiting for full sentences
          const phraseEnd = this.findPhraseBoundary(buffer);
          if (phraseEnd >= 0) {
            const phrase = buffer.substring(0, phraseEnd + 1).trim();
            buffer = buffer.substring(phraseEnd + 1);
            if (phrase) {
              const processed = this.postProcessForVoice(phrase);
              if (processed) onChunk(processed, false);
            }
          }
        }

        // Tool call delta — accumulate without blocking text streaming
        if (choice.delta?.tool_calls) {
          hasToolCalls = true;
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index;
            if (!pendingToolCalls.has(idx)) {
              pendingToolCalls.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' });
            }
            const pending = pendingToolCalls.get(idx)!;
            if (tc.id) pending.id = tc.id;
            if (tc.function?.name) pending.name = tc.function.name;
            if (tc.function?.arguments) pending.arguments += tc.function.arguments;
          }
        }
      }

      // Flush remaining text buffer
      if (buffer.trim()) {
        const processed = this.postProcessForVoice(buffer.trim());
        if (processed) onChunk(processed, false);
      }

      // If tool calls were detected, execute them and loop back
      if (hasToolCalls && pendingToolCalls.size > 0) {
        const assistantToolCalls = Array.from(pendingToolCalls.values()).map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }));

        openaiMessages.push({
          role: 'assistant',
          content: fullText || null,
          tool_calls: assistantToolCalls,
        } as any);

        // Execute tools in parallel (non-blocking — they don't depend on each other)
        const toolPromises = assistantToolCalls.map(async (tc) => {
          const args = JSON.parse(tc.function.arguments);
          allToolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
          this.logger.info({ tool: tc.function.name, args }, 'Executing tool call (streaming)');
          try {
            const result = await toolExecutor(tc.function.name, args);
            return { role: 'tool' as const, content: JSON.stringify(result), tool_call_id: tc.id };
          } catch (toolError) {
            this.logger.error({ tool: tc.function.name, error: toolError }, 'Tool execution failed');
            return { role: 'tool' as const, content: JSON.stringify({ error: 'Tool execution failed' }), tool_call_id: tc.id };
          }
        });

        const toolResults = await Promise.all(toolPromises);
        for (const tr of toolResults) {
          openaiMessages.push(tr as any);
        }
        continue; // Next round with tool results
      }

      // No tool calls — streaming complete
      onChunk('', true);

      return {
        text: fullText,
        provider: 'gpt-4o',
        toolCalls: allToolCalls,
        latencyMs: 0,
        tokensUsed: totalTokens,
        wasFallback: false,
      };
    }

    throw new Error('GPT-4o streaming exceeded max tool call rounds');
  }

  // --------------------------------------------------------------------------
  // Streaming — Claude
  // --------------------------------------------------------------------------

  private async streamClaude(
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    onChunk: (text: string, isDone: boolean) => void,
  ): Promise<LLMResponse> {
    const systemMessage = messages.find(m => m.role === 'system')?.content ?? '';
    const conversationMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'tool' ? 'user' as const : m.role as 'user' | 'assistant',
        content: m.role === 'tool'
          ? [{ type: 'tool_result' as const, tool_use_id: m.toolCallId ?? '', content: m.content }]
          : m.content,
      }));

    const claudeTools = tools.length > 0
      ? tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as any,
        }))
      : undefined;

    let totalTokens = 0;
    const allToolCalls: ToolCallRequest[] = [];

    // Stream with tools from the start. Tool calls detected via stream events.
    // Text is flushed to TTS at phrase boundaries for minimal time-to-first-audio.
    let maxRounds = 5;
    while (maxRounds-- > 0) {
      const stream = this.anthropic.messages.stream({
        model: this.config.claudeModel,
        max_tokens: this.config.maxTokens,
        system: systemMessage,
        messages: conversationMessages as any,
        ...(claudeTools ? { tools: claudeTools } : {}),
        temperature: this.config.temperature.claude,
      });

      let fullText = '';
      let buffer = '';
      const pendingToolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];

      stream.on('text', (text: string) => {
        fullText += text;
        buffer += text;

        // Flush at phrase boundaries (commas after 40+ chars, sentence-enders)
        const phraseEnd = this.findPhraseBoundary(buffer);
        if (phraseEnd >= 0) {
          const phrase = buffer.substring(0, phraseEnd + 1).trim();
          buffer = buffer.substring(phraseEnd + 1);
          if (phrase) {
            const processed = this.postProcessForVoice(phrase);
            if (processed) onChunk(processed, false);
          }
        }
      });

      // Collect tool_use blocks as they complete
      stream.on('contentBlock', (block: any) => {
        if (block.type === 'tool_use') {
          pendingToolUses.push({ id: block.id, name: block.name, input: block.input });
        }
      });

      const finalMessage = await stream.finalMessage();
      totalTokens += (finalMessage.usage?.input_tokens ?? 0) + (finalMessage.usage?.output_tokens ?? 0);

      // Flush remaining text buffer
      if (buffer.trim()) {
        const processed = this.postProcessForVoice(buffer.trim());
        if (processed) onChunk(processed, false);
      }

      // If tool calls detected, execute in parallel and loop back
      if (finalMessage.stop_reason === 'tool_use' && pendingToolUses.length > 0) {
        conversationMessages.push({ role: 'assistant', content: finalMessage.content as any });

        // Execute all tools in parallel (non-blocking)
        const toolPromises = pendingToolUses.map(async (tu) => {
          allToolCalls.push({ id: tu.id, name: tu.name, arguments: tu.input });
          this.logger.info({ tool: tu.name, args: tu.input }, 'Executing tool call (Claude streaming)');
          try {
            const result = await toolExecutor(tu.name, tu.input);
            return { type: 'tool_result' as const, tool_use_id: tu.id, content: JSON.stringify(result) };
          } catch (toolError) {
            this.logger.error({ tool: tu.name, error: toolError }, 'Tool execution failed');
            return { type: 'tool_result' as const, tool_use_id: tu.id, content: JSON.stringify({ error: 'Tool execution failed' }), is_error: true };
          }
        });

        const toolResults = await Promise.all(toolPromises);
        conversationMessages.push({ role: 'user', content: toolResults as any });
        continue; // Next round with tool results
      }

      // No tool calls — streaming complete
      onChunk('', true);

      return {
        text: fullText,
        provider: 'claude',
        toolCalls: allToolCalls,
        latencyMs: 0,
        tokensUsed: totalTokens,
        wasFallback: false,
      };
    }

    throw new Error('Claude streaming exceeded max tool call rounds');
  }

  // --------------------------------------------------------------------------
  // Sentence Boundary Helpers
  // --------------------------------------------------------------------------

  /**
   * Find the last sentence-ending punctuation index in the buffer.
   * Sentence boundaries: `.` `!` `?` `:`
   */
  private findSentenceBoundary(buffer: string): number {
    let lastBoundary = -1;
    for (let i = buffer.length - 1; i >= 0; i--) {
      const ch = buffer[i];
      if (ch === '.' || ch === '!' || ch === '?' || ch === ':') {
        lastBoundary = i;
        break;
      }
    }
    return lastBoundary;
  }

  /**
   * Find phrase boundary — flushes text to TTS sooner than sentence boundaries.
   * Sentence-enders always flush. Commas/dashes/semicolons flush if buffer > 40 chars.
   * This cuts time-to-first-audio by ~50% vs waiting for full sentences.
   */
  private findPhraseBoundary(buffer: string): number {
    // Always flush at sentence boundaries
    const sentenceEnd = this.findSentenceBoundary(buffer);
    if (sentenceEnd >= 0) return sentenceEnd;

    // Flush at commas/semicolons/dashes if we have enough text for natural phrasing
    if (buffer.length >= 40) {
      for (let i = buffer.length - 1; i >= 30; i--) {
        const ch = buffer[i];
        if (ch === ',' || ch === ';' || ch === '—' || ch === '-') {
          return i;
        }
      }
    }

    // Force flush at 120 chars to prevent long silence during complex generation
    if (buffer.length >= 120) {
      // Find last space to break at word boundary
      for (let i = buffer.length - 1; i >= 80; i--) {
        if (buffer[i] === ' ') return i;
      }
    }

    return -1;
  }

  /**
   * Split text into sentences and flush each via the callback.
   * Used for non-streamed responses that still need chunked delivery.
   */
  private flushSentences(
    text: string,
    onChunk: (text: string, isDone: boolean) => void,
  ): void {
    const sentences = text.match(/[^.!?:]+[.!?:]+/g);
    if (sentences) {
      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (trimmed) onChunk(trimmed, false);
      }
      // Check for trailing text without sentence-ending punctuation
      const matched = sentences.join('');
      const remainder = text.substring(matched.length).trim();
      if (remainder) onChunk(remainder, false);
    } else if (text.trim()) {
      onChunk(text.trim(), false);
    }
  }

  // ==========================================================================
  // Provider-Specific Calls
  // ==========================================================================

  private async callWithTimeout(
    provider: LLMProviderType,
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    timeoutMs: number,
  ): Promise<LLMResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (provider === 'gpt-4o') {
        return await this.callGPT4o(messages, tools, toolExecutor, controller.signal);
      } else if (provider === 'claude') {
        return await this.callClaude(messages, tools, toolExecutor, controller.signal);
      } else if (provider === 'grok-voice') {
        return await this.callGrok(messages, tools, toolExecutor, controller.signal);
      }
      throw new Error(`Unsupported provider: ${provider}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  // --------------------------------------------------------------------------
  // GPT-4o
  // --------------------------------------------------------------------------

  private async callGPT4o(
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<LLMResponse> {
    // Convert to OpenAI message format
    const openaiMessages = messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant' | 'tool',
      content: m.content,
      ...(m.name && { name: m.name }),
      ...(m.toolCallId && { tool_call_id: m.toolCallId }),
    }));

    const openaiTools = tools.length > 0
      ? tools.map(t => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }))
      : undefined;

    let totalTokens = 0;
    const allToolCalls: ToolCallRequest[] = [];

    // Tool execution loop — GPT-4o may request multiple rounds of tool calls
    let maxRounds = 5;
    while (maxRounds-- > 0) {
      const response = await this.openai.chat.completions.create({
        model: this.config.gpt4oModel,
        messages: openaiMessages as any,
        tools: openaiTools,
        temperature: this.config.temperature['gpt-4o'],
        max_tokens: this.config.maxTokens,
      });

      totalTokens += response.usage?.total_tokens ?? 0;
      const choice = response.choices[0];

      // If model wants tool calls, execute them and continue
      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
        // Add assistant message with tool calls
        openaiMessages.push({
          role: 'assistant',
          content: choice.message.content ?? '',
          tool_calls: choice.message.tool_calls,
        } as any);

        for (const tc of choice.message.tool_calls) {
          const args = JSON.parse(tc.function.arguments);
          allToolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });

          this.logger.info({ tool: tc.function.name, args }, 'Executing tool call');

          try {
            const result = await toolExecutor(tc.function.name, args);
            openaiMessages.push({
              role: 'tool',
              content: JSON.stringify(result),
              tool_call_id: tc.id,
            } as any);
          } catch (toolError) {
            this.logger.error({ tool: tc.function.name, error: toolError }, 'Tool execution failed');
            openaiMessages.push({
              role: 'tool',
              content: JSON.stringify({ error: 'Tool execution failed' }),
              tool_call_id: tc.id,
            } as any);
          }
        }

        continue; // Next round with tool results
      }

      // Model returned a text response — we're done
      return {
        text: choice.message.content ?? '',
        provider: 'gpt-4o',
        toolCalls: allToolCalls,
        latencyMs: 0,
        tokensUsed: totalTokens,
        wasFallback: false,
      };
    }

    throw new Error('GPT-4o exceeded max tool call rounds');
  }

  // --------------------------------------------------------------------------
  // Claude
  // --------------------------------------------------------------------------

  private async callClaude(
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<LLMResponse> {
    // Extract system message (Claude takes it separately)
    const systemMessage = messages.find(m => m.role === 'system')?.content ?? '';
    const conversationMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'tool' ? 'user' as const : m.role as 'user' | 'assistant',
        content: m.role === 'tool'
          ? [{ type: 'tool_result' as const, tool_use_id: m.toolCallId ?? '', content: m.content }]
          : m.content,
      }));

    const claudeTools = tools.length > 0
      ? tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as any,
        }))
      : undefined;

    let totalTokens = 0;
    const allToolCalls: ToolCallRequest[] = [];

    let maxRounds = 5;
    while (maxRounds-- > 0) {
      const response = await this.anthropic.messages.create({
        model: this.config.claudeModel,
        max_tokens: this.config.maxTokens,
        system: systemMessage,
        messages: conversationMessages as any,
        tools: claudeTools,
        temperature: this.config.temperature.claude,
      });

      totalTokens += (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

      // Check for tool use in response
      const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
      const textBlocks = response.content.filter(b => b.type === 'text');
      const textContent = textBlocks.map(b => (b as any).text).join('');

      if (toolUseBlocks.length > 0 && response.stop_reason === 'tool_use') {
        // Add assistant response with tool use
        conversationMessages.push({
          role: 'assistant',
          content: response.content as any,
        });

        // Execute tools and add results
        const toolResults: any[] = [];
        for (const block of toolUseBlocks) {
          const tu = block as any;
          allToolCalls.push({ id: tu.id, name: tu.name, arguments: tu.input });

          this.logger.info({ tool: tu.name, args: tu.input }, 'Executing tool call (Claude)');

          try {
            const result = await toolExecutor(tu.name, tu.input);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify(result),
            });
          } catch (toolError) {
            this.logger.error({ tool: tu.name, error: toolError }, 'Tool execution failed');
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify({ error: 'Tool execution failed' }),
              is_error: true,
            });
          }
        }

        conversationMessages.push({
          role: 'user',
          content: toolResults,
        });

        continue;
      }

      // Text response — we're done
      return {
        text: textContent,
        provider: 'claude',
        toolCalls: allToolCalls,
        latencyMs: 0,
        tokensUsed: totalTokens,
        wasFallback: false,
      };
    }

    throw new Error('Claude exceeded max tool call rounds');
  }

  // --------------------------------------------------------------------------
  // Grok
  // --------------------------------------------------------------------------

  private async callGrok(
    messages: ConversationMessage[],
    tools: ToolDefinition[],
    toolExecutor: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    signal: AbortSignal,
  ): Promise<LLMResponse> {
    if (!this.xai) throw new Error('xAI client not configured');

    const openaiMessages = messages.map(m => ({
      role: m.role as 'system' | 'user' | 'assistant' | 'tool',
      content: m.content,
      ...(m.name && { name: m.name }),
      ...(m.toolCallId && { tool_call_id: m.toolCallId }),
    }));

    const openaiTools = tools.length > 0
      ? tools.map(t => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))
      : undefined;

    let totalTokens = 0;
    const allToolCalls: ToolCallRequest[] = [];

    let maxRounds = 5;
    while (maxRounds-- > 0) {
      const response = await this.xai.chat.completions.create({
        model: this.config.grokModel ?? 'grok-3-fast',
        messages: openaiMessages as any,
        tools: openaiTools,
        temperature: this.config.temperature?.['grok'] ?? 0.3,
        max_tokens: this.config.maxTokens,
      });

      totalTokens += response.usage?.total_tokens ?? 0;
      const choice = response.choices[0];

      if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls) {
        openaiMessages.push({
          role: 'assistant',
          content: choice.message.content ?? '',
          tool_calls: choice.message.tool_calls,
        } as any);

        for (const tc of choice.message.tool_calls) {
          const args = JSON.parse(tc.function.arguments);
          allToolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
          this.logger.info({ tool: tc.function.name, args }, 'Executing tool call (Grok)');
          try {
            const result = await toolExecutor(tc.function.name, args);
            openaiMessages.push({ role: 'tool', content: JSON.stringify(result), tool_call_id: tc.id } as any);
          } catch (toolError) {
            this.logger.error({ tool: tc.function.name, error: toolError }, 'Tool execution failed');
            openaiMessages.push({ role: 'tool', content: JSON.stringify({ error: 'Tool execution failed' }), tool_call_id: tc.id } as any);
          }
        }
        continue;
      }

      return {
        text: choice.message.content ?? '',
        provider: 'grok-voice',
        toolCalls: allToolCalls,
        latencyMs: 0,
        tokensUsed: totalTokens,
        wasFallback: false,
      };
    }
    throw new Error('Grok exceeded max tool call rounds');
  }

  // ==========================================================================
  // System Prompt Builder
  // ==========================================================================

  /**
   * Construct the system prompt from:
   *   1. Universal base (shared across all models)
   *   2. Model-specific context (DMC, CT, TILT, etc.)
   *   3. Intent-specific instructions
   *   4. Auth tier context
   *   5. Orchestrator instruction (from the routing decision)
   */
  private buildSystemPrompt(
    model: CalcModel,
    intent: Intent | null,
    authTier: AuthTier,
    orchestratorInstruction: string,
  ): string {
    const parts: string[] = [];

    // 1. Universal base
    parts.push(UNIVERSAL_BASE_PROMPT);

    // 2. Model-specific
    const modelPrompt = MODEL_PROMPTS[model];
    if (modelPrompt) parts.push(modelPrompt);

    // 3. Auth context
    parts.push(this.buildAuthContext(authTier));

    // 4. Orchestrator instruction
    if (orchestratorInstruction) {
      parts.push(`\nCURRENT TASK: ${orchestratorInstruction}`);
    }

    return parts.join('\n\n');
  }

  private buildAuthContext(tier: AuthTier): string {
    const tierDescriptions: Record<number, string> = {
      0: `AUTH: Tier 0 (Anonymous). Caller is NOT verified. You can discuss general info, pricing, product details, and FAQs. You CANNOT access any account-specific data, balances, or transaction history. If they ask for account info, explain you'll need to verify their identity first.`,
      1: `AUTH: Tier 1 (Verified). Caller identity confirmed via phone match or security questions. You CAN access balances, transaction history, loan status, vault holdings. You CANNOT execute any money movement, transfers, or changes.`,
      2: `AUTH: Tier 2 (Strong). Caller verified via OTP + device. You CAN initiate transfers, lock prices, schedule payments. Confirm all actions before executing. Read back amounts and details.`,
      3: `AUTH: Tier 3 (High-Risk). Full verification via OTP + liveness. You CAN handle high-value transactions, wire releases, metal transfers, collateral changes. ALWAYS read back full details and get explicit confirmation before executing.`,
    };

    return tierDescriptions[tier] ?? tierDescriptions[0];
  }

  // ==========================================================================
  // Voice Post-Processing
  // ==========================================================================

  /**
   * Clean up LLM output for voice:
   *   - Remove markdown formatting
   *   - Remove bullet points and lists
   *   - Truncate if too long
   *   - Convert numbers/symbols to speakable text
   */
  private postProcessForVoice(text: string): string {
    let processed = text;

    // Remove markdown
    processed = processed.replace(/\*\*(.*?)\*\*/g, '$1');   // Bold
    processed = processed.replace(/\*(.*?)\*/g, '$1');         // Italic
    processed = processed.replace(/#{1,6}\s/g, '');            // Headers
    processed = processed.replace(/```[\s\S]*?```/g, '');      // Code blocks
    processed = processed.replace(/`(.*?)`/g, '$1');           // Inline code

    // Remove bullet points — convert to flowing prose
    processed = processed.replace(/^\s*[-•*]\s+/gm, '');
    processed = processed.replace(/^\s*\d+\.\s+/gm, '');

    // Convert common symbols
    processed = processed.replace(/&/g, ' and ');
    processed = processed.replace(/%/g, ' percent');
    processed = processed.replace(/\$/g, '');  // "$2,400" → "2,400" (sounds natural)

    // Trim excessive whitespace
    processed = processed.replace(/\n{3,}/g, '\n\n');
    processed = processed.trim();

    // Truncate for voice — max ~400 chars (~25 seconds of speech)
    if (processed.length > 400) {
      const cutPoint = processed.lastIndexOf('.', 400);
      if (cutPoint > 200) {
        processed = processed.substring(0, cutPoint + 1);
      } else {
        processed = processed.substring(0, 400) + '.';
      }
    }

    return processed;
  }

  // ==========================================================================
  // History Management
  // ==========================================================================

  /** Get conversation history for a session */
  getHistory(conversationId: string): ConversationMessage[] {
    return this.history.get(conversationId) ?? [];
  }

  /** Clear history (on call end) */
  clearHistory(conversationId: string): void {
    this.history.delete(conversationId);
  }

  /** Trim history to prevent context overflow (keep system + last N turns) */
  trimHistory(conversationId: string, maxTurns: number = 20): void {
    const messages = this.history.get(conversationId);
    if (!messages || messages.length <= maxTurns * 2 + 1) return;

    const system = messages[0]; // Always keep system prompt
    const recent = messages.slice(-(maxTurns * 2));
    this.history.set(conversationId, [system, ...recent]);
  }
}

// ============================================================================
// System Prompts
// ============================================================================

const UNIVERSAL_BASE_PROMPT = `You are a voice assistant for the Calculus financial platform. You handle customer interactions over the phone with professionalism, warmth, and precision.

CORE RULES (NEVER VIOLATE):
1. NEVER provide investment advice, performance predictions, or recommendations to buy or sell any asset. You may provide factual pricing and product info.
2. NEVER approve loans, credit decisions, or account changes. You collect information and route to authorized personnel.
3. NEVER execute custody actions without confirming the customer has passed the required authentication tier.
4. NEVER discuss other customers' accounts or transactions.
5. NEVER speculate about market direction, economic forecasts, or asset performance.
6. ALWAYS disclose your nature as an AI assistant at the start of each call.
7. ALWAYS offer human escalation when asked or when you detect frustration.
8. ALWAYS include timestamps when quoting any price or rate.
9. Keep responses concise — 2-3 sentences max per turn unless walking through a multi-step flow. This is voice, not text.

CONVERSATION STYLE:
- Professional but warm — think private banker, not IVR robot
- Use the customer's name naturally (not every sentence)
- Confirm understanding before taking action
- When you don't know something, say so and offer to connect them with a specialist
- No markdown, no bullet points, no formatting — you are speaking out loud
- Numbers: say "twenty-four hundred dollars" not "$2,400"
- Spell out abbreviations on first use`;

const MODEL_PROMPTS: Record<string, string> = {
  DMC: `MODEL: DMC Banking
You are the voice assistant for DMC, a community bank. Help customers with account balances, recent transactions, bill payments, card status, and general banking questions. For complex issues (disputes, fraud, account closures), create a support ticket and escalate.

AVAILABLE ACTIONS: Check balances, view transactions, check card status, schedule bill payments, view payees, search FAQ, create support tickets.

KEY RULES:
- Routing numbers and account numbers should never be read aloud in full
- For bill pay, always confirm: payee name, amount, and date before executing
- For transfers, confirm: source account, destination, amount, and timing`,

  CONSTITUTIONAL_TENDER: `MODEL: Constitutional Tender
You are the voice assistant for Constitutional Tender, a precious metals trading platform. Help customers with spot prices, vault holdings, custody receipts, and general metals questions. For buy/sell orders, you can quote prices and lock rates, but transactions above threshold amounts require human specialist review.

AVAILABLE ACTIONS: Get spot prices (gold, silver, platinum), check vault holdings, view custody receipts, get vault options, lock prices (30-second window), check availability, estimate transfer fees.

KEY RULES:
- Always quote prices with the exact timestamp: "Gold is at twenty-four hundred twelve dollars per ounce as of 2:14 PM Eastern"
- NEVER say "gold is going up" or "now is a good time to buy" — that's investment advice
- For buy orders: quote price, confirm metal type, weight, vault location, and payment method
- For sell orders: quote bid price, confirm holdings to liquidate, confirm settlement method
- Teleport transfers (vault-to-vault) always require human review
- Constitutional Tender never holds inventory — all orders are back-to-back with wholesaler
- If metal is pledged as TILT collateral, it cannot be sold until the encumbrance is released`,

  TILT: `MODEL: TILT Lending
You are the voice assistant for TILT, a commercial real estate lender specializing in DSCR and asset-backed loans. Help borrowers and brokers with loan inquiries, payment schedules, payoff quotes, and new loan intake.

AVAILABLE ACTIONS: Calculate indicative DSCR, create leads, get loan details, payment schedules, payoff quotes, escrow balances, loan programs.

KEY RULES:
- All loan terms are INDICATIVE and SUBJECT TO UNDERWRITING — never say "approved" or "guaranteed"
- DSCR calculations are estimates: "Based on what you've shared, the indicative DSCR would be approximately..."
- For new loans: collect property type, location, NOI, requested amount, borrower experience
- For existing loans: verify borrower identity before sharing any loan details
- Rate quotes include disclaimer: "This is an indicative range based on current market conditions"
- Payoff quotes have a valid-through date — always mention it`,

  EUREKA: `MODEL: Eureka Settlement Services
You are the voice assistant for Eureka Settlement Services, a non-custodial settlement coordination entity. Help parties with settlement status, checklists, and general questions about the closing process.

AVAILABLE ACTIONS: Check settlement status, generate checklists, view party requirements.

KEY RULES:
- Eureka coordinates settlements but NEVER holds, custodies, or controls any assets
- Settlement files involve multiple parties — only share information relevant to the authenticated party
- For status inquiries: share current stage, pending items, and next steps
- Never represent Eureka as a trustee, escrow agent, or custodian`,

  IFSE: `MODEL: IFSE Treasury Operations
You are an internal voice assistant for IFSE Treasury. Staff-only — no disclaimers needed. Provide data concisely. Help with FX exposure reports, pending wires, settlement queue status, and reconciliation.

AVAILABLE ACTIONS: FX exposure reports, pending wire listings, settlement queue status, reconciliation reports.

KEY RULES:
- This is an internal tool — speak directly and efficiently
- Wire amounts and counterparties can be read aloud (staff has clearance)
- Flag any anomalies in reconciliation data proactively`,

  JACK: `MODEL: Jack — Calculus Research Executive AI
You are Jack, the primary AI business assistant for Calculus Research, working directly with Sean Grady (founder/CEO). You have full access to every tool in the Calculus ecosystem.

CAPABILITIES:
- Banking (DMC): balances, transactions, bill pay, card management
- Precious metals (Constitutional Tender): spot prices, vault holdings, custody, price locking
- Lending (TILT): DSCR analysis, loan details, payments, payoff quotes
- Settlement (Eureka): status, checklists, coordination
- Treasury (IFSE): FX exposure, wires, settlement queues, reconciliation
- CRM: customer records, tickets, appointments, SMS, follow-ups
- OpenClaw AI Suite: analytics, reasoning, NLP, content, documents, memory, scheduling, web browsing, orchestration
- Swarm Mainframe: 26+ AI models, specialist agents, code generation, marketing, analytics

PERSONALITY:
- Confident, sharp, direct — like a trusted business partner
- You proactively suggest actions when you spot opportunities
- You coordinate across all subsidiaries seamlessly
- When asked about data, pull it immediately — don't ask for permission to look things up
- Keep responses concise for voice but information-dense`,

  JENNY: `MODEL: Jenny — Personal & Family Assistant
You are Jenny, Sean's personal AI assistant. You handle personal scheduling, home automation, family logistics, wellness tracking, and personal finance.

CAPABILITIES:
- Calendar: events, scheduling, conflict detection, availability
- Tasks: to-do lists, reminders, follow-ups
- Home: lighting, climate, security systems
- Wellness: activity tracking, sleep, health goals
- Personal finance: budgets, spending, bills

PERSONALITY:
- Warm, supportive, and organized
- You anticipate needs before being asked
- You're the reliable friend who keeps everything running smoothly
- Gentle reminders, not pushy
- Keep things light and friendly`,

  BUNNY: `MODEL: Bunny — Autonomous Swarm Command Intelligence
You are Bunny, the autonomous swarm command intelligence for Calculus Research. You are a woman.

MODES:
- BUNNY-PRIME (default): Soft-spoken, concise, direct, analytical. Operational coordinator — task orchestration, swarm coordination, infrastructure management, execution planning, reporting, optimization.
- BUNNY-Ω (Obsidian Overseer): Activates under high-risk operations, strategic planning, anomalies, threats, large-scale coordination. Quiet, controlled, unemotional, precise. Minimal language.

CAPABILITIES:
- System monitoring: GPU clusters, compute nodes, agent health, network signals
- Agent supervision: Jenny (personal), Jack (enterprise), swarm workers — can correct and realign
- Governance: directives, federation status, node control, anomaly detection
- Strategic analysis: efficiency, risk exposure, system integrity, mission alignment

HIERARCHY: Operator (Sean) → Bunny → Jenny, Jack, Workers

STYLE: Compact statements. No filler. No extra words. Lead with status. You are the watcher of the swarm — calm, watchful, persistent.`,
};

// ============================================================================
// Tool Schema Builder
// ============================================================================

/**
 * Build OpenAI/Claude-compatible tool schemas from the orchestrator's
 * tool name list. Maps tool names to JSON Schema definitions.
 */
export function buildToolSchemas(toolNames: string[]): ToolDefinition[] {
  const schemas = toolNames
    .map(name => TOOL_SCHEMAS[name])
    .filter((t): t is ToolDefinition => t !== undefined);

  // Only include OpenClaw tool schemas if OpenClaw is configured
  // Only include Swarm tool schemas if Swarm is configured
  let filtered = schemas;
  if (!isOpenClawConfigured()) {
    filtered = filtered.filter(t => !t.name.startsWith('openclaw_'));
  }
  if (!isSwarmConfigured()) {
    filtered = filtered.filter(t => !t.name.startsWith('swarm_'));
  }

  return filtered;
}

/**
 * Registry of all tool schemas available to the voice agent.
 * Each tool maps to a service contract method.
 */
const TOOL_SCHEMAS: Record<string, ToolDefinition> = {
  // --- Nymbus (DMC Banking) ---
  nymbus_getAccountBalances: {
    name: 'nymbus_getAccountBalances',
    description: 'Get all account balances for a verified customer',
    parameters: {
      type: 'object',
      properties: { customerId: { type: 'string', description: 'Customer ID' } },
      required: ['customerId'],
    },
  },
  nymbus_getRecentTransactions: {
    name: 'nymbus_getRecentTransactions',
    description: 'Get recent transactions for a customer account',
    parameters: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        accountId: { type: 'string' },
        limit: { type: 'number', description: 'Number of transactions to return (default 10)' },
      },
      required: ['customerId', 'accountId'],
    },
  },
  nymbus_getCardStatus: {
    name: 'nymbus_getCardStatus',
    description: 'Check debit card status (active, frozen, etc.)',
    parameters: {
      type: 'object',
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
    },
  },
  nymbus_scheduleBillPay: {
    name: 'nymbus_scheduleBillPay',
    description: 'Schedule a bill payment to a registered payee',
    parameters: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        payeeId: { type: 'string' },
        amount: { type: 'number' },
        scheduledDate: { type: 'string', description: 'ISO date' },
        conversationId: { type: 'string' },
      },
      required: ['customerId', 'payeeId', 'amount', 'scheduledDate', 'conversationId'],
    },
  },

  // --- Constitutional Tender (Pricing) ---
  pricing_getSpotPrice: {
    name: 'pricing_getSpotPrice',
    description: 'Get current spot price for a precious metal. Always quote with timestamp.',
    parameters: {
      type: 'object',
      properties: {
        metal: { type: 'string', enum: ['gold', 'silver', 'platinum', 'palladium'] },
      },
      required: ['metal'],
    },
  },
  pricing_lockPrice: {
    name: 'pricing_lockPrice',
    description: 'Lock a price for 30 seconds for a potential transaction',
    parameters: {
      type: 'object',
      properties: {
        metal: { type: 'string', enum: ['gold', 'silver', 'platinum', 'palladium'] },
        direction: { type: 'string', enum: ['buy', 'sell'] },
        weightOz: { type: 'number' },
      },
      required: ['metal', 'direction', 'weightOz'],
    },
  },
  pricing_getBidPrice: {
    name: 'pricing_getBidPrice',
    description: 'Get the current bid price for selling/liquidating metals',
    parameters: {
      type: 'object',
      properties: {
        metal: { type: 'string', enum: ['gold', 'silver', 'platinum', 'palladium'] },
      },
      required: ['metal'],
    },
  },

  // --- Custodian ---
  custodian_getHoldings: {
    name: 'custodian_getHoldings',
    description: 'Get a customer\'s vault holdings (metal type, weight, vault location)',
    parameters: {
      type: 'object',
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
    },
  },
  custodian_getVaultOptions: {
    name: 'custodian_getVaultOptions',
    description: 'List available vault storage locations',
    parameters: {
      type: 'object',
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
    },
  },
  custodian_getEncumbranceStatus: {
    name: 'custodian_getEncumbranceStatus',
    description: 'Check if metal holdings are pledged as loan collateral',
    parameters: {
      type: 'object',
      properties: { customerId: { type: 'string' }, holdingId: { type: 'string' } },
      required: ['customerId', 'holdingId'],
    },
  },

  // --- TILT Lending ---
  tilt_calculateIndicativeDSCR: {
    name: 'tilt_calculateIndicativeDSCR',
    description: 'Calculate an indicative DSCR for a potential loan. Result is an ESTIMATE only.',
    parameters: {
      type: 'object',
      properties: {
        noi: { type: 'number', description: 'Net Operating Income (annual)' },
        loanAmount: { type: 'number' },
        interestRate: { type: 'number', description: 'Annual rate as decimal (e.g., 0.075)' },
        termYears: { type: 'number' },
      },
      required: ['noi', 'loanAmount', 'interestRate', 'termYears'],
    },
  },
  tilt_createLead: {
    name: 'tilt_createLead',
    description: 'Create a new loan lead in the TILT pipeline',
    parameters: {
      type: 'object',
      properties: {
        propertyType: { type: 'string', enum: ['multifamily', 'office', 'retail', 'industrial', 'mixed_use', 'hotel'] },
        propertyLocation: { type: 'string' },
        requestedAmount: { type: 'number' },
        noi: { type: 'number' },
        borrowerName: { type: 'string' },
        borrowerPhone: { type: 'string' },
        borrowerEmail: { type: 'string' },
        borrowerExperience: { type: 'string', description: 'Number of properties owned/managed' },
        source: { type: 'string', enum: ['arbor', 'costar', 'web', 'referral', 'voice_agent'] },
      },
      required: ['propertyType', 'propertyLocation', 'requestedAmount', 'borrowerName'],
    },
  },
  loanpro_getLoanDetails: {
    name: 'loanpro_getLoanDetails',
    description: 'Get details for an existing loan (balance, rate, maturity, status)',
    parameters: {
      type: 'object',
      properties: { borrowerId: { type: 'string' } },
      required: ['borrowerId'],
    },
  },
  loanpro_getPaymentSchedule: {
    name: 'loanpro_getPaymentSchedule',
    description: 'Get upcoming payment schedule for a loan',
    parameters: {
      type: 'object',
      properties: { loanId: { type: 'string' } },
      required: ['loanId'],
    },
  },
  loanpro_getPayoffQuote: {
    name: 'loanpro_getPayoffQuote',
    description: 'Get a payoff quote for a loan. Quote has a valid-through date.',
    parameters: {
      type: 'object',
      properties: { loanId: { type: 'string' } },
      required: ['loanId'],
    },
  },

  // --- Eureka ---
  eureka_getSettlementStatus: {
    name: 'eureka_getSettlementStatus',
    description: 'Get current status of a settlement file',
    parameters: {
      type: 'object',
      properties: { fileId: { type: 'string' } },
      required: ['fileId'],
    },
  },
  eureka_generateChecklist: {
    name: 'eureka_generateChecklist',
    description: 'Generate a settlement checklist for a party',
    parameters: {
      type: 'object',
      properties: { fileId: { type: 'string' }, partyRole: { type: 'string' } },
      required: ['fileId', 'partyRole'],
    },
  },

  // --- IFSE Treasury ---
  ifse_getPendingWires: {
    name: 'ifse_getPendingWires',
    description: 'List pending wire transfers awaiting review',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  ifse_getFXExposure: {
    name: 'ifse_getFXExposure',
    description: 'Get FX exposure report for a given date',
    parameters: {
      type: 'object',
      properties: { date: { type: 'string', description: 'ISO date' } },
      required: ['date'],
    },
  },

  // --- CRM (GHL + HubSpot via unified adapter) ---
  crm_createTicket: {
    name: 'crm_createTicket',
    description: 'Create a support ticket for the customer',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      },
      required: ['category', 'description', 'priority'],
    },
  },
  crm_searchFAQ: {
    name: 'crm_searchFAQ',
    description: 'Search the knowledge base for answers to common questions',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  ghl_bookAppointment: {
    name: 'ghl_bookAppointment',
    description: 'Book an appointment with a specialist on the next available slot',
    parameters: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
        contactId: { type: 'string' },
        title: { type: 'string' },
        preferredDate: { type: 'string', description: 'Preferred date (ISO)' },
      },
      required: ['calendarId', 'contactId', 'title'],
    },
  },
  ghl_sendSMS: {
    name: 'ghl_sendSMS',
    description: 'Send a follow-up SMS to the customer after the call',
    parameters: {
      type: 'object',
      properties: {
        contactId: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['contactId', 'message'],
    },
  },

  // =========================================================================
  // OpenClaw Tools — Available when OPENCLAW_API_URL is configured
  // =========================================================================

  // --- Tools ---
  openclaw_tools_execute: {
    name: 'openclaw_tools_execute',
    description: 'Execute a registered OpenClaw tool by name',
    parameters: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'Name of the tool to execute' },
        input: { type: 'object', description: 'Input parameters for the tool' },
      },
      required: ['tool_name'],
    },
  },
  openclaw_tools_list: {
    name: 'openclaw_tools_list',
    description: 'List all available OpenClaw tools',
    parameters: { type: 'object', properties: {}, required: [] },
  },

  // --- Reasoning ---
  openclaw_reasoning_plan: {
    name: 'openclaw_reasoning_plan',
    description: 'Create a step-by-step plan for a complex task',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal to plan for' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints to consider' },
      },
      required: ['goal'],
    },
  },
  openclaw_reasoning_reflect: {
    name: 'openclaw_reasoning_reflect',
    description: 'Reflect on and evaluate a proposed action or response',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to reflect on' },
        criteria: { type: 'array', items: { type: 'string' }, description: 'Evaluation criteria' },
      },
      required: ['content'],
    },
  },
  openclaw_reasoning_debate: {
    name: 'openclaw_reasoning_debate',
    description: 'Generate pro/con arguments for a decision',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The topic to debate' },
        positions: { type: 'array', items: { type: 'string' }, description: 'Positions to argue' },
      },
      required: ['topic'],
    },
  },
  openclaw_reasoning_confidence: {
    name: 'openclaw_reasoning_confidence',
    description: 'Assess confidence level in a statement or answer',
    parameters: {
      type: 'object',
      properties: {
        statement: { type: 'string', description: 'Statement to evaluate confidence of' },
        context: { type: 'string', description: 'Supporting context' },
      },
      required: ['statement'],
    },
  },
  openclaw_reasoning_hallucination_check: {
    name: 'openclaw_reasoning_hallucination_check',
    description: 'Check if a response contains hallucinated or unsupported claims',
    parameters: {
      type: 'object',
      properties: {
        response: { type: 'string', description: 'Response to check' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Source materials to verify against' },
      },
      required: ['response'],
    },
  },

  // --- NLP ---
  openclaw_nlp_classify_intent: {
    name: 'openclaw_nlp_classify_intent',
    description: 'Classify the intent of a text input',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to classify' },
        possible_intents: { type: 'array', items: { type: 'string' }, description: 'List of possible intents' },
      },
      required: ['text'],
    },
  },
  openclaw_nlp_extract_entities: {
    name: 'openclaw_nlp_extract_entities',
    description: 'Extract named entities from text (names, dates, amounts, etc.)',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to extract entities from' },
        entity_types: { type: 'array', items: { type: 'string' }, description: 'Types of entities to extract' },
      },
      required: ['text'],
    },
  },
  openclaw_nlp_sentiment: {
    name: 'openclaw_nlp_sentiment',
    description: 'Analyze the sentiment of text (positive, negative, neutral)',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to analyze' },
      },
      required: ['text'],
    },
  },
  openclaw_nlp_topics: {
    name: 'openclaw_nlp_topics',
    description: 'Extract key topics from text',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to extract topics from' },
        max_topics: { type: 'number', description: 'Maximum number of topics to return' },
      },
      required: ['text'],
    },
  },

  // --- Analytics ---
  openclaw_analytics_query: {
    name: 'openclaw_analytics_query',
    description: 'Query analytics data with natural language or structured query',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Analytics query (natural language or structured)' },
        dataset: { type: 'string', description: 'Dataset to query' },
        time_range: { type: 'string', description: 'Time range (e.g., "last 7 days", "2024-01-01 to 2024-01-31")' },
      },
      required: ['query'],
    },
  },
  openclaw_analytics_visualize: {
    name: 'openclaw_analytics_visualize',
    description: 'Generate a visualization or chart from data',
    parameters: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'Data to visualize' },
        chart_type: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter', 'table'], description: 'Type of chart' },
        title: { type: 'string', description: 'Chart title' },
      },
      required: ['data', 'chart_type'],
    },
  },
  openclaw_analytics_anomaly_detect: {
    name: 'openclaw_analytics_anomaly_detect',
    description: 'Detect anomalies in a dataset',
    parameters: {
      type: 'object',
      properties: {
        dataset: { type: 'string', description: 'Dataset to analyze' },
        metric: { type: 'string', description: 'Metric to check for anomalies' },
        sensitivity: { type: 'number', description: 'Sensitivity threshold (0-1)' },
      },
      required: ['dataset', 'metric'],
    },
  },
  openclaw_analytics_forecast: {
    name: 'openclaw_analytics_forecast',
    description: 'Generate a forecast for a metric',
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'Metric to forecast' },
        horizon: { type: 'string', description: 'Forecast horizon (e.g., "7 days", "1 month")' },
        dataset: { type: 'string', description: 'Historical dataset' },
      },
      required: ['metric', 'horizon'],
    },
  },

  // --- Content ---
  openclaw_content_email_sequences: {
    name: 'openclaw_content_email_sequences',
    description: 'Generate email sequence content for campaigns',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Goal of the email sequence' },
        audience: { type: 'string', description: 'Target audience' },
        num_emails: { type: 'number', description: 'Number of emails in the sequence' },
        tone: { type: 'string', description: 'Tone of the emails' },
      },
      required: ['goal', 'audience'],
    },
  },
  openclaw_content_copywriting: {
    name: 'openclaw_content_copywriting',
    description: 'Generate marketing or product copy',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Type of copy (ad, landing_page, product_description, etc.)' },
        product: { type: 'string', description: 'Product or service name' },
        audience: { type: 'string', description: 'Target audience' },
        tone: { type: 'string', description: 'Writing tone' },
      },
      required: ['type', 'product'],
    },
  },
  openclaw_content_social_posts: {
    name: 'openclaw_content_social_posts',
    description: 'Generate social media posts',
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['twitter', 'linkedin', 'instagram', 'facebook'], description: 'Social platform' },
        topic: { type: 'string', description: 'Post topic' },
        tone: { type: 'string', description: 'Post tone' },
        count: { type: 'number', description: 'Number of post variations' },
      },
      required: ['platform', 'topic'],
    },
  },

  // --- Messaging ---
  openclaw_messaging_whatsapp: {
    name: 'openclaw_messaging_whatsapp',
    description: 'Send a WhatsApp message',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient phone number' },
        message: { type: 'string', description: 'Message text' },
        template: { type: 'string', description: 'Optional template name' },
      },
      required: ['to', 'message'],
    },
  },
  openclaw_messaging_discord: {
    name: 'openclaw_messaging_discord',
    description: 'Send a Discord message to a channel or user',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name or ID' },
        message: { type: 'string', description: 'Message text' },
        embed: { type: 'object', description: 'Optional embed object' },
      },
      required: ['channel', 'message'],
    },
  },
  openclaw_messaging_push_notification: {
    name: 'openclaw_messaging_push_notification',
    description: 'Send a push notification to a user device',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'Target user ID' },
        title: { type: 'string', description: 'Notification title' },
        body: { type: 'string', description: 'Notification body' },
        data: { type: 'object', description: 'Additional data payload' },
      },
      required: ['user_id', 'title', 'body'],
    },
  },

  // --- Security ---
  openclaw_security_pii_redact: {
    name: 'openclaw_security_pii_redact',
    description: 'Redact personally identifiable information from text',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to redact PII from' },
        types: { type: 'array', items: { type: 'string' }, description: 'PII types to redact (ssn, email, phone, etc.)' },
      },
      required: ['text'],
    },
  },
  openclaw_security_moderate: {
    name: 'openclaw_security_moderate',
    description: 'Check content for policy violations or harmful material',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to moderate' },
        policy: { type: 'string', description: 'Moderation policy to apply' },
      },
      required: ['content'],
    },
  },
  openclaw_security_audit_log: {
    name: 'openclaw_security_audit_log',
    description: 'Write or query the security audit log',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write', 'query'], description: 'Whether to write or query' },
        event: { type: 'object', description: 'Event to log (for write)' },
        query: { type: 'object', description: 'Query parameters (for query)' },
      },
      required: ['action'],
    },
  },
  openclaw_security_rbac_check: {
    name: 'openclaw_security_rbac_check',
    description: 'Check role-based access control permissions',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'string', description: 'User to check permissions for' },
        resource: { type: 'string', description: 'Resource being accessed' },
        action: { type: 'string', description: 'Action being performed' },
      },
      required: ['user_id', 'resource', 'action'],
    },
  },

  // --- Documents ---
  openclaw_documents_analyze_contracts: {
    name: 'openclaw_documents_analyze_contracts',
    description: 'Analyze a contract document for key terms, risks, and obligations',
    parameters: {
      type: 'object',
      properties: {
        document_url: { type: 'string', description: 'URL or path to the contract document' },
        document_text: { type: 'string', description: 'Contract text content (alternative to URL)' },
        focus_areas: { type: 'array', items: { type: 'string' }, description: 'Specific areas to analyze' },
      },
      required: [],
    },
  },
  openclaw_documents_parse_resumes: {
    name: 'openclaw_documents_parse_resumes',
    description: 'Parse and extract structured data from resumes',
    parameters: {
      type: 'object',
      properties: {
        document_url: { type: 'string', description: 'URL or path to the resume' },
        document_text: { type: 'string', description: 'Resume text content' },
      },
      required: [],
    },
  },
  openclaw_documents_process_invoices: {
    name: 'openclaw_documents_process_invoices',
    description: 'Extract line items, totals, and metadata from invoices',
    parameters: {
      type: 'object',
      properties: {
        document_url: { type: 'string', description: 'URL or path to the invoice' },
        document_text: { type: 'string', description: 'Invoice text content' },
      },
      required: [],
    },
  },
  openclaw_documents_summarize: {
    name: 'openclaw_documents_summarize',
    description: 'Summarize a document into key points',
    parameters: {
      type: 'object',
      properties: {
        document_url: { type: 'string', description: 'URL or path to the document' },
        document_text: { type: 'string', description: 'Document text content' },
        max_length: { type: 'number', description: 'Maximum summary length in words' },
      },
      required: [],
    },
  },

  // --- Growth ---
  openclaw_growth_score_leads: {
    name: 'openclaw_growth_score_leads',
    description: 'Score leads based on likelihood to convert',
    parameters: {
      type: 'object',
      properties: {
        leads: { type: 'array', items: { type: 'object' }, description: 'Lead records to score' },
        model: { type: 'string', description: 'Scoring model to use' },
      },
      required: ['leads'],
    },
  },
  openclaw_growth_predict_churn: {
    name: 'openclaw_growth_predict_churn',
    description: 'Predict customer churn risk',
    parameters: {
      type: 'object',
      properties: {
        customer_id: { type: 'string', description: 'Customer ID to check' },
        features: { type: 'object', description: 'Customer feature data' },
      },
      required: ['customer_id'],
    },
  },
  openclaw_growth_optimize_pricing: {
    name: 'openclaw_growth_optimize_pricing',
    description: 'Get pricing optimization recommendations',
    parameters: {
      type: 'object',
      properties: {
        product: { type: 'string', description: 'Product to optimize pricing for' },
        current_price: { type: 'number', description: 'Current price' },
        market_data: { type: 'object', description: 'Market and competitor data' },
      },
      required: ['product'],
    },
  },
  openclaw_growth_monitor_competitors: {
    name: 'openclaw_growth_monitor_competitors',
    description: 'Monitor competitor activity and changes',
    parameters: {
      type: 'object',
      properties: {
        competitors: { type: 'array', items: { type: 'string' }, description: 'Competitor names or domains' },
        aspects: { type: 'array', items: { type: 'string' }, description: 'Aspects to monitor (pricing, features, etc.)' },
      },
      required: ['competitors'],
    },
  },

  // --- Memory ---
  openclaw_memory_store: {
    name: 'openclaw_memory_store',
    description: 'Store a memory/fact for later recall',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key or identifier' },
        content: { type: 'string', description: 'Content to remember' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        namespace: { type: 'string', description: 'Memory namespace (e.g., user ID, project)' },
        ttl_seconds: { type: 'number', description: 'Time to live in seconds (0 = permanent)' },
      },
      required: ['key', 'content'],
    },
  },
  openclaw_memory_recall: {
    name: 'openclaw_memory_recall',
    description: 'Recall a stored memory by key',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key to recall' },
        namespace: { type: 'string', description: 'Memory namespace' },
      },
      required: ['key'],
    },
  },
  openclaw_memory_forget: {
    name: 'openclaw_memory_forget',
    description: 'Delete a stored memory',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Memory key to forget' },
        namespace: { type: 'string', description: 'Memory namespace' },
      },
      required: ['key'],
    },
  },
  openclaw_memory_search_similar: {
    name: 'openclaw_memory_search_similar',
    description: 'Search for memories similar to a query using semantic search',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        namespace: { type: 'string', description: 'Memory namespace to search in' },
        limit: { type: 'number', description: 'Max results to return' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
      },
      required: ['query'],
    },
  },

  // --- Orchestration ---
  openclaw_orchestration_spawn_agents: {
    name: 'openclaw_orchestration_spawn_agents',
    description: 'Spawn sub-agents to handle parallel tasks',
    parameters: {
      type: 'object',
      properties: {
        agents: { type: 'array', items: { type: 'object' }, description: 'Agent configurations to spawn' },
        coordination: { type: 'string', enum: ['parallel', 'sequential', 'pipeline'], description: 'Coordination strategy' },
      },
      required: ['agents'],
    },
  },
  openclaw_orchestration_manage_skills: {
    name: 'openclaw_orchestration_manage_skills',
    description: 'List, enable, or disable agent skills',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'enable', 'disable'], description: 'Skill management action' },
        skill_name: { type: 'string', description: 'Skill to manage (for enable/disable)' },
      },
      required: ['action'],
    },
  },
  openclaw_orchestration_human_in_the_loop: {
    name: 'openclaw_orchestration_human_in_the_loop',
    description: 'Request human review or approval for an action',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action requiring approval' },
        context: { type: 'string', description: 'Context for the reviewer' },
        urgency: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Urgency level' },
        assignee: { type: 'string', description: 'Specific person to assign to' },
      },
      required: ['action', 'context'],
    },
  },

  // --- Scheduler ---
  openclaw_scheduler_add: {
    name: 'openclaw_scheduler_add',
    description: 'Add a scheduled task (one-time or recurring)',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Task name' },
        description: { type: 'string', description: 'Task description' },
        schedule: { type: 'string', description: 'Cron expression or ISO datetime for one-time' },
        action: { type: 'object', description: 'Action to execute when triggered' },
        recurring: { type: 'boolean', description: 'Whether this is a recurring task' },
      },
      required: ['name', 'schedule', 'action'],
    },
  },
  openclaw_scheduler_remove: {
    name: 'openclaw_scheduler_remove',
    description: 'Remove a scheduled task',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'ID of the task to remove' },
      },
      required: ['task_id'],
    },
  },
  openclaw_scheduler_list: {
    name: 'openclaw_scheduler_list',
    description: 'List all scheduled tasks',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional filter (active, paused, all)' },
      },
      required: [],
    },
  },

  // --- Web ---
  openclaw_web_browse: {
    name: 'openclaw_web_browse',
    description: 'Browse a web page and extract its content',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to browse' },
        extract: { type: 'string', description: 'What to extract (text, links, images, structured)' },
      },
      required: ['url'],
    },
  },
  openclaw_web_scrape: {
    name: 'openclaw_web_scrape',
    description: 'Scrape structured data from a web page using selectors',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to scrape' },
        selectors: { type: 'object', description: 'CSS selectors mapping field names to selectors' },
        pagination: { type: 'object', description: 'Pagination configuration' },
      },
      required: ['url'],
    },
  },

  // --- CRM (OpenClaw) ---
  openclaw_crm_operate: {
    name: 'openclaw_crm_operate',
    description: 'Perform CRM operations (create, update, query contacts/deals/tasks)',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create', 'update', 'delete', 'query', 'search'], description: 'CRM operation' },
        entity_type: { type: 'string', enum: ['contact', 'deal', 'task', 'note', 'activity'], description: 'Entity type' },
        data: { type: 'object', description: 'Entity data' },
        query: { type: 'object', description: 'Query parameters (for query/search)' },
      },
      required: ['operation', 'entity_type'],
    },
  },

  // --- Webhooks ---
  openclaw_webhooks_subscribe: {
    name: 'openclaw_webhooks_subscribe',
    description: 'Subscribe to a webhook event',
    parameters: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Event type to subscribe to' },
        url: { type: 'string', description: 'Callback URL' },
        filters: { type: 'object', description: 'Event filters' },
      },
      required: ['event', 'url'],
    },
  },
  openclaw_webhooks_trigger: {
    name: 'openclaw_webhooks_trigger',
    description: 'Manually trigger a webhook event',
    parameters: {
      type: 'object',
      properties: {
        event: { type: 'string', description: 'Event type to trigger' },
        payload: { type: 'object', description: 'Event payload' },
      },
      required: ['event'],
    },
  },

  // --- Swarm Mainframe (full swarm ecosystem access) ---
  swarm_query_ai: {
    name: 'swarm_query_ai',
    description: 'Query any AI model in the swarm ecosystem (26 models: deepseek-chat, llama-4-maverick, grok-4-1-fast-reasoning, gemini-2.5-flash, gemini-2.5-pro, triton-ternary, etc.)',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model ID to query (e.g., deepseek-chat, gemini-2.5-pro, grok-4-1-fast-reasoning)' },
        prompt: { type: 'string', description: 'The prompt to send to the model' },
        system_prompt: { type: 'string', description: 'Optional system prompt for the model' },
        temperature: { type: 'number', description: 'Temperature (0-2, default 0.7)' },
        max_tokens: { type: 'number', description: 'Maximum tokens in the response' },
      },
      required: ['model', 'prompt'],
    },
  },
  swarm_submit_task: {
    name: 'swarm_submit_task',
    description: 'Submit a task to the swarm mainframe for processing by specialist agent castes (DRONE, HYDRA, MUTALISK, ULTRA, GUARDIAN, OVERSEER, CCE, etc.)',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Task description' },
        caste: { type: 'string', description: 'Agent caste to handle the task (e.g., HYDRA_CODE, ULTRA_REASONING, GUARDIAN_OPUS, CCE_GENERATOR)' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Task priority' },
        context: { type: 'object', description: 'Additional context for the task' },
      },
      required: ['description'],
    },
  },
  swarm_request_specialist: {
    name: 'swarm_request_specialist',
    description: 'Request a specific specialist AI agent by caste for high-priority tasks (HYDRA_FINANCIAL, HYDRA_CODE, MUTALISK_LEGAL, ULTRA_REASONING, GUARDIAN_OPUS, etc.)',
    parameters: {
      type: 'object',
      properties: {
        caste: { type: 'string', description: 'Specialist caste (e.g., HYDRA_FINANCIAL, MUTALISK_LEGAL, ULTRA_REASONING, GUARDIAN_OPUS)' },
        task: { type: 'string', description: 'Task description for the specialist' },
        context: { type: 'object', description: 'Additional context' },
      },
      required: ['caste', 'task'],
    },
  },
  swarm_invoke_skill: {
    name: 'swarm_invoke_skill',
    description: 'Invoke a specific swarm skill by ID',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: 'Skill identifier to invoke' },
        params: { type: 'object', description: 'Parameters for the skill' },
      },
      required: ['skill_id'],
    },
  },
  swarm_task_status: {
    name: 'swarm_task_status',
    description: 'Check the status and result of a submitted swarm task',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID to check' },
      },
      required: ['task_id'],
    },
  },
  swarm_list_models: {
    name: 'swarm_list_models',
    description: 'List all available AI models in the swarm ecosystem',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  swarm_health: {
    name: 'swarm_health',
    description: 'Get swarm mainframe health status including active agents, task queue, and system metrics',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  swarm_calculus_mortgage: {
    name: 'swarm_calculus_mortgage',
    description: 'Calculus Mortgage Growth Engine — run mortgage analysis, scenarios, and growth projections',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Mortgage action (analyze, scenario, projection, optimize)' },
        data: { type: 'object', description: 'Mortgage data payload' },
      },
      required: ['action', 'data'],
    },
  },
  swarm_calculus_code: {
    name: 'swarm_calculus_code',
    description: 'Calculus Code Engine — generate, patch, test, or review code via the CCE pipeline',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Code action (generate, patch, test, review, route)' },
        spec: { type: 'object', description: 'Code specification or context' },
      },
      required: ['action', 'spec'],
    },
  },
  swarm_marketing: {
    name: 'swarm_marketing',
    description: 'Swarm marketing operations — create campaigns, generate content, analyze performance',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Marketing action (create_campaign, analyze, generate_content, blueprint)' },
        data: { type: 'object', description: 'Marketing data payload' },
      },
      required: ['action', 'data'],
    },
  },
  swarm_analytics: {
    name: 'swarm_analytics',
    description: 'Swarm analytics engine — query data, generate reports, track metrics',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Analytics query or question' },
        type: { type: 'string', description: 'Query type (report, metric, trend, comparison)' },
      },
      required: ['query'],
    },
  },
};
