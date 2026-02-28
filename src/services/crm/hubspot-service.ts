/**
 * HubSpot API Adapter — V3
 *
 * Primary CRM for: DMC (retail banking), IFSE (internal treasury ops)
 *
 * Uses: @hubspot/api-client (official Node.js SDK, v13+)
 * Auth: Private App token or OAuth 2.0
 * Rate Limit: 100 req/10 sec (private app), 500K/day
 *
 * HubSpot is used for DMC and IFSE because:
 *   - Enterprise reporting and dashboards for banking metrics
 *   - Service Hub ticketing for customer support
 *   - Marketing Hub sequences for DMC customer nurture
 *   - Custom objects for financial entities (vaults, loans, settlements)
 *   - Deep integration ecosystem (accounting, compliance tools)
 *
 * Voice agent interactions:
 *   DMC: Support tickets, call logging, contact lookup, FAQ
 *   IFSE: Internal ticket creation, ops notes (staff only)
 */

import { Client as HubSpotClient } from '@hubspot/api-client';
import type { Logger } from 'pino';
import type {
  IHubSpotService,
  HubSpotContact,
  HubSpotContactParams,
  HubSpotDeal,
  HubSpotDealParams,
  HubSpotEngagementParams,
  HubSpotCallParams,
  HubSpotEmailParams,
  HubSpotTicket,
  HubSpotTicketParams,
  HubSpotPipeline,
  HubSpotPipelineStage,
  HubSpotProperty,
  HubSpotSearchFilter,
} from '../contracts.js';

// ============================================================================
// Configuration
// ============================================================================

export interface HubSpotConfig {
  /** Private App access token */
  accessToken: string;

  /** Portal (Hub) ID */
  portalId: string;

  /** Custom property names used by Calculus voice agent */
  customProperties: {
    calculusModel: string;
    calculusCustomerId: string;
    calculusAuthTier: string;
    calculusConversationId: string;
    calculusCreatedByAgent: string;
  };

  /** Default pipeline IDs for DMC */
  pipelines: {
    dmc_support: string;
    dmc_onboarding: string;
  };
}

export const DEFAULT_HUBSPOT_CUSTOM_PROPERTIES = {
  calculusModel: 'calculus_model',
  calculusCustomerId: 'calculus_customer_id',
  calculusAuthTier: 'calculus_auth_tier',
  calculusConversationId: 'calculus_conversation_id',
  calculusCreatedByAgent: 'calculus_created_by_agent',
};

// ============================================================================
// HubSpot Service Implementation
// ============================================================================

export class HubSpotService implements IHubSpotService {
  private client: HubSpotClient;
  private config: HubSpotConfig;
  private logger: Logger;

  constructor(config: HubSpotConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child({ component: 'HubSpotService' });
    this.client = new HubSpotClient({ accessToken: config.accessToken });
  }

  // ==========================================================================
  // Contacts (CRM v3)
  // ==========================================================================

  async createContact(params: HubSpotContactParams): Promise<HubSpotContact> {
    this.logger.info({ email: params.email, phone: params.phone }, 'Creating HubSpot contact');

    const response = await this.client.crm.contacts.basicApi.create({
      properties: this.cleanProperties(params),
      associations: [],
    });

    return this.mapContact(response);
  }

  async getContact(contactId: string): Promise<HubSpotContact | null> {
    try {
      const response = await this.client.crm.contacts.basicApi.getById(
        contactId,
        [
          'firstname', 'lastname', 'email', 'phone', 'company',
          'jobtitle', 'lifecyclestage', 'hs_lead_status',
          this.config.customProperties.calculusModel,
          this.config.customProperties.calculusCustomerId,
        ],
      );
      return this.mapContact(response);
    } catch (error: any) {
      if (error?.code === 404) return null;
      throw error;
    }
  }

  async searchContacts(filters: HubSpotSearchFilter[]): Promise<HubSpotContact[]> {
    const response = await this.client.crm.contacts.searchApi.doSearch({
      filterGroups: [{ filters: filters.map(f => ({
        propertyName: f.propertyName,
        operator: f.operator as any,
        value: f.value,
      })) }],
      properties: [
        'firstname', 'lastname', 'email', 'phone', 'company',
        'lifecyclestage',
      ],
      limit: 100,
      after: '0',
      sorts: ['-createdate'],
    });

    return response.results.map(r => this.mapContact(r));
  }

  async updateContact(
    contactId: string,
    properties: Record<string, string>,
  ): Promise<HubSpotContact> {
    const response = await this.client.crm.contacts.basicApi.update(
      contactId,
      { properties: this.cleanProperties(properties) },
    );
    return this.mapContact(response);
  }

  async mergeContacts(primaryId: string, secondaryId: string): Promise<void> {
    this.logger.info({ primaryId, secondaryId }, 'Merging HubSpot contacts');
    await this.client.apiRequest({
      method: 'POST',
      path: '/crm/v3/objects/contacts/merge',
      body: {
        objectIdToMerge: secondaryId,
        primaryObjectId: primaryId,
      },
    });
  }

  // ==========================================================================
  // Deals
  // ==========================================================================

  async createDeal(params: HubSpotDealParams): Promise<HubSpotDeal> {
    this.logger.info({ name: params.dealname, pipeline: params.pipeline }, 'Creating HubSpot deal');

    const response = await this.client.crm.deals.basicApi.create({
      properties: this.cleanProperties(params),
      associations: [],
    });

    return this.mapDeal(response);
  }

  async getDeal(dealId: string): Promise<HubSpotDeal | null> {
    try {
      const response = await this.client.crm.deals.basicApi.getById(
        dealId,
        ['dealname', 'dealstage', 'pipeline', 'amount', 'closedate', 'hubspot_owner_id'],
      );
      return this.mapDeal(response);
    } catch (error: any) {
      if (error?.code === 404) return null;
      throw error;
    }
  }

  async updateDeal(
    dealId: string,
    properties: Record<string, string>,
  ): Promise<HubSpotDeal> {
    const response = await this.client.crm.deals.basicApi.update(
      dealId,
      { properties: this.cleanProperties(properties) },
    );
    return this.mapDeal(response);
  }

  async getDealsByPipeline(pipelineId: string, stage?: string): Promise<HubSpotDeal[]> {
    const filters: any[] = [
      { propertyName: 'pipeline', operator: 'EQ', value: pipelineId },
    ];
    if (stage) {
      filters.push({ propertyName: 'dealstage', operator: 'EQ', value: stage });
    }

    const response = await this.client.crm.deals.searchApi.doSearch({
      filterGroups: [{ filters }],
      properties: ['dealname', 'dealstage', 'pipeline', 'amount', 'closedate'],
      limit: 100,
      after: '0',
      sorts: ['-createdate'],
    });

    return response.results.map(r => this.mapDeal(r));
  }

  // ==========================================================================
  // Engagements / Activities
  // ==========================================================================

  async createEngagement(params: HubSpotEngagementParams): Promise<string> {
    // V3 engagements are created per-type (notes, calls, emails, etc.)
    // This is a generic method that routes to the correct API
    const typeMap: Record<string, string> = {
      NOTE: 'notes',
      CALL: 'calls',
      EMAIL: 'emails',
      TASK: 'tasks',
      MEETING: 'meetings',
    };

    const objectType = typeMap[params.type];
    if (!objectType) throw new Error(`Unsupported engagement type: ${params.type}`);

    const response = await this.client.apiRequest({
      method: 'POST',
      path: `/crm/v3/objects/${objectType}`,
      body: {
        properties: {
          hs_timestamp: params.timestamp.toISOString(),
          hs_body_preview: params.body.substring(0, 200),
          ...(params.metadata ?? {}),
        },
        associations: params.contactIds.map(id => ({
          to: { id },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 10 }],
        })),
      },
    });

    const json = await response.json() as any;
    return json.id;
  }

  async logCall(params: HubSpotCallParams): Promise<string> {
    this.logger.info({
      contactId: params.contactId,
      direction: params.direction,
      durationMs: params.durationMs,
    }, 'Logging call to HubSpot');

    const response = await this.client.apiRequest({
      method: 'POST',
      path: '/crm/v3/objects/calls',
      body: {
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_call_body: params.body,
          hs_call_duration: String(params.durationMs),
          hs_call_direction: params.direction,
          hs_call_disposition: params.disposition,
          hs_call_status: 'COMPLETED',
          ...(params.recordingUrl && { hs_call_recording_url: params.recordingUrl }),
          // Voice agent metadata
          ...(params.calculus_pipeline_mode && {
            [this.config.customProperties.calculusModel]: params.calculus_pipeline_mode,
          }),
        },
        associations: [
          {
            to: { id: params.contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }],
          },
          ...(params.dealId ? [{
            to: { id: params.dealId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 206 }],
          }] : []),
        ],
      },
    });

    const json = await response.json() as any;
    return json.id;
  }

  async logEmail(params: HubSpotEmailParams): Promise<string> {
    const response = await this.client.apiRequest({
      method: 'POST',
      path: '/crm/v3/objects/emails',
      body: {
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_email_subject: params.subject,
          hs_email_text: params.body,
          hs_email_direction: params.direction,
          hs_email_status: 'SENT',
        },
        associations: [{
          to: { id: params.contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 198 }],
        }],
      },
    });

    const json = await response.json() as any;
    return json.id;
  }

  async createNote(contactId: string, body: string): Promise<string> {
    const response = await this.client.apiRequest({
      method: 'POST',
      path: '/crm/v3/objects/notes',
      body: {
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_note_body: body,
        },
        associations: [{
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }],
        }],
      },
    });

    const json = await response.json() as any;
    return json.id;
  }

  // ==========================================================================
  // Tickets (Service Hub)
  // ==========================================================================

  async createTicket(params: HubSpotTicketParams): Promise<HubSpotTicket> {
    this.logger.info({ subject: params.subject, priority: params.hs_ticket_priority }, 'Creating HubSpot ticket');

    const response = await this.client.apiRequest({
      method: 'POST',
      path: '/crm/v3/objects/tickets',
      body: {
        properties: {
          subject: params.subject,
          content: params.content,
          hs_pipeline: params.hs_pipeline,
          hs_pipeline_stage: params.hs_pipeline_stage,
          hs_ticket_priority: params.hs_ticket_priority,
          ...(params.hubspot_owner_id && { hubspot_owner_id: params.hubspot_owner_id }),
        },
        associations: params.contactId ? [{
          to: { id: params.contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }],
        }] : [],
      },
    });

    const json = await response.json() as any;
    return {
      id: json.id,
      properties: json.properties,
      createdAt: new Date(json.createdAt),
      updatedAt: new Date(json.updatedAt),
    };
  }

  async getTicket(ticketId: string): Promise<HubSpotTicket | null> {
    try {
      const response = await this.client.apiRequest({
        method: 'GET',
        path: `/crm/v3/objects/tickets/${ticketId}`,
      });
      const json = await response.json() as any;
      return {
        id: json.id,
        properties: json.properties,
        createdAt: new Date(json.createdAt),
        updatedAt: new Date(json.updatedAt),
      };
    } catch {
      return null;
    }
  }

  async updateTicket(
    ticketId: string,
    properties: Record<string, string>,
  ): Promise<HubSpotTicket> {
    const response = await this.client.apiRequest({
      method: 'PATCH',
      path: `/crm/v3/objects/tickets/${ticketId}`,
      body: { properties },
    });
    const json = await response.json() as any;
    return {
      id: json.id,
      properties: json.properties,
      createdAt: new Date(json.createdAt),
      updatedAt: new Date(json.updatedAt),
    };
  }

  // ==========================================================================
  // Sequences (Marketing Hub)
  // ==========================================================================

  async enrollContactInSequence(
    contactId: string,
    sequenceId: string,
    senderId: string,
  ): Promise<void> {
    this.logger.info({ contactId, sequenceId }, 'Enrolling in HubSpot sequence');

    await this.client.apiRequest({
      method: 'POST',
      path: `/automation/v4/enrollments`,
      body: {
        inputPortId: 0,
        objectId: contactId,
        objectType: 'CONTACT',
        enrollmentId: sequenceId,
        ownerId: senderId,
      },
    });
  }

  async unenrollContactFromSequence(
    contactId: string,
    sequenceId: string,
  ): Promise<void> {
    await this.client.apiRequest({
      method: 'POST',
      path: `/automation/v4/enrollments/unenroll`,
      body: {
        objectId: contactId,
        objectType: 'CONTACT',
        enrollmentId: sequenceId,
      },
    });
  }

  // ==========================================================================
  // Workflows
  // ==========================================================================

  async enrollContactInWorkflow(contactId: string, workflowId: string): Promise<void> {
    await this.client.apiRequest({
      method: 'POST',
      path: `/automation/v4/actions/${workflowId}/enrollments`,
      body: {
        objectId: contactId,
        objectType: 'CONTACT',
      },
    });
  }

  // ==========================================================================
  // Custom Objects
  // ==========================================================================

  async createCustomObject(
    objectType: string,
    properties: Record<string, string>,
  ): Promise<string> {
    const response = await this.client.apiRequest({
      method: 'POST',
      path: `/crm/v3/objects/${objectType}`,
      body: { properties },
    });
    const json = await response.json() as any;
    return json.id;
  }

  async getCustomObject(
    objectType: string,
    objectId: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await this.client.apiRequest({
        method: 'GET',
        path: `/crm/v3/objects/${objectType}/${objectId}`,
      });
      return await response.json() as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async associateObjects(
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
    associationType: string,
  ): Promise<void> {
    await this.client.apiRequest({
      method: 'PUT',
      path: `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`,
      body: [{
        associationCategory: 'USER_DEFINED',
        associationTypeId: parseInt(associationType, 10),
      }],
    });
  }

  // ==========================================================================
  // Pipelines
  // ==========================================================================

  async getPipelines(objectType: 'deals' | 'tickets'): Promise<HubSpotPipeline[]> {
    const response = await this.client.crm.pipelines.pipelinesApi.getAll(objectType);
    return response.results.map(p => ({
      id: p.id,
      label: p.label,
      stages: p.stages.map(s => ({
        id: s.id,
        label: s.label,
        displayOrder: s.displayOrder,
        metadata: s.metadata as Record<string, string>,
      })),
    }));
  }

  async getPipelineStages(pipelineId: string): Promise<HubSpotPipelineStage[]> {
    const response = await this.client.crm.pipelines.pipelineStagesApi.getAll(
      'deals',
      pipelineId,
    );
    return response.results.map(s => ({
      id: s.id,
      label: s.label,
      displayOrder: s.displayOrder,
      metadata: s.metadata as Record<string, string>,
    }));
  }

  // ==========================================================================
  // Lists
  // ==========================================================================

  async addContactToList(contactId: string, listId: string): Promise<void> {
    await this.client.apiRequest({
      method: 'POST',
      path: `/contacts/v1/lists/${listId}/add`,
      body: { vids: [parseInt(contactId, 10)] },
    });
  }

  async removeContactFromList(contactId: string, listId: string): Promise<void> {
    await this.client.apiRequest({
      method: 'POST',
      path: `/contacts/v1/lists/${listId}/remove`,
      body: { vids: [parseInt(contactId, 10)] },
    });
  }

  // ==========================================================================
  // Properties
  // ==========================================================================

  async getPropertyDefinition(
    objectType: string,
    propertyName: string,
  ): Promise<HubSpotProperty | null> {
    try {
      const response = await this.client.crm.properties.coreApi.getByName(
        objectType,
        propertyName,
      );
      return {
        name: response.name,
        label: response.label,
        type: response.type,
        fieldType: response.fieldType,
        options: response.options?.map(o => ({
          label: o.label,
          value: o.value,
        })),
      };
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Helper: Search contact by phone (for voice agent call handling)
  // ==========================================================================

  async getContactByPhone(phone: string): Promise<HubSpotContact | null> {
    const results = await this.searchContacts([
      { propertyName: 'phone', operator: 'EQ', value: phone },
    ]);
    return results[0] ?? null;
  }

  async getContactByEmail(email: string): Promise<HubSpotContact | null> {
    const results = await this.searchContacts([
      { propertyName: 'email', operator: 'EQ', value: email },
    ]);
    return results[0] ?? null;
  }

  // ==========================================================================
  // Mappers
  // ==========================================================================

  private mapContact(raw: any): HubSpotContact {
    return {
      id: raw.id,
      properties: raw.properties ?? {},
      createdAt: new Date(raw.createdAt),
      updatedAt: new Date(raw.updatedAt),
      associations: raw.associations,
    };
  }

  private mapDeal(raw: any): HubSpotDeal {
    return {
      id: raw.id,
      properties: raw.properties ?? {},
      createdAt: new Date(raw.createdAt),
      updatedAt: new Date(raw.updatedAt),
      associations: raw.associations,
    };
  }

  /** Remove undefined/null values from properties object */
  private cleanProperties(props: Record<string, any>): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(props)) {
      if (v !== undefined && v !== null) {
        clean[k] = String(v);
      }
    }
    return clean;
  }
}
