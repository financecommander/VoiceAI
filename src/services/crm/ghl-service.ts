/**
 * GoHighLevel (GHL) API Adapter — V2
 *
 * Primary CRM for revenue models: Constitutional Tender, TILT, Eureka
 *
 * Base URL: https://services.leadconnectorhq.com
 * Auth: Private Integration Token or OAuth 2.0
 * Rate Limit: 100 req/10 sec per location, 200K/day
 * API Version Header: Version: 2021-07-28
 *
 * Architecture:
 *   One GHL Location (sub-account) per Calculus model:
 *     - Location CT:     Constitutional Tender metals sales
 *     - Location TILT:   TILT Lending broker pipeline
 *     - Location EUREKA: Eureka Settlement file tracking
 *
 * The voice agent calls this adapter via tool-calling through the LLM.
 * Read-only methods are also exposed to Grok speech-to-speech pipeline.
 */

import type { Logger } from 'pino';
import type {
  IGHLService,
  GHLContact,
  GHLContactParams,
  GHLOpportunity,
  GHLOpportunityParams,
  GHLPipeline,
  GHLSMSParams,
  GHLEmailParams,
  GHLMessage,
  GHLInboundMessageParams,
  GHLCalendar,
  GHLTimeSlot,
  GHLAppointment,
  GHLAppointmentParams,
  GHLTask,
  GHLTaskParams,
  GHLNote,
  GHLCallLogParams,
  GHLCustomField,
  GHLFormSubmission,
  GHLConversation,
} from '../contracts.js';

// ============================================================================
// Configuration
// ============================================================================

export interface GHLConfig {
  /** Private Integration Token or OAuth access token */
  accessToken: string;

  /** Base URL for GHL API V2 */
  baseUrl: string;

  /** API version header */
  apiVersion: string;

  /** Location IDs per model */
  locations: {
    CONSTITUTIONAL_TENDER: string;
    TILT: string;
    EUREKA: string;
  };

  /** Pipeline IDs per model (configured in GHL dashboard) */
  pipelines: {
    ct_sales: string;
    tilt_broker: string;
    tilt_servicing: string;
    eureka_settlement: string;
  };

  /** Calendar IDs for appointment booking */
  calendars: {
    ct_specialist: string;
    tilt_loan_officer: string;
    eureka_coordinator: string;
  };

  /** Workflow IDs for automation triggers */
  workflows: {
    ct_price_alert: string;
    ct_post_purchase: string;
    tilt_speed_to_lead: string;
    tilt_nurture: string;
  };

  /** Request timeout ms */
  timeoutMs: number;

  /** Max retries on transient failure */
  maxRetries: number;
}

export const DEFAULT_GHL_CONFIG: Partial<GHLConfig> = {
  baseUrl: 'https://services.leadconnectorhq.com',
  apiVersion: '2021-07-28',
  timeoutMs: 10_000,
  maxRetries: 2,
};

// ============================================================================
// Rate Limiter — 100 req/10 sec per location
// ============================================================================

class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private maxPerWindow = 100;
  private windowMs = 10_000;

  canMakeRequest(locationId: string): boolean {
    const now = Date.now();
    const timestamps = this.requests.get(locationId) ?? [];
    const recent = timestamps.filter(t => now - t < this.windowMs);
    this.requests.set(locationId, recent);
    return recent.length < this.maxPerWindow;
  }

  recordRequest(locationId: string): void {
    const timestamps = this.requests.get(locationId) ?? [];
    timestamps.push(Date.now());
    this.requests.set(locationId, timestamps);
  }

  async waitForSlot(locationId: string): Promise<void> {
    while (!this.canMakeRequest(locationId)) {
      await new Promise(r => setTimeout(r, 100));
    }
    this.recordRequest(locationId);
  }
}

// ============================================================================
// GHL Service Implementation
// ============================================================================

export class GHLService implements IGHLService {
  private config: GHLConfig;
  private logger: Logger;
  private rateLimiter = new RateLimiter();

  constructor(config: GHLConfig, logger: Logger) {
    this.config = { ...DEFAULT_GHL_CONFIG, ...config } as GHLConfig;
    this.logger = logger.child({ component: 'GHLService' });
  }

  // ==========================================================================
  // HTTP Client
  // ==========================================================================

  private async request<T>(
    locationId: string,
    method: string,
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
  ): Promise<T> {
    await this.rateLimiter.waitForSlot(locationId);

    const url = new URL(path, this.config.baseUrl);
    if (query) {
      Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, v));
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.config.accessToken}`,
      'Content-Type': 'application/json',
      'Version': this.config.apiVersion,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          this.config.timeoutMs,
        );

        const response = await fetch(url.toString(), {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorBody = await response.text();

          // Rate limited — wait and retry
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 2000;
            this.logger.warn({ path, waitMs }, 'GHL rate limited, waiting');
            await new Promise(r => setTimeout(r, waitMs));
            continue;
          }

          throw new GHLAPIError(
            `GHL API error ${response.status}: ${errorBody}`,
            response.status,
            path,
          );
        }

        // 204 No Content
        if (response.status === 204) {
          return undefined as T;
        }

        return await response.json() as T;
      } catch (error) {
        lastError = error as Error;
        if ((error as any)?.name === 'AbortError') {
          this.logger.warn({ path, attempt }, 'GHL request timeout');
        }
        if (attempt < this.config.maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    throw lastError ?? new Error('GHL request failed');
  }

  // ==========================================================================
  // Contacts
  // ==========================================================================

  async createContact(locationId: string, params: GHLContactParams): Promise<GHLContact> {
    this.logger.info({ locationId, phone: params.phone }, 'Creating GHL contact');

    const response = await this.request<{ contact: GHLContact }>(
      locationId, 'POST', '/contacts/',
      {
        ...params,
        locationId,
      },
    );

    return response.contact;
  }

  async getContact(locationId: string, contactId: string): Promise<GHLContact | null> {
    try {
      const response = await this.request<{ contact: GHLContact }>(
        locationId, 'GET', `/contacts/${contactId}`,
      );
      return response.contact;
    } catch (error) {
      if ((error as GHLAPIError).statusCode === 404) return null;
      throw error;
    }
  }

  async getContactByPhone(locationId: string, phone: string): Promise<GHLContact | null> {
    const response = await this.request<{ contacts: GHLContact[] }>(
      locationId, 'GET', '/contacts/search/duplicate',
      undefined,
      { locationId, number: phone },
    );
    return response.contacts?.[0] ?? null;
  }

  async getContactByEmail(locationId: string, email: string): Promise<GHLContact | null> {
    const response = await this.request<{ contacts: GHLContact[] }>(
      locationId, 'GET', '/contacts/search/duplicate',
      undefined,
      { locationId, email },
    );
    return response.contacts?.[0] ?? null;
  }

  async updateContact(
    locationId: string,
    contactId: string,
    params: Partial<GHLContactParams>,
  ): Promise<GHLContact> {
    const response = await this.request<{ contact: GHLContact }>(
      locationId, 'PUT', `/contacts/${contactId}`,
      params as Record<string, unknown>,
    );
    return response.contact;
  }

  async searchContacts(
    locationId: string,
    query: string,
    limit = 20,
  ): Promise<GHLContact[]> {
    const response = await this.request<{ contacts: GHLContact[] }>(
      locationId, 'GET', '/contacts/',
      undefined,
      { locationId, query, limit: limit.toString() },
    );
    return response.contacts ?? [];
  }

  async addTag(locationId: string, contactId: string, tag: string): Promise<void> {
    const contact = await this.getContact(locationId, contactId);
    if (!contact) throw new Error(`Contact ${contactId} not found`);

    const currentTags = contact.tags ?? [];
    if (currentTags.includes(tag)) return;

    await this.updateContact(locationId, contactId, {
      tags: [...currentTags, tag],
    });
  }

  async removeTag(locationId: string, contactId: string, tag: string): Promise<void> {
    const contact = await this.getContact(locationId, contactId);
    if (!contact) throw new Error(`Contact ${contactId} not found`);

    await this.updateContact(locationId, contactId, {
      tags: (contact.tags ?? []).filter(t => t !== tag),
    });
  }

  // ==========================================================================
  // Opportunities (Deals/Pipeline)
  // ==========================================================================

  async createOpportunity(
    locationId: string,
    params: GHLOpportunityParams,
  ): Promise<GHLOpportunity> {
    this.logger.info({
      locationId,
      pipeline: params.pipelineId,
      contact: params.contactId,
    }, 'Creating GHL opportunity');

    const response = await this.request<{ opportunity: GHLOpportunity }>(
      locationId, 'POST', '/opportunities/',
      {
        ...params,
        locationId,
      },
    );
    return response.opportunity;
  }

  async getOpportunity(
    locationId: string,
    opportunityId: string,
  ): Promise<GHLOpportunity | null> {
    try {
      const response = await this.request<{ opportunity: GHLOpportunity }>(
        locationId, 'GET', `/opportunities/${opportunityId}`,
      );
      return response.opportunity;
    } catch (error) {
      if ((error as GHLAPIError).statusCode === 404) return null;
      throw error;
    }
  }

  async updateOpportunity(
    locationId: string,
    opportunityId: string,
    params: Partial<GHLOpportunityParams>,
  ): Promise<GHLOpportunity> {
    const response = await this.request<{ opportunity: GHLOpportunity }>(
      locationId, 'PUT', `/opportunities/${opportunityId}`,
      params as Record<string, unknown>,
    );
    return response.opportunity;
  }

  async getOpportunitiesByPipeline(
    locationId: string,
    pipelineId: string,
    stageId?: string,
  ): Promise<GHLOpportunity[]> {
    const query: Record<string, string> = {
      locationId,
      pipelineId,
    };
    if (stageId) query.pipelineStageId = stageId;

    const response = await this.request<{ opportunities: GHLOpportunity[] }>(
      locationId, 'GET', '/opportunities/search',
      undefined,
      query,
    );
    return response.opportunities ?? [];
  }

  async moveOpportunityStage(
    locationId: string,
    opportunityId: string,
    stageId: string,
  ): Promise<GHLOpportunity> {
    return this.updateOpportunity(locationId, opportunityId, {
      pipelineStageId: stageId,
    } as Partial<GHLOpportunityParams>);
  }

  // ==========================================================================
  // Pipelines
  // ==========================================================================

  async getPipelines(locationId: string): Promise<GHLPipeline[]> {
    const response = await this.request<{ pipelines: GHLPipeline[] }>(
      locationId, 'GET', '/opportunities/pipelines',
      undefined,
      { locationId },
    );
    return response.pipelines ?? [];
  }

  // ==========================================================================
  // Conversations / Messaging
  // ==========================================================================

  async sendSMS(locationId: string, params: GHLSMSParams): Promise<GHLMessage> {
    this.logger.info({ locationId, contact: params.contactId }, 'Sending SMS via GHL');

    const response = await this.request<GHLMessage>(
      locationId, 'POST', '/conversations/messages',
      {
        type: 'SMS',
        contactId: params.contactId,
        message: params.message,
        ...(params.templateId && { templateId: params.templateId }),
      },
    );
    return response;
  }

  async sendEmail(locationId: string, params: GHLEmailParams): Promise<GHLMessage> {
    const response = await this.request<GHLMessage>(
      locationId, 'POST', '/conversations/messages',
      {
        type: 'Email',
        contactId: params.contactId,
        subject: params.subject,
        message: params.body,
        html: params.html ?? params.body,
      },
    );
    return response;
  }

  async getConversation(
    locationId: string,
    contactId: string,
  ): Promise<GHLConversation | null> {
    try {
      const response = await this.request<{ conversations: GHLConversation[] }>(
        locationId, 'GET', '/conversations/search',
        undefined,
        { locationId, contactId },
      );
      return response.conversations?.[0] ?? null;
    } catch {
      return null;
    }
  }

  async addInboundMessage(
    locationId: string,
    params: GHLInboundMessageParams,
  ): Promise<void> {
    await this.request(
      locationId, 'POST', '/conversations/messages/inbound',
      {
        type: params.type.toUpperCase(),
        contactId: params.contactId,
        message: params.message,
      },
    );
  }

  // ==========================================================================
  // Calendars / Appointments
  // ==========================================================================

  async getCalendars(locationId: string): Promise<GHLCalendar[]> {
    const response = await this.request<{ calendars: GHLCalendar[] }>(
      locationId, 'GET', '/calendars/',
      undefined,
      { locationId },
    );
    return response.calendars ?? [];
  }

  async getAvailableSlots(
    locationId: string,
    calendarId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<GHLTimeSlot[]> {
    const response = await this.request<{ slots: Record<string, GHLTimeSlot[]> }>(
      locationId, 'GET', `/calendars/${calendarId}/free-slots`,
      undefined,
      {
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
      },
    );

    // Flatten date-keyed slots into flat array
    const allSlots: GHLTimeSlot[] = [];
    if (response.slots) {
      for (const dateSlots of Object.values(response.slots)) {
        allSlots.push(...dateSlots);
      }
    }
    return allSlots;
  }

  async bookAppointment(
    locationId: string,
    params: GHLAppointmentParams,
  ): Promise<GHLAppointment> {
    this.logger.info({
      locationId,
      calendar: params.calendarId,
      contact: params.contactId,
      time: params.startTime,
    }, 'Booking appointment via GHL');

    const response = await this.request<{ appointment: GHLAppointment }>(
      locationId, 'POST', '/calendars/events/appointments',
      {
        calendarId: params.calendarId,
        contactId: params.contactId,
        title: params.title,
        startTime: params.startTime.toISOString(),
        endTime: params.endTime.toISOString(),
        assignedUserId: params.assignedUserId,
        notes: params.notes,
      },
    );
    return response.appointment;
  }

  async getAppointment(
    locationId: string,
    appointmentId: string,
  ): Promise<GHLAppointment | null> {
    try {
      const response = await this.request<{ appointment: GHLAppointment }>(
        locationId, 'GET', `/calendars/events/appointments/${appointmentId}`,
      );
      return response.appointment;
    } catch (error) {
      if ((error as GHLAPIError).statusCode === 404) return null;
      throw error;
    }
  }

  async updateAppointment(
    locationId: string,
    appointmentId: string,
    params: Partial<GHLAppointmentParams>,
  ): Promise<GHLAppointment> {
    const body: Record<string, unknown> = { ...params };
    if (params.startTime) body.startTime = params.startTime.toISOString();
    if (params.endTime) body.endTime = params.endTime.toISOString();

    const response = await this.request<{ appointment: GHLAppointment }>(
      locationId, 'PUT', `/calendars/events/appointments/${appointmentId}`,
      body,
    );
    return response.appointment;
  }

  async cancelAppointment(locationId: string, appointmentId: string): Promise<void> {
    await this.request(
      locationId, 'PUT', `/calendars/events/appointments/${appointmentId}`,
      { status: 'cancelled' },
    );
  }

  // ==========================================================================
  // Tasks
  // ==========================================================================

  async createTask(locationId: string, params: GHLTaskParams): Promise<GHLTask> {
    const response = await this.request<{ task: GHLTask }>(
      locationId, 'POST', `/contacts/${params.contactId}/tasks`,
      {
        title: params.title,
        body: params.body,
        dueDate: params.dueDate?.toISOString(),
        assignedTo: params.assignedTo,
      },
    );
    return response.task;
  }

  async getTasks(locationId: string, contactId: string): Promise<GHLTask[]> {
    const response = await this.request<{ tasks: GHLTask[] }>(
      locationId, 'GET', `/contacts/${contactId}/tasks`,
    );
    return response.tasks ?? [];
  }

  async updateTask(
    locationId: string,
    taskId: string,
    params: Partial<GHLTaskParams>,
  ): Promise<GHLTask> {
    const body: Record<string, unknown> = { ...params };
    if (params.dueDate) body.dueDate = params.dueDate.toISOString();

    const response = await this.request<{ task: GHLTask }>(
      locationId, 'PUT', `/contacts/${params.contactId}/tasks/${taskId}`,
      body,
    );
    return response.task;
  }

  // ==========================================================================
  // Notes
  // ==========================================================================

  async createNote(locationId: string, contactId: string, body: string): Promise<GHLNote> {
    const response = await this.request<{ note: GHLNote }>(
      locationId, 'POST', `/contacts/${contactId}/notes`,
      { body },
    );
    return response.note;
  }

  async getNotes(locationId: string, contactId: string): Promise<GHLNote[]> {
    const response = await this.request<{ notes: GHLNote[] }>(
      locationId, 'GET', `/contacts/${contactId}/notes`,
    );
    return response.notes ?? [];
  }

  // ==========================================================================
  // Workflows (Automations)
  // ==========================================================================

  async addContactToWorkflow(
    locationId: string,
    contactId: string,
    workflowId: string,
  ): Promise<void> {
    this.logger.info({ locationId, contactId, workflowId }, 'Adding to GHL workflow');

    await this.request(
      locationId, 'POST', `/contacts/${contactId}/workflow/${workflowId}`,
    );
  }

  async removeContactFromWorkflow(
    locationId: string,
    contactId: string,
    workflowId: string,
  ): Promise<void> {
    await this.request(
      locationId, 'DELETE', `/contacts/${contactId}/workflow/${workflowId}`,
    );
  }

  // ==========================================================================
  // Custom Fields
  // ==========================================================================

  async getCustomFields(locationId: string): Promise<GHLCustomField[]> {
    const response = await this.request<{ customFields: GHLCustomField[] }>(
      locationId, 'GET', '/locations/customFields',
      undefined,
      { locationId },
    );
    return response.customFields ?? [];
  }

  async updateCustomFieldValue(
    locationId: string,
    contactId: string,
    fieldId: string,
    value: string,
  ): Promise<void> {
    await this.updateContact(locationId, contactId, {
      customField: { [fieldId]: value },
    } as any);
  }

  // ==========================================================================
  // Call Tracking
  // ==========================================================================

  async logCall(locationId: string, params: GHLCallLogParams): Promise<string> {
    this.logger.info({
      locationId,
      contactId: params.contactId,
      direction: params.direction,
      duration: params.duration,
    }, 'Logging call to GHL');

    // GHL logs calls through the conversations/messages endpoint
    const response = await this.request<{ id: string }>(
      locationId, 'POST', '/conversations/messages',
      {
        type: 'Call',
        contactId: params.contactId,
        message: params.notes ?? `Voice agent call — ${params.status}`,
        direction: params.direction,
        status: params.status,
        duration: params.duration,
        ...(params.recordingUrl && { attachments: [params.recordingUrl] }),
      },
    );
    return response.id;
  }

  // ==========================================================================
  // Forms & Surveys
  // ==========================================================================

  async getFormSubmissions(
    locationId: string,
    formId: string,
    limit = 20,
  ): Promise<GHLFormSubmission[]> {
    const response = await this.request<{ submissions: GHLFormSubmission[] }>(
      locationId, 'GET', `/forms/submissions`,
      undefined,
      { locationId, formId, limit: limit.toString() },
    );
    return response.submissions ?? [];
  }

  // ==========================================================================
  // Helper: Upsert Contact (create or update by phone)
  // ==========================================================================

  /**
   * Find contact by phone. If exists, update. If not, create.
   * This is the primary flow for voice agent call handling:
   *   1. Inbound call comes in
   *   2. Upsert contact by caller phone
   *   3. Create/update opportunity
   *   4. Log the call
   */
  async upsertContactByPhone(
    locationId: string,
    phone: string,
    params: Partial<GHLContactParams>,
  ): Promise<{ contact: GHLContact; isNew: boolean }> {
    const existing = await this.getContactByPhone(locationId, phone);

    if (existing) {
      const updated = await this.updateContact(locationId, existing.id, params);
      return { contact: updated, isNew: false };
    }

    if (!params.firstName) params.firstName = 'Unknown';
    if (!params.lastName) params.lastName = 'Caller';

    const created = await this.createContact(locationId, {
      ...params,
      phone,
    } as GHLContactParams);

    return { contact: created, isNew: true };
  }
}

// ============================================================================
// Error Type
// ============================================================================

export class GHLAPIError extends Error {
  statusCode: number;
  endpoint: string;

  constructor(message: string, statusCode: number, endpoint: string) {
    super(message);
    this.name = 'GHLAPIError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}
