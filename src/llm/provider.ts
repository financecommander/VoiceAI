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
import type { Logger } from 'pino';
import type { CalcModel, AuthTier, Intent } from '../types.js';
import type { LLMProvider as LLMProviderType, PipelineMode } from '../orchestrator/orchestrator.js';

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
  };
}

export const DEFAULT_LLM_CONFIG: Partial<LLMConfig> = {
  gpt4oModel: 'gpt-4o',
  claudeModel: 'claude-sonnet-4-5-20250929',
  maxTokens: 300,   // ~20 seconds of speech at normal pace
  temperature: {
    'gpt-4o': 0.3,   // Low — factual, consistent
    claude: 0.4,      // Slightly higher — nuanced reasoning
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

// ============================================================================
// LLM Service
// ============================================================================

export class LLMService {
  private openai: OpenAI;
  private anthropic: Anthropic;
  private config: LLMConfig;
  private logger: Logger;

  /** Conversation history per session */
  private history: Map<string, ConversationMessage[]> = new Map();

  constructor(config: LLMConfig, logger: Logger) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config } as LLMConfig;
    this.logger = logger.child({ component: 'LLMService' });

    this.openai = new OpenAI({ apiKey: config.openaiApiKey });
    this.anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
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
      const response = await this.callWithTimeout(
        params.provider,
        messages,
        params.tools,
        params.toolExecutor,
        params.latencyBudgetMs,
      );

      // Add assistant response to history
      messages.push({ role: 'assistant', content: response.text });

      // Post-process for voice
      response.text = this.postProcessForVoice(response.text);

      response.latencyMs = Date.now() - startTime;
      return response;

    } catch (error) {
      // Fallback to GPT-4o if primary fails
      if (params.provider !== 'gpt-4o') {
        this.logger.warn({
          provider: params.provider,
          error: (error as Error).message,
        }, 'Primary LLM failed, falling back to GPT-4o');

        try {
          const fallback = await this.callWithTimeout(
            'gpt-4o',
            messages,
            params.tools,
            params.toolExecutor,
            5000, // Give fallback generous budget
          );

          messages.push({ role: 'assistant', content: fallback.text });
          fallback.text = this.postProcessForVoice(fallback.text);
          fallback.latencyMs = Date.now() - startTime;
          fallback.wasFallback = true;
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
};

// ============================================================================
// Tool Schema Builder
// ============================================================================

/**
 * Build OpenAI/Claude-compatible tool schemas from the orchestrator's
 * tool name list. Maps tool names to JSON Schema definitions.
 */
export function buildToolSchemas(toolNames: string[]): ToolDefinition[] {
  return toolNames
    .map(name => TOOL_SCHEMAS[name])
    .filter((t): t is ToolDefinition => t !== undefined);
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
};
