/**
 * Service Contracts — API interfaces for all action services
 *
 * Maps to Spec Section 1 Component 4 (Action Services) and
 * Section 3 (Use Cases) integration points.
 *
 * Each service is a thin interface that the voice agent orchestrator
 * calls via tool-calling through the LLM. Implementations connect
 * to the actual microservices (Nymbus, LoanPro, JPM, custodians, etc.)
 */

import type {
  MetalOrder,
  TransferRequest,
  LoanApplicationLead,
  SettlementFile,
  CustodyInstruction,
  WireInstruction,
  ChecklistItem,
} from '../types.js';

// ============================================================================
// DMC Banking Services (Nymbus + Payment Ops)
// ============================================================================

export interface INymbusService {
  /** Get all account balances for a customer */
  getAccountBalances(customerId: string): Promise<AccountBalance[]>;

  /** Get recent transactions */
  getRecentTransactions(
    customerId: string,
    accountId: string,
    limit?: number
  ): Promise<Transaction[]>;

  /** Get debit card status */
  getCardStatus(customerId: string): Promise<CardStatus>;

  /** Get whitelisted payees for bill pay */
  getPayees(customerId: string): Promise<Payee[]>;

  /** Schedule a bill payment (Tier 2+ required) */
  scheduleBillPay(params: BillPayParams): Promise<BillPayResult>;

  /** Get scheduled payments */
  getScheduledPayments(customerId: string): Promise<ScheduledPayment[]>;

  /** Get customer's payment methods */
  getPaymentMethods(customerId: string): Promise<PaymentMethod[]>;

  /** Get settlement account for proceeds deposit */
  getSettlementAccount(customerId: string): Promise<AccountInfo>;
}

export interface AccountBalance {
  accountId: string;
  type: 'checking' | 'savings' | 'money_market';
  last4: string;
  availableBalance: number;
  currentBalance: number;
  currency: string;
  asOf: Date;
}

export interface Transaction {
  transactionId: string;
  date: Date;
  description: string;
  amount: number;
  type: 'debit' | 'credit';
  status: 'posted' | 'pending';
  category?: string;
}

export interface CardStatus {
  last4: string;
  status: 'active' | 'frozen' | 'lost_reported' | 'stolen_reported' | 'replacement_pending';
  replacementMailedDate?: Date;
  expirationDate: string;
}

export interface Payee {
  payeeId: string;
  name: string;
  accountLast4?: string;
  whitelisted: boolean;
}

export interface BillPayParams {
  customerId: string;
  payeeId: string;
  fromAccountId: string;
  amount: number;
  scheduledDate: Date;
  memo?: string;
  conversationId: string;
}

export interface BillPayResult {
  confirmationId: string;
  status: 'scheduled' | 'failed';
  scheduledDate: Date;
  amount: number;
  errorMessage?: string;
}

export interface ScheduledPayment {
  confirmationId: string;
  payeeName: string;
  amount: number;
  scheduledDate: Date;
  status: 'scheduled' | 'processing' | 'completed' | 'failed';
}

export interface PaymentMethod {
  methodId: string;
  type: 'ach' | 'card' | 'wire';
  last4: string;
  isDefault: boolean;
}

export interface AccountInfo {
  accountId: string;
  type: string;
  last4: string;
  routingNumber?: string;
}

// ============================================================================
// IFSE Treasury / FX Services (JPM)
// ============================================================================

export interface IIFSEService {
  /** Check if a transfer corridor is supported */
  getCorridorStatus(
    originCountry: string,
    destCountry: string
  ): Promise<CorridorStatus>;

  /** Get FX quote */
  getFXQuote(
    fromCurrency: string,
    toCurrency: string,
    amount: number
  ): Promise<FXQuote>;

  /** Create wire request (queues for compliance review) */
  createWireRequest(params: WireRequestParams): Promise<WireInstruction>;

  /** Get today's FX exposure (staff only) */
  getFXExposure(date: Date): Promise<FXExposure>;

  /** List pending wires (staff only) */
  getPendingWires(): Promise<PendingWire[]>;

  /** Get settlement queue status (staff only) */
  getSettlementQueueStatus(): Promise<SettlementQueueStatus>;

  /** Generate reconciliation report (staff only) */
  generateReconReport(date: Date): Promise<ReconReport>;
}

export interface CorridorStatus {
  supported: boolean;
  currencies: string[];
  estimatedDelivery: string;
  restrictions?: string[];
}

export interface FXQuote {
  quoteId: string;
  fromCurrency: string;
  toCurrency: string;
  rate: number;
  inverseRate: number;
  amount: number;
  convertedAmount: number;
  fee: number;
  totalDebit: number;
  validUntil: Date;
  timestamp: Date;
}

export interface WireRequestParams {
  customerId: string;
  beneficiaryName: string;
  beneficiaryCountry: string;
  beneficiaryBank: string;
  beneficiaryAccount: string;
  amount: number;
  fromCurrency: string;
  toCurrency: string;
  fxQuoteId?: string;
  conversationId: string;
}

export interface FXExposure {
  date: Date;
  positions: Array<{
    currency: string;
    direction: 'long' | 'short';
    amount: number;
    usdEquivalent: number;
  }>;
  netExposureUsd: number;
  largestPosition: { currency: string; amount: number };
}

export interface PendingWire {
  wireId: string;
  beneficiaryName: string;
  country: string;
  amount: number;
  currency: string;
  status: string;
  submittedAt: Date;
  awaitingComplianceReview: boolean;
}

export interface SettlementQueueStatus {
  totalPending: number;
  closingToday: number;
  awaitingCustodianConfirmation: number;
  totalValue: number;
  blockersFlagged: boolean;
  blockerDetails?: string[];
}

export interface ReconReport {
  date: Date;
  itemsMatched: number;
  breaksIdentified: number;
  largestBreak: { amount: number; account: string } | null;
  reportUrl: string;
}

// ============================================================================
// Sanctions / AML Service
// ============================================================================

export interface ISanctionsService {
  /** Screen a beneficiary against sanctions lists */
  screenBeneficiary(
    name: string,
    country: string
  ): Promise<SanctionsResult>;

  /** Screen a transaction for AML patterns */
  screenTransaction(params: AMLScreenParams): Promise<AMLResult>;
}

export interface SanctionsResult {
  cleared: boolean;
  /** If not cleared, DO NOT reveal reason to customer */
  matchType?: 'exact' | 'fuzzy' | 'country_block';
  listSource?: string;
  requiresManualReview: boolean;
}

export interface AMLScreenParams {
  customerId: string;
  amount: number;
  currency: string;
  counterpartyCountry: string;
  transactionType: string;
}

export interface AMLResult {
  cleared: boolean;
  riskScore: number;
  flags: string[];
  requiresManualReview: boolean;
}

// ============================================================================
// Constitutional Tender — Pricing & Orders
// ============================================================================

export interface IPricingService {
  /** Get current spot price */
  getSpotPrice(
    metal: 'gold' | 'silver' | 'platinum',
    currency?: string
  ): Promise<SpotPrice>;

  /** Lock a price for 30 seconds */
  lockPrice(params: PriceLockParams): Promise<PriceLock>;

  /** Get bid price for selling */
  getBidPrice(
    metal: 'gold' | 'silver' | 'platinum',
    quantity: number
  ): Promise<BidPrice>;
}

export interface SpotPrice {
  metal: string;
  price: number;
  currency: string;
  timestamp: Date;
  change24h: number;
  changePct24h: number;
}

export interface PriceLockParams {
  metal: string;
  product: string;
  quantity: number;
  type: 'vault_allocation' | 'physical_delivery';
  vaultId?: string;
}

export interface PriceLock {
  lockId: string;
  spotPrice: number;
  spreadAmount: number;
  facilityFee: number;
  deliveryFee: number;
  totalPrice: number;
  expiresAt: Date;
  timestamp: Date;
}

export interface BidPrice {
  metal: string;
  bidPerOz: number;
  quantity: number;
  grossProceeds: number;
  facilityFee: number;
  netProceeds: number;
  timestamp: Date;
  validForSeconds: number;
}

export interface IWholesalerService {
  /** Check product availability */
  checkAvailability(product: string, quantity: number): Promise<Availability>;

  /** Execute back-to-back order */
  executeOrder(params: WholesalerOrderParams): Promise<WholesalerOrder>;
}

export interface Availability {
  available: boolean;
  product: string;
  maxQuantity: number;
  estimatedDelivery?: string;
}

export interface WholesalerOrderParams {
  product: string;
  quantity: number;
  priceLockId: string;
  deliveryType: 'vault' | 'customer';
  destinationId: string;
}

export interface WholesalerOrder {
  orderId: string;
  confirmationNumber: string;
  trackingNumber?: string;
  status: 'confirmed' | 'failed';
  estimatedDelivery: string;
}

// ============================================================================
// Custodian Services (TxBD, Brink's, Malca-Amit, SWP)
// ============================================================================

export interface ICustodianService {
  /** Get vault options for a customer */
  getVaultOptions(customerId: string): Promise<VaultOption[]>;

  /** Get holdings at a specific vault */
  getHoldings(customerId: string, vaultId?: string): Promise<Holding[]>;

  /** Check if metals are encumbered (TILT collateral) */
  getEncumbranceStatus(customerId: string, metalId: string): Promise<EncumbranceStatus>;

  /** Request lock on metal (pending liquidation/transfer) */
  requestLock(params: CustodyLockParams): Promise<CustodyLockResult>;

  /** Get lock status */
  getLockStatus(lockId: string): Promise<CustodyLockStatus>;

  /** Validate transfer route between vaults */
  validateTransferRoute(sourceVault: string, destVault: string): Promise<TransferRoute>;

  /** Create transfer request (book-entry / Teleport) */
  createTransferRequest(params: CustodyTransferParams): Promise<CustodyInstruction>;

  /** Get fee estimate for vault-to-vault transfer */
  getTransferFeeEstimate(
    sourceVault: string,
    destVault: string,
    quantity: number,
    metal: string
  ): Promise<TransferFeeEstimate>;
}

export interface VaultOption {
  vaultId: string;
  name: string;
  location: string;
  country: string;
  custodian: string;
  supportedMetals: string[];
  allocationFee: number;
  storageFeeAnnual: number;
  insuranceIncluded: boolean;
}

export interface Holding {
  holdingId: string;
  metal: string;
  product: string;
  quantity: number;
  vaultId: string;
  vaultName: string;
  allocatedDate: Date;
  encumbered: boolean;
  encumbranceReason?: string;
  currentValue: number;
  currency: string;
}

export interface EncumbranceStatus {
  encumbered: boolean;
  reason?: string;
  loanId?: string;
  unencumberedQuantity: number;
}

export interface CustodyLockParams {
  customerId: string;
  holdingId: string;
  reason: 'pending_liquidation' | 'pending_transfer' | 'pending_delivery';
  conversationId: string;
}

export interface CustodyLockResult {
  lockId: string;
  status: 'locked' | 'failed';
  expiresAt: Date;
  errorMessage?: string;
}

export interface CustodyLockStatus {
  lockId: string;
  status: 'active' | 'expired' | 'released';
  lockedAt: Date;
  expiresAt: Date;
}

export interface TransferRoute {
  supported: boolean;
  intermediateVault?: string;
  estimatedDays: number;
  restrictions?: string[];
}

export interface CustodyTransferParams {
  customerId: string;
  holdingId: string;
  sourceVaultId: string;
  destinationVaultId: string;
  quantity: number;
  metal: string;
  conversationId: string;
}

export interface TransferFeeEstimate {
  feeAmount: number;
  feePercentage: number;
  estimatedDays: number;
  sourceVault: string;
  destinationVault: string;
}

// ============================================================================
// TILT Lending Services (LoanPro + CRM)
// ============================================================================

export interface ITILTService {
  /** Calculate indicative DSCR */
  calculateIndicativeDSCR(params: DSCRParams): Promise<DSCRResult>;

  /** Create lead in CRM / underwriting queue */
  createLead(lead: Omit<LoanApplicationLead, 'leadId'>): Promise<LoanApplicationLead>;

  /** Check if caller is an existing borrower */
  getExistingBorrower(phoneOrEmail: string): Promise<BorrowerInfo | null>;

  /** Get loan programs and eligibility criteria */
  getLoanPrograms(): Promise<LoanProgram[]>;
}

export interface ILoanProService {
  /** Get loan details */
  getLoanDetails(borrowerId: string): Promise<LoanDetails>;

  /** Get payment schedule */
  getPaymentSchedule(loanId: string): Promise<PaymentScheduleEntry[]>;

  /** Get payoff quote */
  getPayoffQuote(loanId: string): Promise<PayoffQuote>;

  /** Get escrow balance */
  getEscrowBalance(loanId: string): Promise<EscrowBalance>;

  /** Get payment status */
  getPaymentStatus(paymentId: string): Promise<PaymentStatus>;
}

export interface DSCRParams {
  noi: number;
  loanAmount: number;
  estimatedRate?: number;
  termYears?: number;
}

export interface DSCRResult {
  dscr: number;
  ltv: number;
  monthlyPaymentEstimate: number;
  fitsProgram: boolean;
  suggestedProgram?: string;
  indicativeRateRange?: string;
  indicativeTermRange?: string;
}

export interface BorrowerInfo {
  borrowerId: string;
  name: string;
  company?: string;
  existingLoans: number;
  brokerAccount: boolean;
}

export interface LoanProgram {
  programId: string;
  name: string;
  minDSCR: number;
  maxLTV: number;
  rateRange: string;
  termRange: string;
  propertyTypes: string[];
  minLoanAmount: number;
  maxLoanAmount: number;
}

export interface LoanDetails {
  loanId: string;
  borrowerName: string;
  originalAmount: number;
  currentBalance: number;
  rate: number;
  term: string;
  maturityDate: Date;
  status: 'current' | 'past_due' | 'default' | 'paid_off';
  daysPastDue: number;
  nextPaymentAmount: number;
  nextPaymentDate: Date;
}

export interface PaymentScheduleEntry {
  dueDate: Date;
  totalAmount: number;
  principal: number;
  interest: number;
  escrow: number;
  status: 'scheduled' | 'paid' | 'past_due';
}

export interface PayoffQuote {
  loanId: string;
  quoteDate: Date;
  validThrough: Date;
  principalBalance: number;
  accruedInterest: number;
  fees: number;
  totalPayoffAmount: number;
}

export interface EscrowBalance {
  balance: number;
  items: string[];
  nextAnalysisDate: Date;
}

export interface PaymentStatus {
  paymentId: string;
  amount: number;
  date: Date;
  status: 'received' | 'processing' | 'applied' | 'returned';
}

// ============================================================================
// Eureka Settlement Services
// ============================================================================

export interface IEurekaService {
  /** Create a new settlement file */
  createSettlementFile(params: SettlementFileParams): Promise<SettlementFile>;

  /** Get settlement file status */
  getSettlementStatus(fileId: string): Promise<SettlementFile>;

  /** Generate closing checklist */
  generateChecklist(fileId: string): Promise<ChecklistItem[]>;

  /** Get party requirements for a transaction type */
  getPartyRequirements(transactionType: string): Promise<PartyRequirement[]>;
}

export interface SettlementFileParams {
  transactionType: string;
  parties: Array<{
    name: string;
    role: 'buyer' | 'seller' | 'lender' | 'borrower';
    assetType: 'fiat' | 'metal' | 'crypto';
    custodian?: string;
  }>;
  assets: Array<{
    type: 'fiat' | 'metal' | 'crypto';
    description: string;
    quantity: number;
    unit: string;
    vaultId?: string;
  }>;
  targetClosingDate?: Date;
  conversationId: string;
}

export interface PartyRequirement {
  requirement: string;
  party: string;
  documentType: string;
  mandatory: boolean;
}

// ============================================================================
// CRM — Unified Interface (delegates to HubSpot or GoHighLevel)
// ============================================================================

/**
 * Unified CRM interface consumed by the voice agent orchestrator.
 * Implementations delegate to either HubSpot or GoHighLevel based
 * on model configuration:
 *
 *   DMC, IFSE           → HubSpot (enterprise CRM, reporting, sequences)
 *   TILT, CT, Eureka    → GoHighLevel (pipeline automation, speed-to-lead,
 *                          SMS/voice workflows, booking)
 *
 * Both adapters implement this interface so the orchestrator and prompt
 * templates are CRM-agnostic.
 */
export interface ICRMService {
  // --- Contacts ---
  createContact(params: CRMContactParams): Promise<CRMContact>;
  getContact(contactId: string): Promise<CRMContact | null>;
  getContactByPhone(phone: string): Promise<CRMContact | null>;
  getContactByEmail(email: string): Promise<CRMContact | null>;
  updateContact(contactId: string, updates: Partial<CRMContactParams>): Promise<CRMContact>;

  // --- Deals / Opportunities ---
  createDeal(params: CRMDealParams): Promise<CRMDeal>;
  getDeal(dealId: string): Promise<CRMDeal | null>;
  updateDealStage(dealId: string, stage: string): Promise<CRMDeal>;
  getDealsForContact(contactId: string): Promise<CRMDeal[]>;

  // --- Leads / Pipeline ---
  createLead(params: CRMLeadParams): Promise<CRMLead>;
  qualifyLead(leadId: string, qualification: LeadQualification): Promise<CRMLead>;
  assignLead(leadId: string, ownerId: string): Promise<void>;

  // --- Tasks / Tickets ---
  createTask(params: CRMTaskParams): Promise<CRMTask>;
  createTicket(params: TicketParams): Promise<Ticket>;
  getTicketStatus(ticketId: string): Promise<Ticket>;

  // --- Notes / Activity ---
  addNote(contactId: string, note: CRMNoteParams): Promise<CRMNote>;
  logCall(params: CRMCallLogParams): Promise<string>;
  getActivityTimeline(contactId: string, limit?: number): Promise<CRMActivity[]>;

  // --- Automations ---
  enrollInSequence(contactId: string, sequenceId: string): Promise<void>;
  removeFromSequence(contactId: string, sequenceId: string): Promise<void>;
  triggerWorkflow(contactId: string, workflowId: string, data?: Record<string, unknown>): Promise<void>;

  // --- Appointments ---
  getAvailableSlots(calendarId: string, date: Date): Promise<TimeSlot[]>;
  bookAppointment(params: AppointmentParams): Promise<Appointment>;
  cancelAppointment(appointmentId: string, reason?: string): Promise<void>;

  // --- Tags / Lists ---
  addTag(contactId: string, tag: string): Promise<void>;
  removeTag(contactId: string, tag: string): Promise<void>;
  addToList(contactId: string, listId: string): Promise<void>;

  // --- Search / FAQ ---
  searchContacts(query: string, limit?: number): Promise<CRMContact[]>;
  searchFAQ(query: string): Promise<FAQResult[]>;

  // --- Compliance ---
  flagAccount(contactId: string, flag: string): Promise<void>;
  recordConsent(contactId: string, consent: CRMConsentRecord): Promise<void>;
  getConsentHistory(contactId: string): Promise<CRMConsentRecord[]>;
}

// --- CRM Data Types ---

export interface CRMContact {
  contactId: string;
  source: 'hubspot' | 'gohighlevel';
  externalId: string;           // HubSpot vid or GHL contactId
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  title: string | null;
  address: CRMAddress | null;
  lifecycle: string;            // subscriber, lead, mql, sql, opportunity, customer, evangelist
  leadSource: string | null;    // web, arbor, costar, referral, event, voice_agent
  owner: string | null;
  tags: string[];
  customFields: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CRMContactParams {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  address?: CRMAddress;
  lifecycle?: string;
  leadSource?: string;
  owner?: string;
  tags?: string[];
  customFields?: Record<string, unknown>;
  conversationId?: string;
  createdByAgent?: boolean;
}

export interface CRMAddress {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

export interface CRMDeal {
  dealId: string;
  source: 'hubspot' | 'gohighlevel';
  externalId: string;
  contactId: string;
  name: string;
  pipeline: string;
  stage: string;
  amount: number;
  currency: string;
  probability: number;
  closeDate: Date | null;
  owner: string | null;
  properties: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CRMDealParams {
  contactId: string;
  name: string;
  pipeline: string;
  stage: string;
  amount: number;
  currency?: string;
  closeDate?: Date;
  owner?: string;
  properties?: Record<string, unknown>;
  conversationId?: string;
  createdByAgent?: boolean;
}

export interface CRMLead {
  leadId: string;
  contactId: string;
  source: string;
  status: 'new' | 'contacted' | 'qualified' | 'unqualified' | 'nurture';
  score: number;
  qualification: LeadQualification | null;
  assignedTo: string | null;
  firstContactedAt: Date | null;
  lastContactedAt: Date | null;
  responseTimeMs: number | null;  // Speed-to-lead tracking
  createdAt: Date;
}

export interface CRMLeadParams {
  contactId: string;
  source: 'web_inbound' | 'arbor' | 'costar' | 'referral' | 'event' | 'voice_agent' | 'cross_sell';
  pipeline?: string;
  initialStage?: string;
  score?: number;
  conversationId?: string;
  createdByAgent?: boolean;
  /** For speed-to-lead tracking: when did the lead come in? */
  leadCreatedAt?: Date;
}

export interface LeadQualification {
  budget: string | null;
  authority: string | null;
  need: string | null;
  timeline: string | null;
  score: number;
  notes: string;
  qualifiedBy: 'voice_agent' | 'human';
}

export interface CRMTask {
  taskId: string;
  contactId: string;
  title: string;
  description: string;
  dueDate: Date;
  priority: 'low' | 'medium' | 'high';
  status: 'open' | 'in_progress' | 'completed';
  assignedTo: string | null;
}

export interface CRMTaskParams {
  contactId: string;
  title: string;
  description: string;
  dueDate?: Date;
  priority?: 'low' | 'medium' | 'high';
  assignedTo?: string;
  conversationId?: string;
}

export interface TicketParams {
  customerId?: string;
  contactId?: string;
  category: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  conversationId: string;
}

export interface Ticket {
  ticketId: string;
  status: 'open' | 'in_progress' | 'resolved' | 'closed';
  createdAt: Date;
  updatedAt: Date;
  assignee?: string;
}

export interface CRMNote {
  noteId: string;
  contactId: string;
  body: string;
  createdAt: Date;
  createdBy: string;
}

export interface CRMNoteParams {
  body: string;
  conversationId?: string;
  createdByAgent?: boolean;
}

export interface CRMCallLogParams {
  contactId: string;
  direction: 'inbound' | 'outbound';
  durationMs: number;
  outcome: 'connected' | 'voicemail' | 'no_answer' | 'busy';
  notes: string;
  recordingUrl?: string;
  conversationId: string;
  pipeline?: PipelineMode;
  llmProvider?: string;
  compliancePass?: boolean;
}

type PipelineMode = 'modular' | 'speech-to-speech';

export interface CRMActivity {
  activityId: string;
  type: 'call' | 'email' | 'note' | 'task' | 'meeting' | 'deal_stage_change' | 'form_submission';
  timestamp: Date;
  summary: string;
  metadata: Record<string, unknown>;
}

export interface TimeSlot {
  start: Date;
  end: Date;
  available: boolean;
  calendarId: string;
}

export interface AppointmentParams {
  contactId: string;
  calendarId: string;
  startTime: Date;
  endTime: Date;
  title: string;
  notes?: string;
  conversationId?: string;
  createdByAgent?: boolean;
}

export interface Appointment {
  appointmentId: string;
  contactId: string;
  calendarId: string;
  startTime: Date;
  endTime: Date;
  title: string;
  status: 'scheduled' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  meetingUrl?: string;   // GHL auto-generates Zoom/Meet links
  confirmationSent: boolean;
}

export interface CRMConsentRecord {
  type: 'ai_call' | 'sms' | 'email' | 'recording';
  granted: boolean;
  timestamp: Date;
  method: 'web_form' | 'verbal' | 'electronic_signature';
  conversationId?: string;
}

export interface FAQResult {
  question: string;
  answer: string;
  relevanceScore: number;
}

// ============================================================================
// HubSpot — Platform-Specific Interface
// ============================================================================

/**
 * HubSpot-specific operations not covered by the unified CRM interface.
 * Used for DMC and IFSE where HubSpot's enterprise features matter:
 *   - Marketing Hub sequences + workflows
 *   - Reporting dashboards
 *   - Custom objects for financial entities
 *   - API: https://developers.hubspot.com/docs/api/overview
 *
 * Auth: OAuth 2.0 or Private App token
 * Rate limits: 100 requests/10 sec (private app), 500K/day
 */
export interface IHubSpotService {
  // --- Contacts (CRM v3) ---
  createContact(params: HubSpotContactParams): Promise<HubSpotContact>;
  getContact(contactId: string): Promise<HubSpotContact | null>;
  searchContacts(filters: HubSpotSearchFilter[]): Promise<HubSpotContact[]>;
  updateContact(contactId: string, properties: Record<string, string>): Promise<HubSpotContact>;
  mergeContacts(primaryId: string, secondaryId: string): Promise<void>;

  // --- Deals ---
  createDeal(params: HubSpotDealParams): Promise<HubSpotDeal>;
  getDeal(dealId: string): Promise<HubSpotDeal | null>;
  updateDeal(dealId: string, properties: Record<string, string>): Promise<HubSpotDeal>;
  getDealsByPipeline(pipelineId: string, stage?: string): Promise<HubSpotDeal[]>;

  // --- Engagement / Activities ---
  createEngagement(params: HubSpotEngagementParams): Promise<string>;
  logCall(params: HubSpotCallParams): Promise<string>;
  logEmail(params: HubSpotEmailParams): Promise<string>;
  createNote(contactId: string, body: string): Promise<string>;

  // --- Tickets (Service Hub) ---
  createTicket(params: HubSpotTicketParams): Promise<HubSpotTicket>;
  getTicket(ticketId: string): Promise<HubSpotTicket | null>;
  updateTicket(ticketId: string, properties: Record<string, string>): Promise<HubSpotTicket>;

  // --- Sequences (Marketing Hub) ---
  enrollContactInSequence(contactId: string, sequenceId: string, senderId: string): Promise<void>;
  unenrollContactFromSequence(contactId: string, sequenceId: string): Promise<void>;

  // --- Workflows ---
  enrollContactInWorkflow(contactId: string, workflowId: string): Promise<void>;

  // --- Custom Objects (for financial entities) ---
  createCustomObject(objectType: string, properties: Record<string, string>): Promise<string>;
  getCustomObject(objectType: string, objectId: string): Promise<Record<string, unknown> | null>;
  associateObjects(fromType: string, fromId: string, toType: string, toId: string, associationType: string): Promise<void>;

  // --- Pipelines ---
  getPipelines(objectType: 'deals' | 'tickets'): Promise<HubSpotPipeline[]>;
  getPipelineStages(pipelineId: string): Promise<HubSpotPipelineStage[]>;

  // --- Lists ---
  addContactToList(contactId: string, listId: string): Promise<void>;
  removeContactFromList(contactId: string, listId: string): Promise<void>;

  // --- Properties ---
  getPropertyDefinition(objectType: string, propertyName: string): Promise<HubSpotProperty | null>;
}

export interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
  createdAt: Date;
  updatedAt: Date;
  associations?: Record<string, string[]>;
}

export interface HubSpotContactParams {
  email?: string;
  phone?: string;
  firstname: string;
  lastname: string;
  company?: string;
  jobtitle?: string;
  lifecyclestage?: string;
  hs_lead_status?: string;
  /** Custom properties for Calculus models */
  calculus_model?: string;          // DMC, CT, TILT, EUREKA
  calculus_customer_id?: string;
  calculus_auth_tier?: string;
  calculus_vault_customer?: string;
  calculus_loan_borrower?: string;
  [key: string]: string | undefined;
}

export interface HubSpotDeal {
  id: string;
  properties: Record<string, string | null>;
  createdAt: Date;
  updatedAt: Date;
  associations?: Record<string, string[]>;
}

export interface HubSpotDealParams {
  dealname: string;
  pipeline: string;
  dealstage: string;
  amount?: string;
  closedate?: string;
  hubspot_owner_id?: string;
  /** Custom deal properties */
  calculus_model?: string;
  calculus_deal_type?: string;     // metal_purchase, metal_sale, loan, settlement
  calculus_conversation_id?: string;
  calculus_created_by_agent?: string;
  [key: string]: string | undefined;
}

export interface HubSpotEngagementParams {
  type: 'NOTE' | 'CALL' | 'EMAIL' | 'TASK' | 'MEETING';
  contactIds: string[];
  dealIds?: string[];
  body: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface HubSpotCallParams {
  contactId: string;
  dealId?: string;
  body: string;
  durationMs: number;
  disposition: string;       // connected, no_answer, busy, voicemail
  direction: 'INBOUND' | 'OUTBOUND';
  recordingUrl?: string;
  /** Voice agent metadata */
  calculus_pipeline_mode?: string;
  calculus_llm_provider?: string;
  calculus_compliance_pass?: string;
}

export interface HubSpotEmailParams {
  contactId: string;
  subject: string;
  body: string;
  direction: 'INCOMING_EMAIL' | 'FORWARDED_EMAIL';
}

export interface HubSpotTicket {
  id: string;
  properties: Record<string, string | null>;
  createdAt: Date;
  updatedAt: Date;
}

export interface HubSpotTicketParams {
  subject: string;
  content: string;
  hs_pipeline: string;
  hs_pipeline_stage: string;
  hs_ticket_priority: 'LOW' | 'MEDIUM' | 'HIGH';
  hubspot_owner_id?: string;
  contactId?: string;
}

export interface HubSpotPipeline {
  id: string;
  label: string;
  stages: HubSpotPipelineStage[];
}

export interface HubSpotPipelineStage {
  id: string;
  label: string;
  displayOrder: number;
  metadata: Record<string, string>;
}

export interface HubSpotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  options?: Array<{ label: string; value: string }>;
}

export interface HubSpotSearchFilter {
  propertyName: string;
  operator: 'EQ' | 'NEQ' | 'LT' | 'LTE' | 'GT' | 'GTE' | 'CONTAINS_TOKEN' | 'HAS_PROPERTY';
  value: string;
}

// ============================================================================
// GoHighLevel (GHL) — Platform-Specific Interface
// ============================================================================

/**
 * GoHighLevel-specific operations. GHL is the primary CRM for
 * revenue-generating models (TILT, Constitutional Tender, Eureka)
 * because of its:
 *   - Built-in speed-to-lead automation (instant callback workflows)
 *   - Native voice/SMS/email from same platform
 *   - Pipeline automation with trigger-based stage transitions
 *   - Appointment booking with calendar integration
 *   - Conversation AI (can augment our voice agent for SMS follow-ups)
 *
 * API: https://highlevel.stoplight.io/docs/integrations
 * Auth: OAuth 2.0 (Agency or Sub-Account level)
 * Rate limits: 100 requests/10 sec per sub-account
 *
 * GHL Location = Calculus sub-account per model:
 *   - Location 1: Constitutional Tender
 *   - Location 2: TILT Lending
 *   - Location 3: Eureka Settlement
 */
export interface IGHLService {
  // --- Contacts ---
  createContact(locationId: string, params: GHLContactParams): Promise<GHLContact>;
  getContact(locationId: string, contactId: string): Promise<GHLContact | null>;
  getContactByPhone(locationId: string, phone: string): Promise<GHLContact | null>;
  getContactByEmail(locationId: string, email: string): Promise<GHLContact | null>;
  updateContact(locationId: string, contactId: string, params: Partial<GHLContactParams>): Promise<GHLContact>;
  searchContacts(locationId: string, query: string, limit?: number): Promise<GHLContact[]>;
  addTag(locationId: string, contactId: string, tag: string): Promise<void>;
  removeTag(locationId: string, contactId: string, tag: string): Promise<void>;

  // --- Opportunities (Deals/Pipeline) ---
  createOpportunity(locationId: string, params: GHLOpportunityParams): Promise<GHLOpportunity>;
  getOpportunity(locationId: string, opportunityId: string): Promise<GHLOpportunity | null>;
  updateOpportunity(locationId: string, opportunityId: string, params: Partial<GHLOpportunityParams>): Promise<GHLOpportunity>;
  getOpportunitiesByPipeline(locationId: string, pipelineId: string, stageId?: string): Promise<GHLOpportunity[]>;
  moveOpportunityStage(locationId: string, opportunityId: string, stageId: string): Promise<GHLOpportunity>;

  // --- Pipelines ---
  getPipelines(locationId: string): Promise<GHLPipeline[]>;

  // --- Conversations / Messaging ---
  sendSMS(locationId: string, params: GHLSMSParams): Promise<GHLMessage>;
  sendEmail(locationId: string, params: GHLEmailParams): Promise<GHLMessage>;
  getConversation(locationId: string, contactId: string): Promise<GHLConversation | null>;
  addInboundMessage(locationId: string, params: GHLInboundMessageParams): Promise<void>;

  // --- Calendars / Appointments ---
  getCalendars(locationId: string): Promise<GHLCalendar[]>;
  getAvailableSlots(locationId: string, calendarId: string, startDate: Date, endDate: Date): Promise<GHLTimeSlot[]>;
  bookAppointment(locationId: string, params: GHLAppointmentParams): Promise<GHLAppointment>;
  getAppointment(locationId: string, appointmentId: string): Promise<GHLAppointment | null>;
  updateAppointment(locationId: string, appointmentId: string, params: Partial<GHLAppointmentParams>): Promise<GHLAppointment>;
  cancelAppointment(locationId: string, appointmentId: string): Promise<void>;

  // --- Tasks ---
  createTask(locationId: string, params: GHLTaskParams): Promise<GHLTask>;
  getTasks(locationId: string, contactId: string): Promise<GHLTask[]>;
  updateTask(locationId: string, taskId: string, params: Partial<GHLTaskParams>): Promise<GHLTask>;

  // --- Notes ---
  createNote(locationId: string, contactId: string, body: string): Promise<GHLNote>;
  getNotes(locationId: string, contactId: string): Promise<GHLNote[]>;

  // --- Workflows (Automations) ---
  addContactToWorkflow(locationId: string, contactId: string, workflowId: string): Promise<void>;
  removeContactFromWorkflow(locationId: string, contactId: string, workflowId: string): Promise<void>;

  // --- Custom Fields / Values ---
  getCustomFields(locationId: string): Promise<GHLCustomField[]>;
  updateCustomFieldValue(locationId: string, contactId: string, fieldId: string, value: string): Promise<void>;

  // --- Call Tracking ---
  logCall(locationId: string, params: GHLCallLogParams): Promise<string>;

  // --- Forms & Surveys ---
  getFormSubmissions(locationId: string, formId: string, limit?: number): Promise<GHLFormSubmission[]>;
}

// --- GHL Data Types ---

export interface GHLContact {
  id: string;
  locationId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  address1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  source: string | null;
  tags: string[];
  customFields: GHLCustomFieldValue[];
  dateAdded: Date;
  dateUpdated: Date;
  dnd: boolean;                    // Do Not Disturb — respects opt-out
  dndSettings: {
    call: { status: string };
    email: { status: string };
    sms: { status: string };
  };
}

export interface GHLContactParams {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  companyName?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  source?: string;
  tags?: string[];
  customField?: Record<string, string>;
  dnd?: boolean;
}

export interface GHLOpportunity {
  id: string;
  locationId: string;
  contactId: string;
  name: string;
  pipelineId: string;
  pipelineStageId: string;
  status: 'open' | 'won' | 'lost' | 'abandoned';
  monetaryValue: number;
  assignedTo: string | null;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GHLOpportunityParams {
  contactId: string;
  name: string;
  pipelineId: string;
  pipelineStageId: string;
  status?: 'open' | 'won' | 'lost' | 'abandoned';
  monetaryValue?: number;
  assignedTo?: string;
  source?: string;
  /** Voice agent metadata stored as custom fields */
  customFields?: Record<string, string>;
}

export interface GHLPipeline {
  id: string;
  locationId: string;
  name: string;
  stages: GHLPipelineStage[];
}

export interface GHLPipelineStage {
  id: string;
  name: string;
  position: number;
}

export interface GHLSMSParams {
  contactId: string;
  message: string;
  /** Template ID for pre-approved marketing messages */
  templateId?: string;
}

export interface GHLEmailParams {
  contactId: string;
  subject: string;
  body: string;
  html?: string;
}

export interface GHLMessage {
  id: string;
  contactId: string;
  type: 'sms' | 'email' | 'call';
  direction: 'inbound' | 'outbound';
  status: 'sent' | 'delivered' | 'failed' | 'read';
  body: string;
  dateAdded: Date;
}

export interface GHLInboundMessageParams {
  contactId: string;
  type: 'sms' | 'email' | 'call';
  message: string;
  conversationId?: string;
}

export interface GHLCalendar {
  id: string;
  locationId: string;
  name: string;
  description: string;
  isActive: boolean;
}

export interface GHLTimeSlot {
  startTime: Date;
  endTime: Date;
}

export interface GHLAppointment {
  id: string;
  calendarId: string;
  contactId: string;
  title: string;
  startTime: Date;
  endTime: Date;
  status: 'new' | 'confirmed' | 'cancelled' | 'showed' | 'noshow';
  assignedUserId: string | null;
  notes: string | null;
  meetingLocation: string | null;  // Zoom/Meet link auto-generated
}

export interface GHLAppointmentParams {
  calendarId: string;
  contactId: string;
  title: string;
  startTime: Date;
  endTime: Date;
  assignedUserId?: string;
  notes?: string;
}

export interface GHLTask {
  id: string;
  contactId: string;
  title: string;
  body: string;
  dueDate: Date;
  status: 'incompleted' | 'completed';
  assignedTo: string | null;
}

export interface GHLTaskParams {
  contactId: string;
  title: string;
  body?: string;
  dueDate?: Date;
  assignedTo?: string;
}

export interface GHLNote {
  id: string;
  contactId: string;
  body: string;
  dateAdded: Date;
}

export interface GHLCallLogParams {
  contactId: string;
  direction: 'inbound' | 'outbound';
  duration: number;
  status: 'completed' | 'no-answer' | 'busy' | 'voicemail';
  recordingUrl?: string;
  /** Voice agent metadata */
  notes?: string;
}

export interface GHLCustomField {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
}

export interface GHLCustomFieldValue {
  id: string;
  value: string;
}

export interface GHLFormSubmission {
  id: string;
  contactId: string;
  formId: string;
  data: Record<string, string>;
  submittedAt: Date;
}

export interface GHLConversation {
  id: string;
  contactId: string;
  locationId: string;
  lastMessageAt: Date;
  messages: GHLMessage[];
}

// ============================================================================
// Consent & Suppression Database
// ============================================================================

export interface IConsentService {
  /** Look up consent record for a phone number */
  getConsent(phone: string): Promise<ConsentRecord | null>;

  /** Capture new consent */
  captureConsent(params: CaptureConsentParams): Promise<ConsentRecord>;

  /** Revoke consent (opt-out) */
  revokeConsent(phone: string, params: RevocationParams): Promise<void>;

  /** Check DNC status */
  checkDNC(phone: string): Promise<DNCResult>;

  /** Add to suppression list */
  addToSuppression(phone: string, reason: string): Promise<void>;
}

export interface ConsentRecord {
  phone: string;
  customerId?: string;
  aiWrittenConsent: boolean;
  aiConsentTimestamp: Date | null;
  aiConsentSeller: string | null;
  automatedConsent: boolean;
  automatedConsentTimestamp: Date | null;
  recordingConsent: boolean;
  callbackRequested: boolean;
  callbackRequestedAt: Date | null;
  ebrStatus: boolean;
  ebrLastTransaction: Date | null;
  revocationHistory: RevocationEntry[];
  reOptedInAfterLastRevocation: boolean;
}

export interface CaptureConsentParams {
  phone: string;
  customerId?: string;
  consentType: 'ai_written' | 'automated' | 'recording' | 'callback';
  seller: string;
  conversationId: string;
  method: 'web_form' | 'verbal' | 'electronic_signature';
}

export interface RevocationParams {
  conversationId: string;
  method: 'verbal_during_call' | 'sms' | 'email' | 'web';
  scope: 'all_automated' | 'marketing_only';
}

export interface RevocationEntry {
  revokedAt: Date;
  method: string;
  scope: string;
  conversationId: string;
}

export interface DNCResult {
  onNationalDNC: boolean;
  onStateDNC: boolean;
  onInternalSuppression: boolean;
  numberReassigned: boolean;
  reassignedDate?: Date;
}

// ============================================================================
// Audit Service
// ============================================================================

export interface IAuditService {
  /** Log an audit event (append-only) */
  logEvent(event: Omit<import('../types.js').AuditEvent, 'eventId'>): Promise<string>;

  /** Get audit trail for a conversation */
  getConversationAudit(conversationId: string): Promise<import('../types.js').AuditEvent[]>;
}
