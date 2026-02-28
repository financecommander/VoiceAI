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
├── compliance/
│   └── enforcer.ts               # ComplianceEnforcer (10-gate pipeline)
├── orchestrator/
│   └── orchestrator.ts           # State machine + Orchestra DSL routing
├── gateway/
│   ├── grok-adapter.ts           # Grok Voice Agent API WebSocket client
│   └── pipeline-controller.ts    # Pipeline switching (modular ↔ Grok)
├── services/
│   └── contracts.ts              # API interfaces for all microservices
├── config/
│   └── state_rules.json          # State-specific compliance rules
└── prompts/                      # (See Voice_Agent_Prompt_Templates_All_Models.md)

tests/
├── routing.test.ts               # Orchestra DSL routing verification
└── compliance.test.ts            # ComplianceEnforcer gate tests
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

## Testing

```bash
npm test
```
