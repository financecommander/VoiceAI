# Calculus Voice Agent — Code Audit Report

**Date:** February 28, 2026
**Repo:** VoiceAI (main branch)
**Commits:** 5 (8c91f50 → 21a8106)
**Auditor:** Claude (Architecture + Security Review)

---

## Executive Summary

The codebase is a well-structured TypeScript voice AI agent platform spanning 12,042 source lines across 35 files, with 1,127 lines of tests across 3 test suites (91 tests, all passing on Codespaces). The architecture is production-grade in design: 10-gate compliance pipeline, 4-tier authentication, 8 agent flow controllers, dual LLM routing, and full Twilio Media Streams integration.

**Overall Grade: B+** — Architecturally excellent, but several integration gaps and dependency issues must be resolved before handling live calls.

---

## Inventory

| Category | Files | Lines | Status |
|----------|-------|-------|--------|
| Core Types | 1 | 424 | ✅ Clean |
| Gateway (Twilio, STT, TTS, Grok) | 6 | 2,645 | ⚠️ 120 type errors (dependency-gated) |
| Orchestrator | 1 | 864 | ⚠️ Flows not wired in |
| Compliance | 1 | 716 | ✅ Clean |
| LLM (Provider + Tools) | 3 | 1,349 | ⚠️ 4 real type errors |
| Flows (8 agents) | 9 | 1,192 | ✅ Zero type errors |
| Services (CRM, Audit, Consent, Session) | 7 | 3,700 | ⚠️ 2 interface mismatches |
| Auth | 2 | 410 | ✅ Clean (pending crypto import) |
| Database (Drizzle + Schema) | 3 | 605 | ✅ Clean |
| Config | 1 | — | ✅ 50-state compliance rules |
| Tests | 3 | 1,127 | ✅ 91/91 passing |
| Infra (Docker, Drizzle, TSConfig) | 4 | — | ✅ Complete |
| **Total** | **41** | **~13,200** | |

---

## Critical Issues (Must Fix)

### 1. `CalcModel` vs `AgentModel` Mismatch

`src/types.ts` defines `CalcModel` with 5 values (DMC, CT, TILT, EUREKA, IFSE). `src/flows/types.ts` defines `AgentModel` with 8 values (adds MORTGAGE, REAL_ESTATE, LOAN_SERVICING). The orchestrator, database schema, and all services use `CalcModel`. The flow controllers use `AgentModel`.

**Impact:** Mortgage, Real Estate, and Loan Servicing calls cannot be routed through the orchestrator or persisted to the database. The `calcModelEnum` in `src/db/schema.ts` only has 5 values.

**Fix:** Extend `CalcModel` enum and `calcModelEnum` to include all 8 models. Add phone number mappings for the 3 new models.

### 2. Flow Controllers Not Integrated Into Orchestrator

The 8 flow controllers in `src/flows/` are complete and self-contained, but `src/orchestrator/orchestrator.ts` does not import or use them. The orchestrator has its own hardcoded phase management (`greeting → disclosure → recording_consent → authentication → intent_detection → flow_execution → confirmation → escalation → wrap_up → ended`) that duplicates and conflicts with the flow controllers' phase definitions.

**Impact:** The flow controllers' model-specific phases, transitions, tools, and system prompts are ignored at runtime. The orchestrator uses generic phase handling instead of the rich per-model state machines.

**Fix:** Refactor the orchestrator to delegate to `getFlowController(model)` for phase management, tool resolution, system prompt generation, and transition evaluation. The orchestrator should own session lifecycle; flows should own conversation logic.

### 3. `@types/pg` Missing From `package.json`

`pg` is in dependencies but `@types/pg` is not in devDependencies. This was added during the session via `npm install` but the `package.json` on GitHub may not reflect it (the commit message mentions adding it, but the package.json shown doesn't include it).

**Fix:** Add `"@types/pg": "^8.11.0"` to devDependencies.

### 4. Tool Executor Type Errors (Real Code Issues)

Four genuine type errors in `src/llm/tool-executor.ts`:
- `'tool_executed'` and `'tool_error'` not in `AuditEventType` union (the DB enum has them, but the TypeScript union in `types.ts` may have been overwritten by tar extraction)
- `noi` field: `number | undefined` assigned to `number`
- `source` field: `string` assigned to union literal type

**Fix:** Verify `types.ts` includes `'tool_executed' | 'tool_error'` in the `AuditEventType` union. Add null coalescing for `noi` and type assertion for `source`.

### 5. Consent Service Interface Mismatch

`ConsentServiceImpl.captureConsent()` and `revokeConsent()` signatures don't match `IConsentService` interface in `contracts.ts`. The implementation uses `params: any` as a workaround.

**Fix:** Align the interface signatures or keep the `any` cast (acceptable for internal service).

---

## Moderate Issues (Should Fix)

### 6. Phone-to-Model Map is Hardcoded

`PHONE_MODEL_MAP` in `src/gateway/twilio-stream.ts` has 4 hardcoded placeholder numbers. Missing entries for IFSE, Mortgage, Real Estate, and Loan Servicing. No env-based configuration.

**Fix:** Load from environment variables (`PHONE_DMC`, `PHONE_CT`, etc.) or a config file.

### 7. `tsconfig.json` Missing Node Types in `lib`

The `lib` field only includes `["ES2022"]`. This causes all Node.js globals (`Buffer`, `process`, `setTimeout`, `fetch`, `URL`, etc.) to error as TS2304/TS2580 — 86 of the 190 errors.

**Fix:** Either add `"@types/node"` to `types` array in tsconfig, or change the approach. The `@types/node` package is already in devDependencies, so adding `"types": ["node"]` to compilerOptions would resolve 86 errors instantly.

### 8. EventEmitter Inheritance Missing

`CartesiaTTSClient` and `DeepgramSTTClient` use `this.emit()` and external code calls `.on()`, but neither class extends `EventEmitter`. The `events` module import exists but the `extends EventEmitter` declaration gets lost when the module can't be resolved.

**Impact:** 17 "Property 'emit'/'on' does not exist" errors. These work at runtime (JavaScript) but fail typecheck.

**Fix:** Ensure both classes `extends EventEmitter` with proper typing.

### 9. No Runtime Environment Validation

No startup check that required env vars (API keys, database URL, Twilio credentials) are set. The server will start and fail on first call.

**Fix:** Add a `validateEnv()` function called at startup that checks all required vars and fails fast with clear error messages.

### 10. No Redis Integration Yet

`docker-compose.yml` includes Redis 7, but no code uses it. Active session caching, rate limiting, and pub/sub for multi-instance coordination are all planned but unimplemented.

**Fix:** Add `ioredis` client initialization and session caching layer.

---

## Minor Issues (Nice to Fix)

### 11. Implicit `any` Parameters (29 instances)

Drizzle schema table callbacks, error handlers, and server request handlers use implicit `any`. All are in positions where the types are obvious from context.

**Fix:** Add explicit type annotations: `(table: any)`, `(err: Error)`, `(_req: Request, res: Response)`.

### 12. No `.env.example` Completeness Check

The `.env.example` exists but may not cover all vars added in later sessions (database URL, auth dev mode, voice IDs, etc.).

**Fix:** Audit `.env.example` against `docker-compose.yml` env section.

### 13. Flow Controllers Don't Export From Main Index

`src/index.ts` exports everything except the flow system. External consumers can't access `getFlowController()`.

**Fix:** Add `export { getFlowController, getAllFlowControllers, getSupportedModels } from './flows/index.js';`

### 14. Test Coverage Gaps

- No unit tests for flow controllers (phase transitions, tool resolution, system prompt generation)
- No unit tests for auth service (OTP generation, tier upgrade, rate limiting)
- No unit tests for session service
- No integration test for the full flow controller → orchestrator → LLM pipeline

---

## Architecture Assessment

### Strengths

- **Clean separation of concerns:** Gateway → Pipeline → Orchestrator → LLM → Tools, with compliance gates at every layer
- **10-gate compliance pipeline** is comprehensive: consent, DNC, time-of-day, caller ID, disclosure, recording consent, opt-out monitoring, PII detection, financial accuracy, state-specific rules
- **4-tier auth model** maps correctly to financial services requirements
- **8 flow controllers** are well-designed state machines with model-specific phases, tools, prompts, and transitions
- **Dual LLM routing** (GPT-4o for speed, Claude for compliance) is cost-effective
- **Full audit trail** with immutable append-only event logging
- **50-state compliance rules** in JSON config
- **Docker-ready** with Postgres + Redis + multi-stage build

### Gaps

- **No WebSocket reconnection logic** — if Deepgram or Cartesia connections drop mid-call, there's no automatic reconnection
- **No circuit breaker** for LLM providers — if OpenAI is down, fallback to Claude exists in routing config but isn't enforced with timeout/retry logic
- **No call recording storage** — `recordingUrl` field exists in schema but no S3/GCS integration for storing recordings
- **No metrics/observability** — no Prometheus endpoint, no structured latency tracking beyond Pino logs
- **No rate limiting on inbound webhooks** — Twilio webhook endpoint has no request validation (should verify Twilio signature)

---

## Dependency Health

| Package | Version | Status |
|---------|---------|--------|
| TypeScript | ^5.7.0 | ✅ Current |
| Node.js | >=20.0.0 | ✅ Required |
| Drizzle ORM | ^0.38.0 | ✅ Current |
| PostgreSQL | 15-alpine | ✅ Stable |
| Redis | 7-alpine | ✅ Stable |
| Express | ^4.21.0 | ⚠️ Consider Express 5 |
| OpenAI SDK | ^4.77.0 | ✅ Current |
| Anthropic SDK | ^0.39.0 | ✅ Current |
| Deepgram SDK | ^3.9.0 | ✅ Current |
| Cartesia SDK | ^2.2.0 | ✅ Current |
| Vitest | ^2.1.0 | ✅ Current |

---

## Recommended Fix Priority

**Day 1 (Unblock live calls):**
1. Fix `tsconfig.json` — add `"types": ["node"]` (kills 86 errors)
2. Fix `CalcModel` enum — add MORTGAGE, REAL_ESTATE, LOAN_SERVICING
3. Fix 4 real type errors in tool-executor.ts
4. Add `@types/pg` to package.json
5. Add env validation at startup

**Day 2 (Wire flows into orchestrator):**
6. Refactor orchestrator to delegate to flow controllers
7. Export flows from main index
8. Add phone number mappings for all 8 models
9. Fix EventEmitter inheritance on STT/TTS clients

**Day 3 (Production hardening):**
10. Add Twilio webhook signature validation
11. Add Redis session caching
12. Add WebSocket reconnection logic
13. Add flow controller unit tests

---

## Test Matrix

| Suite | Tests | Status | Coverage Area |
|-------|-------|--------|---------------|
| compliance.test.ts | 32 | ✅ Pass | All 10 compliance gates, state rules, PII detection |
| routing.test.ts | 39 | ✅ Pass | Intent→LLM routing, model→tool resolution, Grok eligibility |
| e2e.test.ts | 20 | ✅ Pass | Twilio webhooks, pipeline simulation, CRM routing, audio conversion |
| **Total** | **91** | **✅ All Pass** | |

**Missing test coverage:** Flow controller transitions, auth service OTP, session persistence, consent service DB operations, LLM provider fallback.
