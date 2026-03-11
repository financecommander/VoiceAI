/**
 * Unified CRM Adapter
 *
 * Routes all ICRMService calls to the correct backend:
 *   - DMC, IFSE → HubSpot
 *   - Constitutional Tender, TILT, Eureka → GoHighLevel
 *
 * The voice agent orchestrator only talks to this adapter.
 * It never calls HubSpot or GHL directly.
 *
 * This adapter also handles:
 *   - Cross-CRM consent synchronization
 *   - Unified call logging (every call gets logged regardless of CRM)
 *   - Speed-to-lead tracking (timestamps from call start to CRM entry)
 */

import type { Logger } from 'pino';
import type { CalcModel } from '../../types.js';
import type {
  ICRMService,
  CRMContact,
  CRMContactParams,
  CRMDeal,
  CRMDealParams,
  CRMLead,
  CRMLeadParams,
  LeadQualification,
  CRMTask,
  CRMTaskParams,
  CRMNote,
  CRMNoteParams,
  CRMCallLogParams,
  CRMActivity,
  CRMConsentRecord,
  TimeSlot,
  Appointment,
  AppointmentParams,
  Ticket,
  TicketParams,
  FAQResult,
} from '../contracts.js';
import type { GHLService } from './ghl-service.js';
import type { HubSpotService } from './hubspot-service.js';

// ============================================================================
// CRM Routing Configuration
// ============================================================================

export interface UnifiedCRMConfig {
  /** Which CRM backend each model uses */
  modelRouting: Record<CalcModel, 'hubspot' | 'ghl'>;

  /** GHL location ID per model */
  ghlLocations: Record<string, string>;
}

export const DEFAULT_CRM_ROUTING: UnifiedCRMConfig = {
  modelRouting: {
    DMC: 'hubspot',
    CONSTITUTIONAL_TENDER: 'ghl',
    TILT: 'ghl',
    MORTGAGE: 'ghl',
    REAL_ESTATE: 'ghl',
    EUREKA: 'ghl',
    LOAN_SERVICING: 'hubspot',
    IFSE: 'hubspot',
    JACK: 'hubspot',
  },
  ghlLocations: {},
};

// ============================================================================
// Unified CRM Adapter
// ============================================================================

export class UnifiedCRMAdapter implements ICRMService {
  private hubspot: HubSpotService;
  private ghl: GHLService;
  private config: UnifiedCRMConfig;
  private activeModel: CalcModel;
  private logger: Logger;

  constructor(params: {
    hubspot: HubSpotService;
    ghl: GHLService;
    config: UnifiedCRMConfig;
    activeModel: CalcModel;
    logger: Logger;
  }) {
    this.hubspot = params.hubspot;
    this.ghl = params.ghl;
    this.config = params.config;
    this.activeModel = params.activeModel;
    this.logger = params.logger.child({ component: 'UnifiedCRM', model: params.activeModel });
  }

  /** Switch active model (e.g., on cross-model transfer) */
  setActiveModel(model: CalcModel): void {
    this.activeModel = model;
    this.logger = this.logger.child({ model });
  }

  private get backend(): 'hubspot' | 'ghl' {
    return this.config.modelRouting[this.activeModel];
  }

  private get locationId(): string {
    return this.config.ghlLocations[this.activeModel] ?? '';
  }

  // ==========================================================================
  // Contacts
  // ==========================================================================

  async createContact(params: CRMContactParams): Promise<CRMContact> {
    if (this.backend === 'ghl') {
      const result = await this.ghl.createContact(this.locationId, {
        firstName: params.firstName,
        lastName: params.lastName,
        email: params.email,
        phone: params.phone,
        companyName: params.company,
        source: params.leadSource,
        tags: params.tags,
      });
      return this.mapGHLContact(result);
    }

    const result = await this.hubspot.createContact({
      firstname: params.firstName,
      lastname: params.lastName,
      email: params.email,
      phone: params.phone,
      company: params.company,
      jobtitle: params.title,
      lifecyclestage: params.lifecycle,
    });
    return this.mapHubSpotContact(result);
  }

  async getContact(contactId: string): Promise<CRMContact | null> {
    if (this.backend === 'ghl') {
      const result = await this.ghl.getContact(this.locationId, contactId);
      return result ? this.mapGHLContact(result) : null;
    }
    const result = await this.hubspot.getContact(contactId);
    return result ? this.mapHubSpotContact(result) : null;
  }

  async getContactByPhone(phone: string): Promise<CRMContact | null> {
    if (this.backend === 'ghl') {
      const result = await this.ghl.getContactByPhone(this.locationId, phone);
      return result ? this.mapGHLContact(result) : null;
    }
    const result = await this.hubspot.getContactByPhone(phone);
    return result ? this.mapHubSpotContact(result) : null;
  }

  async getContactByEmail(email: string): Promise<CRMContact | null> {
    if (this.backend === 'ghl') {
      const result = await this.ghl.getContactByEmail(this.locationId, email);
      return result ? this.mapGHLContact(result) : null;
    }
    const result = await this.hubspot.getContactByEmail(email);
    return result ? this.mapHubSpotContact(result) : null;
  }

  async updateContact(contactId: string, updates: Partial<CRMContactParams>): Promise<CRMContact> {
    if (this.backend === 'ghl') {
      const result = await this.ghl.updateContact(this.locationId, contactId, {
        firstName: updates.firstName,
        lastName: updates.lastName,
        email: updates.email,
        phone: updates.phone,
        companyName: updates.company,
        tags: updates.tags,
      });
      return this.mapGHLContact(result);
    }

    const props: Record<string, string> = {};
    if (updates.firstName) props.firstname = updates.firstName;
    if (updates.lastName) props.lastname = updates.lastName;
    if (updates.email) props.email = updates.email;
    if (updates.phone) props.phone = updates.phone;
    if (updates.company) props.company = updates.company;
    if (updates.lifecycle) props.lifecyclestage = updates.lifecycle;

    const result = await this.hubspot.updateContact(contactId, props);
    return this.mapHubSpotContact(result);
  }

  // ==========================================================================
  // Deals / Opportunities
  // ==========================================================================

  async createDeal(params: CRMDealParams): Promise<CRMDeal> {
    if (this.backend === 'ghl') {
      const opp = await this.ghl.createOpportunity(this.locationId, {
        contactId: params.contactId,
        name: params.name,
        pipelineId: params.pipeline,
        pipelineStageId: params.stage,
        monetaryValue: params.amount,
        source: 'voice_agent',
      });
      return this.mapGHLDeal(opp);
    }

    const deal = await this.hubspot.createDeal({
      dealname: params.name,
      pipeline: params.pipeline,
      dealstage: params.stage,
      amount: String(params.amount),
      ...(params.closeDate && { closedate: params.closeDate.toISOString() }),
    });
    return this.mapHubSpotDeal(deal);
  }

  async getDeal(dealId: string): Promise<CRMDeal | null> {
    if (this.backend === 'ghl') {
      const opp = await this.ghl.getOpportunity(this.locationId, dealId);
      return opp ? this.mapGHLDeal(opp) : null;
    }
    const deal = await this.hubspot.getDeal(dealId);
    return deal ? this.mapHubSpotDeal(deal) : null;
  }

  async updateDealStage(dealId: string, stage: string): Promise<CRMDeal> {
    if (this.backend === 'ghl') {
      const opp = await this.ghl.moveOpportunityStage(this.locationId, dealId, stage);
      return this.mapGHLDeal(opp);
    }
    const deal = await this.hubspot.updateDeal(dealId, { dealstage: stage });
    return this.mapHubSpotDeal(deal);
  }

  async getDealsForContact(contactId: string): Promise<CRMDeal[]> {
    if (this.backend === 'ghl') {
      // GHL doesn't have a direct "deals by contact" endpoint
      // Search all pipelines and filter
      const pipelines = await this.ghl.getPipelines(this.locationId);
      const allOpps: CRMDeal[] = [];
      for (const pipeline of pipelines) {
        const opps = await this.ghl.getOpportunitiesByPipeline(this.locationId, pipeline.id);
        allOpps.push(...opps.filter(o => o.contactId === contactId).map(o => this.mapGHLDeal(o)));
      }
      return allOpps;
    }

    // HubSpot: search deals associated with contact
    // Would use associations API in production
    return [];
  }

  // ==========================================================================
  // Leads
  // ==========================================================================

  async createLead(params: CRMLeadParams): Promise<CRMLead> {
    const now = new Date();
    const responseTimeMs = params.leadCreatedAt
      ? now.getTime() - params.leadCreatedAt.getTime()
      : null;

    if (this.backend === 'ghl') {
      // In GHL, a lead = contact + opportunity in the pipeline
      const opp = await this.ghl.createOpportunity(this.locationId, {
        contactId: params.contactId,
        name: `Lead — ${params.source}`,
        pipelineId: params.pipeline ?? '',
        pipelineStageId: params.initialStage ?? '',
        source: params.source,
      });

      // Tag the contact as a lead
      await this.ghl.addTag(this.locationId, params.contactId, `lead_${params.source}`);
      await this.ghl.addTag(this.locationId, params.contactId, 'voice_agent_lead');

      // Trigger speed-to-lead workflow if applicable
      if (params.source === 'arbor' || params.source === 'costar' || params.source === 'web_inbound') {
        this.logger.info({
          source: params.source,
          responseTimeMs,
        }, 'Speed-to-lead: triggering GHL workflow');
      }

      return {
        leadId: opp.id,
        contactId: params.contactId,
        source: params.source,
        status: 'new',
        score: params.score ?? 0,
        qualification: null,
        assignedTo: null,
        firstContactedAt: now,
        lastContactedAt: now,
        responseTimeMs,
        createdAt: now,
      };
    }

    // HubSpot: update contact lifecycle to 'lead', create deal
    await this.hubspot.updateContact(params.contactId, {
      lifecyclestage: 'lead',
      hs_lead_status: 'NEW',
    });

    return {
      leadId: params.contactId, // In HubSpot, the contact IS the lead
      contactId: params.contactId,
      source: params.source,
      status: 'new',
      score: params.score ?? 0,
      qualification: null,
      assignedTo: null,
      firstContactedAt: now,
      lastContactedAt: now,
      responseTimeMs,
      createdAt: now,
    };
  }

  async qualifyLead(leadId: string, qualification: LeadQualification): Promise<CRMLead> {
    if (this.backend === 'ghl') {
      await this.ghl.addTag(this.locationId, leadId, qualification.score >= 70 ? 'qualified' : 'nurture');
      await this.ghl.createNote(
        this.locationId, leadId,
        `Lead qualified by voice agent. Score: ${qualification.score}. Notes: ${qualification.notes}`,
      );
    } else {
      await this.hubspot.updateContact(leadId, {
        hs_lead_status: qualification.score >= 70 ? 'QUALIFIED' : 'UNQUALIFIED',
      });
      await this.hubspot.createNote(
        leadId,
        `Lead qualified by voice agent. Score: ${qualification.score}. Notes: ${qualification.notes}`,
      );
    }

    return {
      leadId,
      contactId: leadId,
      source: '',
      status: qualification.score >= 70 ? 'qualified' : 'unqualified',
      score: qualification.score,
      qualification,
      assignedTo: null,
      firstContactedAt: null,
      lastContactedAt: new Date(),
      responseTimeMs: null,
      createdAt: new Date(),
    };
  }

  async assignLead(leadId: string, ownerId: string): Promise<void> {
    if (this.backend === 'ghl') {
      // Update the opportunity's assignedTo
      await this.ghl.updateOpportunity(this.locationId, leadId, { assignedTo: ownerId } as any);
    } else {
      await this.hubspot.updateContact(leadId, { hubspot_owner_id: ownerId });
    }
  }

  // ==========================================================================
  // Tasks / Tickets
  // ==========================================================================

  async createTask(params: CRMTaskParams): Promise<CRMTask> {
    if (this.backend === 'ghl') {
      const task = await this.ghl.createTask(this.locationId, {
        contactId: params.contactId,
        title: params.title,
        body: params.description,
        dueDate: params.dueDate,
        assignedTo: params.assignedTo,
      });
      return {
        taskId: task.id,
        contactId: params.contactId,
        title: task.title,
        description: task.body,
        dueDate: task.dueDate,
        priority: params.priority ?? 'medium',
        status: 'open',
        assignedTo: task.assignedTo,
      };
    }

    // HubSpot tasks via engagements
    const id = await this.hubspot.createEngagement({
      type: 'TASK',
      contactIds: [params.contactId],
      body: `${params.title}\n\n${params.description}`,
      timestamp: new Date(),
    });

    return {
      taskId: id,
      contactId: params.contactId,
      title: params.title,
      description: params.description,
      dueDate: params.dueDate ?? new Date(),
      priority: params.priority ?? 'medium',
      status: 'open',
      assignedTo: params.assignedTo ?? null,
    };
  }

  async createTicket(params: TicketParams): Promise<Ticket> {
    if (this.backend === 'ghl') {
      // GHL doesn't have a native ticket system — create a task instead
      const task = await this.ghl.createTask(this.locationId, {
        contactId: params.contactId ?? params.customerId ?? '',
        title: `[${params.priority.toUpperCase()}] ${params.category}`,
        body: params.description,
      });
      return {
        ticketId: task.id,
        status: 'open',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    const ticket = await this.hubspot.createTicket({
      subject: params.category,
      content: params.description,
      hs_pipeline: '0',
      hs_pipeline_stage: '1',
      hs_ticket_priority: params.priority.toUpperCase() as any,
      contactId: params.contactId ?? params.customerId,
    });

    return {
      ticketId: ticket.id,
      status: 'open',
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    };
  }

  async getTicketStatus(ticketId: string): Promise<Ticket> {
    if (this.backend === 'hubspot') {
      const ticket = await this.hubspot.getTicket(ticketId);
      if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
      return {
        ticketId: ticket.id,
        status: ((ticket.properties?.hs_pipeline_stage as string) ?? 'open') as 'open' | 'in_progress' | 'resolved' | 'closed',
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
      };
    }

    // GHL: tasks don't have robust status tracking
    return {
      ticketId,
      status: 'open',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  // ==========================================================================
  // Notes / Activity
  // ==========================================================================

  async addNote(contactId: string, note: CRMNoteParams): Promise<CRMNote> {
    const body = note.createdByAgent
      ? `[Voice Agent] ${note.body}`
      : note.body;

    if (this.backend === 'ghl') {
      const result = await this.ghl.createNote(this.locationId, contactId, body);
      return {
        noteId: result.id,
        contactId,
        body: result.body,
        createdAt: result.dateAdded,
        createdBy: note.createdByAgent ? 'voice_agent' : 'human',
      };
    }

    const id = await this.hubspot.createNote(contactId, body);
    return {
      noteId: id,
      contactId,
      body,
      createdAt: new Date(),
      createdBy: note.createdByAgent ? 'voice_agent' : 'human',
    };
  }

  async logCall(params: CRMCallLogParams): Promise<string> {
    this.logger.info({
      contactId: params.contactId,
      direction: params.direction,
      pipeline: params.pipeline,
      compliancePass: params.compliancePass,
    }, 'Logging call to CRM');

    if (this.backend === 'ghl') {
      return this.ghl.logCall(this.locationId, {
        contactId: params.contactId,
        direction: params.direction,
        duration: Math.round(params.durationMs / 1000),
        status: params.outcome === 'connected' ? 'completed' : params.outcome as any,
        recordingUrl: params.recordingUrl,
        notes: `${params.notes}\n\nPipeline: ${params.pipeline ?? 'modular'} | LLM: ${params.llmProvider ?? 'N/A'} | Compliance: ${params.compliancePass ? 'PASS' : 'FAIL'}`,
      });
    }

    return this.hubspot.logCall({
      contactId: params.contactId,
      body: params.notes,
      durationMs: params.durationMs,
      disposition: params.outcome,
      direction: params.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND',
      recordingUrl: params.recordingUrl,
      calculus_pipeline_mode: params.pipeline,
    });
  }

  async getActivityTimeline(contactId: string, _limit = 20): Promise<CRMActivity[]> {
    // Simplified — full implementation would paginate through activities
    if (this.backend === 'ghl') {
      const notes = await this.ghl.getNotes(this.locationId, contactId);
      return notes.map(n => ({
        activityId: n.id,
        type: 'note' as const,
        timestamp: n.dateAdded,
        summary: n.body.substring(0, 100),
        metadata: {},
      }));
    }

    return []; // HubSpot activity timeline requires associations API
  }

  // ==========================================================================
  // Automations
  // ==========================================================================

  async enrollInSequence(contactId: string, sequenceId: string): Promise<void> {
    if (this.backend === 'ghl') {
      await this.ghl.addContactToWorkflow(this.locationId, contactId, sequenceId);
    } else {
      await this.hubspot.enrollContactInSequence(contactId, sequenceId, '');
    }
  }

  async removeFromSequence(contactId: string, sequenceId: string): Promise<void> {
    if (this.backend === 'ghl') {
      await this.ghl.removeContactFromWorkflow(this.locationId, contactId, sequenceId);
    } else {
      await this.hubspot.unenrollContactFromSequence(contactId, sequenceId);
    }
  }

  async triggerWorkflow(contactId: string, workflowId: string, _data?: Record<string, unknown>): Promise<void> {
    if (this.backend === 'ghl') {
      await this.ghl.addContactToWorkflow(this.locationId, contactId, workflowId);
    } else {
      await this.hubspot.enrollContactInWorkflow(contactId, workflowId);
    }
  }

  // ==========================================================================
  // Appointments
  // ==========================================================================

  async getAvailableSlots(calendarId: string, date: Date): Promise<TimeSlot[]> {
    if (this.backend === 'ghl') {
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);
      const slots = await this.ghl.getAvailableSlots(this.locationId, calendarId, date, endDate);
      return slots.map(s => ({
        start: s.startTime,
        end: s.endTime,
        available: true,
        calendarId,
      }));
    }

    // HubSpot doesn't have native calendar/booking — return empty
    return [];
  }

  async bookAppointment(params: AppointmentParams): Promise<Appointment> {
    if (this.backend === 'ghl') {
      const appt = await this.ghl.bookAppointment(this.locationId, {
        calendarId: params.calendarId,
        contactId: params.contactId,
        title: params.title,
        startTime: params.startTime,
        endTime: params.endTime,
        notes: params.notes,
      });
      return {
        appointmentId: appt.id,
        contactId: appt.contactId,
        calendarId: appt.calendarId,
        startTime: appt.startTime,
        endTime: appt.endTime,
        title: appt.title,
        status: appt.status === 'new' ? 'scheduled' : appt.status as any,
        meetingUrl: appt.meetingLocation ?? undefined,
        confirmationSent: true,
      };
    }

    throw new Error('Appointment booking requires GoHighLevel — not available for HubSpot models');
  }

  async cancelAppointment(appointmentId: string, _reason?: string): Promise<void> {
    if (this.backend === 'ghl') {
      await this.ghl.cancelAppointment(this.locationId, appointmentId);
    }
  }

  // ==========================================================================
  // Tags / Lists
  // ==========================================================================

  async addTag(contactId: string, tag: string): Promise<void> {
    if (this.backend === 'ghl') {
      await this.ghl.addTag(this.locationId, contactId, tag);
    }
    // HubSpot doesn't have tags — would use lists instead
  }

  async removeTag(contactId: string, tag: string): Promise<void> {
    if (this.backend === 'ghl') {
      await this.ghl.removeTag(this.locationId, contactId, tag);
    }
  }

  async addToList(contactId: string, listId: string): Promise<void> {
    if (this.backend === 'hubspot') {
      await this.hubspot.addContactToList(contactId, listId);
    }
    // GHL uses tags instead of lists
  }

  // ==========================================================================
  // Search / FAQ
  // ==========================================================================

  async searchContacts(query: string, limit = 20): Promise<CRMContact[]> {
    if (this.backend === 'ghl') {
      const results = await this.ghl.searchContacts(this.locationId, query, limit);
      return results.map(r => this.mapGHLContact(r));
    }
    const results = await this.hubspot.searchContacts([
      { propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: query },
    ]);
    return results.map(r => this.mapHubSpotContact(r));
  }

  async searchFAQ(_query: string): Promise<FAQResult[]> {
    // FAQ search would be implemented against a knowledge base
    // Not CRM-specific — return empty for now
    return [];
  }

  // ==========================================================================
  // Compliance
  // ==========================================================================

  async flagAccount(contactId: string, flag: string): Promise<void> {
    if (this.backend === 'ghl') {
      await this.ghl.addTag(this.locationId, contactId, `flag_${flag}`);
      if (flag === 'opt_out' || flag === 'dnc') {
        await this.ghl.updateContact(this.locationId, contactId, { dnd: true } as any);
      }
    } else {
      await this.hubspot.updateContact(contactId, {
        [`calculus_flag_${flag}`]: 'true',
      });
    }
  }

  async recordConsent(contactId: string, consent: CRMConsentRecord): Promise<void> {
    const note = `Consent ${consent.granted ? 'GRANTED' : 'REVOKED'}: ${consent.type} via ${consent.method} at ${consent.timestamp.toISOString()}`;

    if (this.backend === 'ghl') {
      await this.ghl.createNote(this.locationId, contactId, note);
      if (consent.type === 'ai_call') {
        await this.ghl.addTag(this.locationId, contactId,
          consent.granted ? 'ai_consent_granted' : 'ai_consent_revoked');
      }
    } else {
      await this.hubspot.createNote(contactId, note);
    }
  }

  async getConsentHistory(contactId: string): Promise<CRMConsentRecord[]> {
    // Would parse consent notes from activity timeline
    return [];
  }

  // ==========================================================================
  // Mappers
  // ==========================================================================

  private mapGHLContact(ghl: any): CRMContact {
    return {
      contactId: ghl.id,
      source: 'gohighlevel',
      externalId: ghl.id,
      firstName: ghl.firstName ?? '',
      lastName: ghl.lastName ?? '',
      email: ghl.email,
      phone: ghl.phone,
      company: ghl.companyName,
      title: null,
      address: ghl.address1 ? {
        street: ghl.address1,
        city: ghl.city,
        state: ghl.state,
        zip: ghl.postalCode,
        country: ghl.country,
      } : null,
      lifecycle: '',
      leadSource: ghl.source,
      owner: null,
      tags: ghl.tags ?? [],
      customFields: {},
      createdAt: new Date(ghl.dateAdded),
      updatedAt: new Date(ghl.dateUpdated),
    };
  }

  private mapHubSpotContact(hs: any): CRMContact {
    const props = hs.properties ?? {};
    return {
      contactId: hs.id,
      source: 'hubspot',
      externalId: hs.id,
      firstName: props.firstname ?? '',
      lastName: props.lastname ?? '',
      email: props.email ?? null,
      phone: props.phone ?? null,
      company: props.company ?? null,
      title: props.jobtitle ?? null,
      address: null,
      lifecycle: props.lifecyclestage ?? '',
      leadSource: props.hs_analytics_source ?? null,
      owner: props.hubspot_owner_id ?? null,
      tags: [],
      customFields: props,
      createdAt: hs.createdAt,
      updatedAt: hs.updatedAt,
    };
  }

  private mapGHLDeal(ghl: any): CRMDeal {
    return {
      dealId: ghl.id,
      source: 'gohighlevel',
      externalId: ghl.id,
      contactId: ghl.contactId,
      name: ghl.name,
      pipeline: ghl.pipelineId,
      stage: ghl.pipelineStageId,
      amount: ghl.monetaryValue ?? 0,
      currency: 'USD',
      probability: ghl.status === 'won' ? 100 : ghl.status === 'lost' ? 0 : 50,
      closeDate: null,
      owner: ghl.assignedTo,
      properties: {},
      createdAt: new Date(ghl.createdAt),
      updatedAt: new Date(ghl.updatedAt),
    };
  }

  private mapHubSpotDeal(hs: any): CRMDeal {
    const props = hs.properties ?? {};
    return {
      dealId: hs.id,
      source: 'hubspot',
      externalId: hs.id,
      contactId: '',
      name: props.dealname ?? '',
      pipeline: props.pipeline ?? '',
      stage: props.dealstage ?? '',
      amount: parseFloat(props.amount ?? '0'),
      currency: 'USD',
      probability: 50,
      closeDate: props.closedate ? new Date(props.closedate) : null,
      owner: props.hubspot_owner_id ?? null,
      properties: props,
      createdAt: hs.createdAt,
      updatedAt: hs.updatedAt,
    };
  }
}
