/**
 * Calculus Voice Agent — Core Types
 *
 * Maps directly to Developer Implementation Spec v1, Section 2 (Auth Tiers)
 * and Section 4 (Data Objects / Canonical Schema).
 */

// ============================================================================
// Auth Tiers (Spec Section 2)
// ============================================================================

export enum AuthTier {
  /** General info only — branch hours, pricing ranges, eligibility */
  ANONYMOUS = 0,
  /** Basic account info — balances, recent transactions. No money movement. */
  VERIFIED = 1,
  /** OTP + device binding. Can schedule transfers, request quotes. */
  STRONG = 2,
  /** OTP + liveness + risk check. Wires, metal transfers, collateral release. */
  HIGH_RISK = 3,
}

// ============================================================================
// Business Models
// ============================================================================

export enum CalcModel {
  DMC = 'DMC',
  CONSTITUTIONAL_TENDER = 'CONSTITUTIONAL_TENDER',
  TILT = 'TILT',
  MORTGAGE = 'MORTGAGE',
  REAL_ESTATE = 'REAL_ESTATE',
  EUREKA = 'EUREKA',
  LOAN_SERVICING = 'LOAN_SERVICING',
  IFSE = 'IFSE',
}

// ============================================================================
// Call Direction & Type
// ============================================================================

export enum CallDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
}

export enum CallType {
  SERVICE = 'service',
  TRANSACTIONAL = 'transactional',
  SALES = 'sales',
  CALLBACK = 'callback',
  COLLECTIONS = 'collections',
}

export enum CallPurpose {
  INFORMATIONAL = 'informational',
  TELEMARKETING = 'telemarketing',
}

// ============================================================================
// Intents — Canonical intent taxonomy across all models
// ============================================================================

export enum Intent {
  // DMC
  BALANCE_INQUIRY = 'balance_inquiry',
  CARD_STATUS = 'card_status',
  FEE_EXPLANATION = 'fee_explanation',
  BRANCH_LOCATION = 'branch_location',
  BILL_PAY = 'bill_pay',
  DOMESTIC_TRANSFER = 'domestic_transfer',
  INTERNATIONAL_TRANSFER = 'international_transfer',

  // Constitutional Tender
  BUY_METAL = 'buy_metal',
  SELL_METAL = 'sell_metal',
  METAL_PRICE_CHECK = 'metal_price_check',
  VAULT_BALANCE = 'vault_balance',
  TELEPORT_TRANSFER = 'teleport_transfer',
  CUSTODY_RECEIPT = 'custody_receipt',

  // TILT
  LOAN_INTAKE = 'loan_intake',
  PAYOFF_QUOTE = 'payoff_quote',
  PAYMENT_INQUIRY = 'payment_inquiry',
  ESCROW_INQUIRY = 'escrow_inquiry',
  DELINQUENCY_INQUIRY = 'delinquency_inquiry',

  // Eureka
  SETTLEMENT_SETUP = 'settlement_setup',
  SETTLEMENT_STATUS = 'settlement_status',
  INSTANT_LIQUIDITY = 'instant_liquidity',

  // IFSE (staff only)
  FX_EXPOSURE = 'fx_exposure',
  PENDING_WIRES = 'pending_wires',
  SETTLEMENT_QUEUE = 'settlement_queue',
  RECON_REPORT = 'recon_report',

  // Universal
  HUMAN_HANDOFF = 'human_handoff',
  OPT_OUT = 'opt_out',
  COMPLAINT = 'complaint',
  GENERAL_QUESTION = 'general_question',
  UNKNOWN = 'unknown',
}

/** Maps intents to minimum auth tier required */
export const INTENT_AUTH_REQUIREMENTS: Record<Intent, AuthTier> = {
  // DMC
  [Intent.BALANCE_INQUIRY]: AuthTier.VERIFIED,
  [Intent.CARD_STATUS]: AuthTier.VERIFIED,
  [Intent.FEE_EXPLANATION]: AuthTier.ANONYMOUS,
  [Intent.BRANCH_LOCATION]: AuthTier.ANONYMOUS,
  [Intent.BILL_PAY]: AuthTier.STRONG,
  [Intent.DOMESTIC_TRANSFER]: AuthTier.STRONG,
  [Intent.INTERNATIONAL_TRANSFER]: AuthTier.STRONG, // Tier 3 for >$10K

  // Constitutional Tender
  [Intent.BUY_METAL]: AuthTier.STRONG, // Tier 3 for >$10K
  [Intent.SELL_METAL]: AuthTier.STRONG,
  [Intent.METAL_PRICE_CHECK]: AuthTier.ANONYMOUS,
  [Intent.VAULT_BALANCE]: AuthTier.VERIFIED,
  [Intent.TELEPORT_TRANSFER]: AuthTier.HIGH_RISK,
  [Intent.CUSTODY_RECEIPT]: AuthTier.VERIFIED,

  // TILT
  [Intent.LOAN_INTAKE]: AuthTier.ANONYMOUS,
  [Intent.PAYOFF_QUOTE]: AuthTier.VERIFIED,
  [Intent.PAYMENT_INQUIRY]: AuthTier.VERIFIED,
  [Intent.ESCROW_INQUIRY]: AuthTier.VERIFIED,
  [Intent.DELINQUENCY_INQUIRY]: AuthTier.VERIFIED,

  // Eureka
  [Intent.SETTLEMENT_SETUP]: AuthTier.STRONG,
  [Intent.SETTLEMENT_STATUS]: AuthTier.VERIFIED,
  [Intent.INSTANT_LIQUIDITY]: AuthTier.HIGH_RISK,

  // IFSE
  [Intent.FX_EXPOSURE]: AuthTier.STRONG, // Staff SSO maps to Tier 2+
  [Intent.PENDING_WIRES]: AuthTier.STRONG,
  [Intent.SETTLEMENT_QUEUE]: AuthTier.STRONG,
  [Intent.RECON_REPORT]: AuthTier.STRONG,

  // Universal
  [Intent.HUMAN_HANDOFF]: AuthTier.ANONYMOUS,
  [Intent.OPT_OUT]: AuthTier.ANONYMOUS,
  [Intent.COMPLAINT]: AuthTier.ANONYMOUS,
  [Intent.GENERAL_QUESTION]: AuthTier.ANONYMOUS,
  [Intent.UNKNOWN]: AuthTier.ANONYMOUS,
};

/** Intents that require human review above certain thresholds */
export const HUMAN_ESCALATION_THRESHOLDS: Partial<Record<Intent, number>> = {
  [Intent.BUY_METAL]: 25_000,
  [Intent.SELL_METAL]: 50_000,
  [Intent.INTERNATIONAL_TRANSFER]: 10_000,
  [Intent.TELEPORT_TRANSFER]: 0, // Always human review
  [Intent.INSTANT_LIQUIDITY]: 0, // Always human review
};

// ============================================================================
// Canonical Data Objects (Spec Section 4)
// ============================================================================

export interface VoiceSession {
  sessionId: string;
  conversationId: string;
  callDirection: CallDirection;
  callType: CallType;
  callPurpose: CallPurpose;
  model: CalcModel;
  callerPhone: string;
  recipientPhone: string;
  recipientState: string;
  customerId: string | null;
  authTier: AuthTier;
  startedAt: Date;
  endedAt: Date | null;
  createdByAgent: boolean;
  consentTimestamp: Date | null;
  recordingConsent: boolean;
  transcript: TranscriptEntry[];
  intentsDetected: Intent[];
  actionsExecuted: ActionRecord[];
  escalations: EscalationRecord[];
  complianceGates: ComplianceGateResult[];
  outcome: CallOutcome;
}

export interface TranscriptEntry {
  timestamp: Date;
  speaker: 'caller' | 'agent';
  text: string;
  piiRedacted: boolean;
  confidence: number;
}

export interface ActionRecord {
  actionId: string;
  timestamp: Date;
  service: string;
  method: string;
  params: Record<string, unknown>;
  result: 'success' | 'failure' | 'pending' | 'escalated';
  authTierRequired: AuthTier;
  authTierVerified: AuthTier;
  durationMs: number;
}

export interface EscalationRecord {
  timestamp: Date;
  reason: string;
  trigger: 'customer_request' | 'threshold' | 'compliance' | 'frustration' | 'error';
  context: string;
  handoffTarget: string;
}

export interface ComplianceGateResult {
  gateId: string;
  gateName: string;
  passed: boolean;
  timestamp: Date;
  details: string;
}

export type CallOutcome =
  | 'order_created'
  | 'lead_captured'
  | 'transfer_initiated'
  | 'settlement_created'
  | 'inquiry_resolved'
  | 'escalated_to_human'
  | 'opted_out'
  | 'abandoned'
  | 'error';

// ============================================================================
// Service Action Contracts (Spec Section 1, Component 4)
// ============================================================================

/** Metal order (Constitutional Tender) */
export interface MetalOrder {
  orderId: string;
  customerId: string;
  type: 'buy' | 'sell';
  metal: 'gold' | 'silver' | 'platinum';
  product: string;
  quantity: number;
  spotPriceAtLock: number;
  spreadAmount: number;
  totalPrice: number;
  lockExpiresAt: Date;
  vaultId: string | null;
  deliveryAddress: string | null;
  status: 'locked' | 'confirmed' | 'executing' | 'settled' | 'cancelled';
  wholesalerRef: string;
  custodianRef: string | null;
  conversationId: string;
  createdByAgent: boolean;
}

/** Transfer request (DMC / Constitutional Tender) */
export interface TransferRequest {
  requestId: string;
  customerId: string;
  type: 'domestic' | 'international' | 'book_entry';
  fromAccount: string;
  toAccount: string;
  amount: number;
  currency: string;
  toCurrency?: string;
  fxRate?: number;
  fee: number;
  status: 'pending_auth' | 'pending_review' | 'approved' | 'executing' | 'settled' | 'rejected';
  sanctionsCleared: boolean;
  authTierAtSubmission: AuthTier;
  conversationId: string;
  createdByAgent: boolean;
}

/** Loan application lead (TILT) */
export interface LoanApplicationLead {
  leadId: string;
  source: 'voice_agent' | 'web' | 'broker_referral' | 'arbor' | 'costar';
  callerType: 'broker' | 'borrower';
  brokerName?: string;
  brokerCompany?: string;
  borrowerName?: string;
  propertyType: string;
  propertyAddress: string;
  units?: number;
  squareFeet?: number;
  status: 'stabilized' | 'value_add' | 'construction';
  grossRentalIncome: number;
  operatingExpenses: number;
  noi: number;
  propertyValue: number;
  requestedLoanAmount: number;
  ltv: number;
  indicativeDscr: number | null;
  indicativeRate?: string;
  indicativeTerm?: string;
  preScreenResult: 'fits_program' | 'marginal' | 'outside_parameters';
  contactPhone: string;
  contactEmail: string;
  conversationId: string;
  createdByAgent: boolean;
}

/** Settlement file (Eureka) */
export interface SettlementFile {
  fileId: string;
  transactionType: string;
  parties: SettlementParty[];
  assets: SettlementAsset[];
  targetClosingDate: Date | null;
  checklist: ChecklistItem[];
  status: 'draft' | 'pending_docs' | 'ready_to_close' | 'closing' | 'settled';
  coordinatorAssigned: string | null;
  conversationId: string;
  createdByAgent: boolean;
}

export interface SettlementParty {
  name: string;
  role: 'buyer' | 'seller' | 'lender' | 'borrower';
  assetType: 'fiat' | 'metal' | 'crypto';
  custodian?: string;
  verified: boolean;
}

export interface SettlementAsset {
  type: 'fiat' | 'metal' | 'crypto';
  description: string;
  quantity: number;
  unit: string;
  vaultId?: string;
  value: number;
  currency: string;
}

export interface ChecklistItem {
  item: string;
  party: string;
  required: boolean;
  completed: boolean;
  dueDate?: Date;
}

/** Custody instruction (Constitutional Tender) */
export interface CustodyInstruction {
  instructionId: string;
  type: 'allocate' | 'release' | 'transfer' | 'lock' | 'unlock';
  customerId: string;
  metal: string;
  quantity: number;
  sourceVaultId?: string;
  destinationVaultId?: string;
  reason: string;
  status: 'pending' | 'confirmed' | 'rejected';
  custodianRef: string | null;
  requiresHumanApproval: boolean;
  conversationId: string;
  createdByAgent: boolean;
}

/** Wire instruction (IFSE) */
export interface WireInstruction {
  wireId: string;
  customerId: string;
  beneficiaryName: string;
  beneficiaryCountry: string;
  beneficiaryBank: string;
  beneficiaryAccount: string;
  amount: number;
  currency: string;
  fxRate?: number;
  fee: number;
  sanctionsCleared: boolean;
  jpmRef?: string;
  status: 'pending_compliance' | 'approved' | 'submitted' | 'settled' | 'rejected';
  conversationId: string;
  createdByAgent: boolean;
}

// ============================================================================
// Audit Event (Spec Section 5 — Event Bus)
// ============================================================================

export interface AuditEvent {
  eventId: string;
  timestamp: Date;
  conversationId: string;
  model: CalcModel;
  eventType: AuditEventType;
  authTier: AuthTier;
  customerId: string | null;
  intent: Intent | null;
  action: string | null;
  result: string | null;
  metadata: Record<string, unknown>;
  createdByAgent: boolean;
}

export type AuditEventType =
  | 'call_started'
  | 'call_ended'
  | 'auth_upgraded'
  | 'auth_failed'
  | 'intent_detected'
  | 'action_executed'
  | 'action_failed'
  | 'escalation'
  | 'compliance_gate_pass'
  | 'compliance_gate_fail'
  | 'opt_out'
  | 'pii_detected'
  | 'sanctions_flag'
  | 'recording_consent_granted'
  | 'recording_consent_denied'
  | 'disclosure_delivered'
  | 'human_handoff'
  | 'order_created'
  | 'transfer_initiated'
  | 'lead_captured'
  | 'settlement_created'
  | 'tool_executed'
  | 'tool_error';
