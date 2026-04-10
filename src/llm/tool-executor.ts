/**
 * Tool Executor — Service Dispatch
 *
 * When the LLM requests a tool call, this module executes it against
 * the actual service contracts and returns the result.
 *
 * Security:
 *   - Auth tier is checked BEFORE execution (enforced by orchestrator)
 *   - Tool calls are logged to the audit service
 *   - Sensitive data is redacted from logs
 */

import type { Logger } from 'pino';
import type { AuthTier, CalcModel, LoanApplicationLead } from '../types.js';
import type {
  INymbusService,
  IPricingService,
  IWholesalerService,
  ICustodianService,
  ITILTService,
  ILoanProService,
  IEurekaService,
  IIFSEService,
  ISanctionsService,
  ICRMService,
  IConsentService,
  IAuditService,
} from '../services/contracts.js';
import { OpenClawClient, getOpenClawClient, isOpenClawConfigured } from '../services/openclaw-client.js';
import { SwarmGatewayClient, getSwarmGateway, isSwarmConfigured } from '../services/swarm-gateway.js';

// ============================================================================
// Service Registry
// ============================================================================

export interface ServiceRegistry {
  nymbus: INymbusService;
  pricing: IPricingService;
  wholesaler: IWholesalerService;
  custodian: ICustodianService;
  tilt: ITILTService;
  loanpro: ILoanProService;
  eureka: IEurekaService;
  ifse: IIFSEService;
  sanctions: ISanctionsService;
  crm: ICRMService;
  consent: IConsentService;
  audit: IAuditService;
}

// ============================================================================
// Tool Executor
// ============================================================================

export class ToolExecutor {
  private services: ServiceRegistry;
  private logger: Logger;
  private openClaw: OpenClawClient | null = null;
  private swarmGateway: SwarmGatewayClient | null = null;

  constructor(services: ServiceRegistry, logger: Logger) {
    this.services = services;
    this.logger = logger.child({ component: 'ToolExecutor' });

    // Initialize OpenClaw client if configured
    if (isOpenClawConfigured()) {
      this.openClaw = getOpenClawClient(logger);
      this.logger.info('OpenClaw client initialized — extended tool capabilities enabled');
    }

    // Initialize Swarm Gateway client if configured
    if (isSwarmConfigured()) {
      this.swarmGateway = getSwarmGateway(logger);
      this.logger.info('Swarm Gateway client initialized — full swarm ecosystem access enabled');
    }
  }

  /**
   * Execute a tool call. Returns the result to be sent back to the LLM.
   *
   * @param toolName - The tool name from the LLM's function call
   * @param args - The parsed arguments
   * @param context - Call context for auth/audit
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: {
      conversationId: string;
      model: CalcModel;
      authTier: AuthTier;
      customerId: string | null;
    },
  ): Promise<unknown> {
    const startTime = Date.now();

    this.logger.info({
      tool: toolName,
      model: context.model,
      authTier: context.authTier,
    }, 'Executing tool');

    try {
      const result = await this.dispatch(toolName, args, context);

      // Audit log
      await this.services.audit.logEvent({
        timestamp: new Date(),
        conversationId: context.conversationId,
        model: context.model,
        eventType: 'tool_executed',
        authTier: context.authTier,
        customerId: context.customerId,
        intent: null,
        action: toolName,
        result: 'success',
        metadata: {
          args: this.redactSensitive(args),
          durationMs: Date.now() - startTime,
        },
        createdByAgent: true,
      });

      return result;

    } catch (error) {
      this.logger.error({ tool: toolName, error }, 'Tool execution failed');

      await this.services.audit.logEvent({
        timestamp: new Date(),
        conversationId: context.conversationId,
        model: context.model,
        eventType: 'tool_error',
        authTier: context.authTier,
        customerId: context.customerId,
        intent: null,
        action: toolName,
        result: (error as Error).message,
        metadata: { args: this.redactSensitive(args) },
        createdByAgent: true,
      });

      throw error;
    }
  }

  // ==========================================================================
  // Dispatch Router
  // ==========================================================================

  private async dispatch(
    toolName: string,
    args: Record<string, unknown>,
    context: { customerId: string | null; conversationId: string },
  ): Promise<unknown> {
    const cid = (args.customerId as string) ?? context.customerId ?? '';

    // --- Nymbus (DMC Banking) ---
    if (toolName === 'nymbus_getAccountBalances') {
      return this.services.nymbus.getAccountBalances(cid);
    }
    if (toolName === 'nymbus_getRecentTransactions') {
      return this.services.nymbus.getRecentTransactions(
        cid,
        args.accountId as string,
        (args.limit as number) ?? 10,
      );
    }
    if (toolName === 'nymbus_getCardStatus') {
      return this.services.nymbus.getCardStatus(cid);
    }
    if (toolName === 'nymbus_getPayees') {
      return this.services.nymbus.getPayees(cid);
    }
    if (toolName === 'nymbus_scheduleBillPay') {
      return this.services.nymbus.scheduleBillPay({
        customerId: cid,
        payeeId: args.payeeId as string,
        fromAccountId: args.fromAccountId as string ?? 'default',
        amount: args.amount as number,
        scheduledDate: new Date(args.scheduledDate as string),
        conversationId: args.conversationId as string,
      });
    }
    if (toolName === 'nymbus_getScheduledPayments') {
      return this.services.nymbus.getScheduledPayments(cid);
    }

    // --- Pricing (Constitutional Tender) ---
    if (toolName === 'pricing_getSpotPrice') {
      return this.services.pricing.getSpotPrice(args.metal as 'gold' | 'silver' | 'platinum');
    }
    if (toolName === 'pricing_lockPrice') {
      return this.services.pricing.lockPrice({
        metal: args.metal as string,
        product: 'standard',
        quantity: args.weightOz as number,
        type: 'vault_allocation',
      });
    }
    if (toolName === 'pricing_getBidPrice') {
      return this.services.pricing.getBidPrice(
        args.metal as 'gold' | 'silver' | 'platinum',
        args.weightOz as number ?? 1,
      );
    }

    // --- Wholesaler ---
    if (toolName === 'wholesaler_checkAvailability') {
      return this.services.wholesaler.checkAvailability(
        args.metal as string,
        args.weightOz as number,
      );
    }

    // --- Custodian ---
    if (toolName === 'custodian_getHoldings') {
      return this.services.custodian.getHoldings(cid);
    }
    if (toolName === 'custodian_getVaultOptions') {
      return this.services.custodian.getVaultOptions(cid);
    }
    if (toolName === 'custodian_getEncumbranceStatus') {
      return this.services.custodian.getEncumbranceStatus(
        cid,
        args.holdingId as string,
      );
    }
    if (toolName === 'custodian_getTransferFeeEstimate') {
      return this.services.custodian.getTransferFeeEstimate(
        args.fromVault as string,
        args.toVault as string,
        args.weightOz as number ?? 1,
        args.metal as string ?? 'gold',
      );
    }

    // --- TILT Lending ---
    if (toolName === 'tilt_calculateIndicativeDSCR') {
      return this.services.tilt.calculateIndicativeDSCR({
        noi: args.noi as number,
        loanAmount: args.loanAmount as number,
        estimatedRate: args.interestRate as number,
        termYears: args.termYears as number,
      });
    }
    if (toolName === 'tilt_createLead') {
      return this.services.tilt.createLead({
        source: (args.source as string ?? 'voice_agent') as LoanApplicationLead['source'],
        callerType: (args.callerType as string ?? 'borrower') as 'broker' | 'borrower',
        brokerName: args.brokerName as string | undefined,
        brokerCompany: args.brokerCompany as string | undefined,
        borrowerName: args.borrowerName as string | undefined,
        propertyType: args.propertyType as string,
        propertyAddress: (args.propertyAddress ?? args.propertyLocation ?? '') as string,
        units: args.units as number | undefined,
        squareFeet: args.squareFeet as number | undefined,
        status: (args.status as string ?? 'stabilized') as 'stabilized' | 'value_add' | 'construction',
        grossRentalIncome: (args.grossRentalIncome as number) ?? 0,
        operatingExpenses: (args.operatingExpenses as number) ?? 0,
        noi: (args.noi as number) ?? 0,
        propertyValue: (args.propertyValue as number) ?? 0,
        requestedLoanAmount: (args.requestedAmount as number) ?? 0,
        ltv: (args.ltv as number) ?? 0,
        indicativeDscr: (args.indicativeDscr as number) ?? null,
        preScreenResult: (args.preScreenResult as string ?? 'marginal') as 'fits_program' | 'marginal' | 'outside_parameters',
        contactPhone: (args.borrowerPhone ?? args.contactPhone ?? '') as string,
        contactEmail: (args.borrowerEmail ?? args.contactEmail ?? '') as string,
        conversationId: context.conversationId,
        createdByAgent: true,
      });
    }
    if (toolName === 'tilt_getLoanPrograms') {
      return this.services.tilt.getLoanPrograms();
    }

    // --- LoanPro ---
    if (toolName === 'loanpro_getLoanDetails') {
      return this.services.loanpro.getLoanDetails(args.borrowerId as string);
    }
    if (toolName === 'loanpro_getPaymentSchedule') {
      return this.services.loanpro.getPaymentSchedule(args.loanId as string);
    }
    if (toolName === 'loanpro_getPayoffQuote') {
      return this.services.loanpro.getPayoffQuote(args.loanId as string);
    }
    if (toolName === 'loanpro_getEscrowBalance') {
      return this.services.loanpro.getEscrowBalance(args.loanId as string);
    }

    // --- Eureka ---
    if (toolName === 'eureka_getSettlementStatus') {
      return this.services.eureka.getSettlementStatus(args.fileId as string);
    }
    if (toolName === 'eureka_generateChecklist') {
      return this.services.eureka.generateChecklist(args.fileId as string);
    }

    // --- IFSE Treasury ---
    if (toolName === 'ifse_getPendingWires') {
      return this.services.ifse.getPendingWires();
    }
    if (toolName === 'ifse_getFXExposure') {
      return this.services.ifse.getFXExposure(new Date(args.date as string));
    }
    if (toolName === 'ifse_getSettlementQueueStatus') {
      return this.services.ifse.getSettlementQueueStatus();
    }
    if (toolName === 'ifse_generateReconReport') {
      return this.services.ifse.generateReconReport(new Date(args.date as string));
    }

    // --- Sanctions ---
    if (toolName === 'sanctions_screenBeneficiary') {
      const result = await this.services.sanctions.screenBeneficiary(
        args.name as string,
        (args.country as string) ?? '',
      );
      // NEVER reveal match details to customer
      return { cleared: result.cleared, requiresManualReview: result.requiresManualReview };
    }

    // --- CRM (Unified — routes to GHL or HubSpot) ---
    if (toolName === 'crm_createTicket') {
      return this.services.crm.createTicket({
        customerId: cid,
        category: args.category as string,
        description: args.description as string,
        priority: args.priority as 'low' | 'medium' | 'high' | 'urgent',
        conversationId: args.conversationId as string ?? '',
      });
    }
    if (toolName === 'crm_searchFAQ') {
      return this.services.crm.searchFAQ(args.query as string);
    }
    if (toolName === 'ghl_bookAppointment') {
      return this.services.crm.bookAppointment({
        calendarId: args.calendarId as string,
        contactId: args.contactId as string,
        title: args.title as string,
        startTime: new Date(args.preferredDate as string),
        endTime: new Date(new Date(args.preferredDate as string).getTime() + 30 * 60000),
      });
    }
    if (toolName === 'ghl_sendSMS') {
      // SMS is post-call — queue it
      this.logger.info({
        contactId: args.contactId,
        message: (args.message as string).substring(0, 50),
      }, 'Queuing follow-up SMS');
      return { queued: true };
    }

    // --- HubSpot specific ---
    if (toolName.startsWith('hubspot_')) {
      return this.dispatchHubSpot(toolName, args, cid);
    }

    // --- GHL specific ---
    if (toolName.startsWith('ghl_') && toolName !== 'ghl_bookAppointment' && toolName !== 'ghl_sendSMS') {
      return this.dispatchGHL(toolName, args);
    }

    // --- OpenClaw tools (openclaw_<category>_<action>) ---
    if (toolName.startsWith('openclaw_')) {
      return this.dispatchOpenClaw(toolName, args);
    }

    // --- Swarm Gateway tools (swarm_<action>) ---
    if (toolName.startsWith('swarm_')) {
      return this.dispatchSwarm(toolName, args);
    }

    throw new Error(`Unknown tool: ${toolName}`);
  }

  // ==========================================================================
  // HubSpot Dispatch
  // ==========================================================================

  private async dispatchHubSpot(
    toolName: string,
    args: Record<string, unknown>,
    customerId: string,
  ): Promise<unknown> {
    switch (toolName) {
      case 'hubspot_getContact':
        return this.services.crm.getContact(args.contactId as string ?? customerId);
      case 'hubspot_createContact':
        return this.services.crm.createContact(args as any);
      case 'hubspot_updateContact':
        return this.services.crm.updateContact(args.contactId as string, args as any);
      case 'hubspot_createDeal':
        return this.services.crm.createDeal(args as any);
      case 'hubspot_createTicket':
        return this.services.crm.createTicket(args as any);
      case 'hubspot_logCall':
        return this.services.crm.logCall(args as any);
      case 'hubspot_createNote':
        return this.services.crm.addNote(args.contactId as string, { body: args.body as string });
      case 'hubspot_getTicket':
      case 'hubspot_getTicketStatus':
        return this.services.crm.getTicketStatus(args.ticketId as string);
      default:
        throw new Error(`Unknown HubSpot tool: ${toolName}`);
    }
  }

  // ==========================================================================
  // GHL Dispatch
  // ==========================================================================

  private async dispatchGHL(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (toolName) {
      case 'ghl_getContact':
        return this.services.crm.getContact(args.contactId as string);
      case 'ghl_getContactByPhone':
        return this.services.crm.getContactByPhone(args.phone as string);
      case 'ghl_createContact':
        return this.services.crm.createContact(args as any);
      case 'ghl_updateContact':
        return this.services.crm.updateContact(args.contactId as string, args as any);
      case 'ghl_createOpportunity':
        return this.services.crm.createDeal(args as any);
      case 'ghl_moveOpportunityStage':
        return this.services.crm.updateDealStage(args.dealId as string, args.stage as string);
      case 'ghl_addTag':
        return this.services.crm.addTag(args.contactId as string, args.tag as string);
      case 'ghl_getAvailableSlots':
        return this.services.crm.getAvailableSlots(args.calendarId as string, new Date(args.date as string));
      case 'ghl_logCall':
        return this.services.crm.logCall(args as any);
      case 'ghl_createNote':
        return this.services.crm.addNote(args.contactId as string, { body: args.body as string });
      case 'ghl_createTask':
        return this.services.crm.createTask(args as any);
      case 'ghl_addContactToWorkflow':
        return this.services.crm.triggerWorkflow(args.contactId as string, args.workflowId as string);
      case 'ghl_getOpportunitiesByPipeline':
        return this.services.crm.getDealsForContact(args.contactId as string);
      default:
        throw new Error(`Unknown GHL tool: ${toolName}`);
    }
  }

  // ==========================================================================
  // OpenClaw Dispatch
  // ==========================================================================

  /**
   * Route openclaw_<category>_<action> tool calls to the OpenClaw REST API.
   * Tool names follow the pattern: openclaw_<category>_<action>
   * e.g., openclaw_memory_store, openclaw_analytics_query, openclaw_web_scrape
   */
  private async dispatchOpenClaw(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.openClaw) {
      return { error: 'OpenClaw is not configured. Set OPENCLAW_API_URL to enable.' };
    }

    // Parse: openclaw_<category>_<action> (action may contain underscores)
    const parts = toolName.replace('openclaw_', '').split('_');
    if (parts.length < 2) {
      throw new Error(`Invalid OpenClaw tool name format: ${toolName}`);
    }

    const category = parts[0];
    const action = parts.slice(1).join('_');

    return this.openClaw.dispatch(category, action, args);
  }

  // ==========================================================================
  // Swarm Gateway Dispatch
  // ==========================================================================

  /**
   * Route swarm_<action> tool calls to the Swarm Mainframe Gateway.
   * Tool names follow the pattern: swarm_<action>
   * e.g., swarm_submit_task, swarm_query_ai, swarm_list_models
   */
  private async dispatchSwarm(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.swarmGateway) {
      return { error: 'Swarm Gateway is not configured. Set SWARM_MAINFRAME_URL and SWARM_API_KEY to enable.' };
    }

    // Parse: swarm_<action> (action may contain underscores)
    const action = toolName.replace('swarm_', '');
    if (!action) {
      throw new Error(`Invalid Swarm tool name format: ${toolName}`);
    }

    return this.swarmGateway.dispatch(action, args);
  }

  // ==========================================================================
  // Security
  // ==========================================================================

  /** Redact sensitive fields from audit logs */
  private redactSensitive(args: Record<string, unknown>): Record<string, unknown> {
    const redacted = { ...args };
    const sensitiveKeys = ['ssn', 'creditCard', 'routingNumber', 'accountNumber', 'password', 'pin'];
    for (const key of sensitiveKeys) {
      if (key in redacted) {
        redacted[key] = '***REDACTED***';
      }
    }
    return redacted;
  }
}
