# Calculus Voice Agent

Production-grade AI voice agent platform for the Calculus financial ecosystem. 8 model-specific conversation flows, 10-gate compliance pipeline, dual LLM routing, and Twilio Media Streams integration.

**12,085 source lines | 36 files | 91 tests passing | 0 type errors**

## 8 Agent Models

| Agent | Business Line | Backend | CRM | Key Capability |
|-------|-------------|---------|-----|----------------|
| **DMC** | Consumer banking | Nymbus Core | HubSpot | Balances, bill pay, card services, disputes |
| **Constitutional Tender** | Precious metals | Real-time pricing feed | GHL | Spot prices → education → quote → price lock → vault → order |
| **TILT** | Commercial lending | DSCR calculator | GHL | Property intake → NOI analysis → pre-screen → term sheet |
| **Mortgage** | Residential origination | 1003 application | GHL | Pre-qual → rate shop → application → disclosure → lock |
| **Real Estate** | Transaction coordination | MLS / listings | GHL | Property search, offers, showings, contract-to-close |
| **Eureka** | Settlement services | File management | GHL | File status, doc tracking, wire instructions, scheduling |
| **Loan Servicing** | Post-close management | LoanPro | HubSpot | Payments, payoff quotes, escrow analysis, modifications |
| **IFSE** | Treasury operations | FX / wire systems | HubSpot | Wire status, FX trading, reconciliation, reporting |

Each agent is a state machine with model-specific phases, auth requirements, tool sets, system prompts, and transition logic. The orchestrator delegates to the appropriate flow controller based on the inbound phone number.

## Architecture

```
Inbound Call → Twilio Media Streams WebSocket
                    │
                    ▼
           Phone-to-Model Router ──→ getFlowController(model)
                    │
                    ▼
        ┌───────────────────────────┐
        │  VoicePipelineController  │
        │  ┌─────────┬───────────┐  │
        │  │ MODULAR  │ GROK S2S │  │
        │  └────┬────┘└─────────┘  │
        └───────┼──────────────────┘
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
Deepgram    Compliance   Cartesia
Nova-3 STT  Enforcer     Sonic-3 TTS
            (10 gates)
                │
                ▼
        ┌───────────────┐
        │  Orchestrator  │──→ FlowController (phases, tools, prompts)
        │  (compliance,  │──→ routeIntent() (GPT-4o / Claude / Grok)
        │   auth, cost)  │──→ Auth service (OTP, tier upgrades)
        └───────────────┘
```

### Pipeline Modes

**Modular** (Deepgram → LLM → Cartesia): Used for transactions, compliance-sensitive flows, money movement. ComplianceEnforcer runs on every utterance.

**Speech-to-Speech** (Grok Voice API): Used for read-only queries — spot prices, balances, status checks. Lower latency, lower cost ($0.05/min), post-call audit only.

### LLM Routing (Orchestra DSL)

| Intent Category | Provider | Pipeline | Cost/min |
|----------------|----------|----------|----------|
| Informational (prices, balances, status) | Grok Voice | Speech-to-Speech | $0.05 |
| Simple transactional (bill pay) | GPT-4o | Modular | $0.077 |
| Complex / compliance (metals, wires, lending) | Claude | Modular | $0.087 |

## Compliance — 10 Gates

**Pre-Dial (outbound):** consent verification, DNC/suppression check, time-of-day enforcement (8AM–9PM recipient TZ), caller ID validation

**Call-Start (all calls):** AI disclosure injection, recording consent (two-party states)

**Real-Time (modular pipeline):** opt-out detection (fuzzy NLP matching), PII detection (SSN, credit card, routing numbers), financial accuracy guardrails (staleness, investment advice blocking, human escalation thresholds)

**Post-Call:** compliance scorecard generation, training data eligibility gating

State-specific rules for all 50 states in `src/config/state_rules.json`.

## Authentication — 4 Tiers

| Tier | Verification | Unlocks |
|------|-------------|---------|
| 0 | None | General info, pricing, branch hours |
| 1 | Phone match or member ID | Account balances, transaction history, file status |
| 2 | OTP verified | Transfers, payments, price locks, orders, modifications |
| 3 | Multi-factor | Wire instructions, FX trades, large transactions |

Auth is enforced at the orchestrator layer — the LLM never decides auth. Flow controllers define `minAuthTier` per phase.

## Project Structure

```
src/
├── index.ts                          # Public API exports
├── types.ts                          # Core types, enums, auth tiers, intents
├── orchestrator/
│   └── orchestrator.ts               # State machine + Orchestra DSL + flow delegation
├── flows/
│   ├── types.ts                      # FlowState, IFlowController, transitions
│   ├── base-flow.ts                  # Abstract base (prompt builder, transition engine)
│   ├── index.ts                      # Flow registry (getFlowController)
│   ├── dmc-flow.ts                   # DMC — consumer banking (9 phases)
│   ├── ct-flow.ts                    # Constitutional Tender — metals (10 phases)
│   ├── tilt-flow.ts                  # TILT — commercial lending (9 phases)
│   ├── mortgage-flow.ts              # Mortgage — residential origination (9 phases)
│   ├── real-estate-flow.ts           # Real Estate — transaction coordination (10 phases)
│   └── eureka-loan-ifse-flows.ts     # Eureka + Loan Servicing + IFSE (25 phases total)
├── compliance/
│   └── enforcer.ts                   # 10-gate compliance pipeline
├── gateway/
│   ├── server.ts                     # Express + WebSocket server
│   ├── twilio-stream.ts              # Twilio Media Streams handler + phone→model router
│   ├── deepgram-client.ts            # Deepgram Nova-3 STT WebSocket client
│   ├── cartesia-client.ts            # Cartesia Sonic-3 TTS WebSocket client
│   ├── grok-adapter.ts               # Grok Voice Agent API adapter
│   └── pipeline-controller.ts        # Modular ↔ Grok pipeline switching
├── llm/
│   ├── provider.ts                   # GPT-4o + Claude dual-provider with fallback
│   └── tool-executor.ts              # Tool dispatch + audit logging
├── auth/
│   └── service.ts                    # OTP generation, verification, tier management
├── db/
│   ├── schema.ts                     # 7 tables (Drizzle ORM + PostgreSQL)
│   └── client.ts                     # Connection pool + health checks
├── services/
│   ├── contracts.ts                  # Service interfaces (1,510 lines)
│   ├── audit-service.ts              # Immutable append-only audit log
│   ├── consent-service.ts            # TCPA consent + DNC management
│   ├── session-service.ts            # Voice session lifecycle
│   └── crm/
│       ├── ghl-service.ts            # GoHighLevel V2 API (CT, TILT, RE, Eureka, Mortgage)
│       ├── hubspot-service.ts         # HubSpot V3 API (DMC, IFSE, Loan Servicing)
│       └── unified-adapter.ts         # Model→CRM routing adapter
└── config/
    ├── env-validation.ts              # Startup env checks (7 fatal, 13 warning)
    └── state_rules.json               # 50-state compliance rules

tests/
├── compliance.test.ts                 # 32 tests — all 10 compliance gates
├── routing.test.ts                    # 39 tests — Orchestra DSL routing
└── e2e.test.ts                        # 20 tests — full pipeline simulation
```

## Database — 7 Tables

| Table | Purpose |
|-------|---------|
| `voiceSessions` | Call lifecycle (model, direction, status, auth tier, duration) |
| `conversationTurns` | Per-turn records (utterance, response, provider, latency) |
| `auditEvents` | Immutable compliance audit trail |
| `consentRecords` | TCPA consent capture and revocation |
| `authSessions` | Auth tier tracking per session |
| `otpAttempts` | OTP generation and verification with rate limiting |
| `dncList` | Do-not-call and suppression list |

## Docker Stack

```yaml
services:
  agent:      # Voice agent (Node.js 20, multi-stage build)
  postgres:   # PostgreSQL 15 (7 tables, Drizzle ORM)
  redis:      # Redis 7 (session cache — planned)
  drizzle-studio: # DB admin UI (port 4983)
```

## Setup

```bash
cp .env.example .env
# Fill in: TWILIO, OPENAI, ANTHROPIC, DEEPGRAM, CARTESIA, DATABASE_URL
# Optional: GHL, HUBSPOT, GROK, REDIS, phone numbers per model

npm install
npm run build
npm run dev
```

## Testing

```bash
npm test          # Watch mode
npm run test:run  # Single run (91 tests, ~5s)
npm run typecheck # tsc --noEmit
```

## Key Design Decisions

1. **Flow controllers own conversation logic, orchestrator owns infrastructure.** Each of the 8 agents defines its own phases, tools, prompts, and transitions. The orchestrator delegates to `getFlowController(model)` and handles compliance, auth, pipeline selection, and cost tracking.

2. **Grok for informational, Claude/GPT-4o for transactional.** Grok's $0.05/min speech-to-speech handles read-only queries. Money movement and compliance-sensitive flows use the modular pipeline where ComplianceEnforcer inspects every utterance.

3. **Auth enforced at orchestration layer.** The LLM never decides auth — the orchestrator checks tier before exposing tools. Flow controllers define `minAuthTier` per phase. Grok only gets read-only tools.

4. **Compliance is non-bypassable.** Pre-dial gates run before WebSocket connects. Real-time gates run on every Deepgram transcript chunk. No code path skips compliance.

5. **Training data gated by compliance.** Only calls where ALL gates passed AND recording consent was obtained become training data. Builds the data moat while staying compliant.

## Status

- **TypeScript errors:** 0
- **Tests:** 91/91 passing (3 suites)
- **Source lines:** 12,085 across 36 files
- **Test lines:** 1,140 across 3 files
- **Git commits:** 11
