# Calculus Voice Agent

AI Voice Agent for the Calculus financial ecosystem: DMC, Constitutional Tender, TILT Lending, Eureka Settlement, IFSE Treasury.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Telephony Gateway                     │
│              (Twilio / Telnyx WebSocket)                 │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              VoicePipelineController                      │
│     ┌────────────────┴────────────────┐                  │
│     │                                 │                  │
│     ▼                                 ▼                  │
│  MODULAR PIPELINE              GROK S2S PIPELINE        │
│  ┌──────────────┐              ┌──────────────┐         │
│  │ Deepgram STT │              │ Grok Voice   │         │
│  │  (Nova-3)    │              │ Agent API    │         │
│  └──────┬───────┘              │ ($0.05/min)  │         │
│         │                      └──────────────┘         │
│         ▼                                               │
│  ┌──────────────┐   Used for:                           │
│  │ Compliance   │   - Informational queries             │
│  │ Enforcer     │   - Balance checks                    │
│  │ (10 gates)   │   - Spot price checks                 │
│  └──────┬───────┘   - Status inquiries                  │
│         │           - IFSE staff dashboards              │
│         ▼           - Outbound alerts                    │
│  ┌──────────────┐                                       │
│  │ Orchestrator │                                       │
│  │ (Orchestra   │   MODULAR pipeline used for:          │
│  │  DSL routing)│   - Buy/sell metals                   │
│  └──┬───────┬───┘   - Wire transfers                    │
│     │       │       - Loan intake                        │
│     ▼       ▼       - Settlement setup                   │
│  GPT-4o  Claude     - Any money movement                │
│  (fast)  (complex)  - Compliance-sensitive flows         │
│     │       │                                            │
│     ▼       ▼                                            │
│  ┌──────────────┐                                       │
│  │ Cartesia TTS │                                       │
│  │  (Sonic-3)   │                                       │
│  └──────────────┘                                       │
└─────────────────────────────────────────────────────────┘
```

## Orchestra DSL Routing

| Intent Category | LLM Provider | Pipeline | Compliance Gates | Cost/min |
|---|---|---|---|---|
| Informational (prices, balances) | Grok Voice | Speech-to-Speech | Post-call audit | $0.05 |
| Simple transactional (bill pay) | GPT-4o | Modular | Real-time | $0.077 |
| Complex/compliance (metals, wires) | Claude | Modular | Real-time | $0.087 |
| Unknown/fallback | GPT-4o | Modular | Real-time | $0.077 |

## ComplianceEnforcer — 10 Gates

### Pre-Dial (Outbound Only)
1. **Consent Gate** — Verifies TCPA consent (written for telemarketing, automated for informational)
2. **DNC Gate** — Checks National DNC, state DNC, internal suppression, reassigned numbers
3. **Time Gate** — Enforces 8AM-9PM recipient local time (state-specific overrides)
4. **Caller ID Gate** — Validates caller ID number format

### Call-Start (All Calls)
5. **Disclosure Gate** — Injects AI disclosure in first 5 seconds
6. **Recording Consent Gate** — Prompts for consent in two-party states

### Real-Time (Modular Pipeline Only)
7. **Opt-Out Monitor** — Detects opt-out/handoff keywords with fuzzy matching
8. **PII Gate** — Detects SSN, credit card, routing numbers in speech
9. **Financial Accuracy Gate** — Staleness detection, investment advice blocking, human escalation thresholds

### Post-Call (All Calls)
10. **Audit Scorecard** — Generates compliance scorecard, determines training data eligibility

## Project Structure

```
src/
├── index.ts                      # Exports
├── types.ts                      # Core types, auth tiers, canonical data objects
├── auth/
│   ├── index.ts                  # Auth module exports
│   └── service.ts                # AuthService — OTP, device binding, tier upgrade
├── compliance/
│   └── enforcer.ts               # ComplianceEnforcer (10-gate pipeline)
├── config/
│   ├── env-validation.ts         # Environment variable validation with Zod
│   └── state_rules.json          # State-specific compliance rules
├── db/
│   ├── client.ts                 # Drizzle + pg connection
│   ├── index.ts                  # DB module exports
│   └── schema.ts                 # Sessions, audit events, consent records schema
├── flows/
│   ├── base-flow.ts              # Abstract BaseFlow class
│   ├── ct-flow.ts                # Constitutional Tender flow (metals)
│   ├── dmc-flow.ts               # DMC flow (deposits, transfers, bill pay)
│   ├── eureka-loan-ifse-flows.ts # Eureka settlement, TILT loan, IFSE treasury flows
│   ├── index.ts                  # Flow module exports
│   ├── mortgage-flow.ts          # Mortgage flow
│   ├── real-estate-flow.ts       # Real estate flow
│   ├── tilt-flow.ts              # TILT lending flow
│   └── types.ts                  # Flow-specific types
├── gateway/
│   ├── cartesia-client.ts        # Cartesia TTS WebSocket client
│   ├── deepgram-client.ts        # Deepgram STT WebSocket client
│   ├── grok-adapter.ts           # Grok Voice Agent API WebSocket client
│   ├── pipeline-controller.ts    # Pipeline switching (modular ↔ Grok)
│   ├── server.ts                 # Express/WebSocket server entry point
│   └── twilio-stream.ts          # Twilio Media Stream handler
├── llm/
│   ├── index.ts                  # LLM module exports
│   ├── provider.ts               # LLMService — GPT-4o / Claude provider abstraction
│   └── tool-executor.ts          # ToolExecutor — function calling + schema builder
├── orchestrator/
│   └── orchestrator.ts           # State machine + Orchestra DSL routing
└── services/
    ├── audit-service.ts          # AuditServiceImpl — event bus writes
    ├── consent-service.ts        # ConsentServiceImpl — TCPA consent management
    ├── contracts.ts              # API interfaces for all microservices
    ├── session-service.ts        # SessionService — call session lifecycle
    └── crm/
        ├── ghl-service.ts        # GoHighLevel CRM integration
        ├── hubspot-service.ts    # HubSpot CRM integration
        ├── index.ts              # CRM module exports
        └── unified-adapter.ts    # UnifiedCRMAdapter — routes by CalcModel

tests/
├── compliance.test.ts            # ComplianceEnforcer gate tests
├── e2e.test.ts                   # End-to-end call flow tests
└── routing.test.ts               # Orchestra DSL routing verification
```

## Key Design Decisions

1. **Grok for informational, Claude/GPT-4o for transactional.** Grok's $0.05/min speech-to-speech is ideal for read-only queries. But speech-to-speech means no real-time transcript inspection — so money movement, lending, and metals transactions MUST use the modular pipeline where ComplianceEnforcer runs on every utterance.

2. **Auth tiers enforce at orchestration layer.** The LLM never decides auth — the orchestrator checks tier before exposing tools. Grok only gets read-only tools.

3. **Compliance is non-bypassable.** Pre-dial gates run before the WebSocket connects. Real-time gates run on every Deepgram transcript chunk. There is no code path that skips compliance in strict mode.

4. **Training data gated by compliance.** Only calls where ALL gates passed AND recording consent was obtained feed into future model training. This builds the data moat while staying compliant.

## Setup

```bash
cp .env.example .env
# Fill in API keys
npm install
npm run build
npm run dev
```

### Docker (recommended for local development)

```bash
# Start PostgreSQL + Redis + agent
docker compose up -d

# Start only infra (run agent locally)
docker compose up -d postgres redis

# Watch agent logs
docker compose logs -f agent

# Tear down and delete volumes
docker compose down -v
```

The docker-compose stack runs PostgreSQL 15, Redis 7, and the voice agent on port 3000.  
An optional Drizzle Studio UI (database browser) can be started with `--profile studio`.

### Database migrations

```bash
npx drizzle-kit push   # Apply schema to the running database
npx drizzle-kit studio # Open Drizzle Studio at http://localhost:4983
```

## Testing

```bash
npm test
```
