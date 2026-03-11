/**
 * Flow Registry — Maps agent models to their flow controllers
 *
 * Usage:
 *   const flow = getFlowController('CONSTITUTIONAL_TENDER');
 *   const state = flow.createInitialState('inbound');
 *   const prompt = flow.buildSystemPrompt(state);
 */

export type { AgentModel, ConversationPhase, PhaseTransition, FlowState, IFlowController, TransitionCondition } from './types.js';
export { BASE_SYSTEM_PROMPT, createBaseFlowState, matchCondition } from './types.js';
export { BaseFlowController } from './base-flow.js';

export { DMCFlowController } from './dmc-flow.js';
export { CTFlowController } from './ct-flow.js';
export { TILTFlowController } from './tilt-flow.js';
export { MortgageFlowController } from './mortgage-flow.js';
export { RealEstateFlowController } from './real-estate-flow.js';
export { EurekaFlowController, LoanServicingFlowController, IFSEFlowController } from './eureka-loan-ifse-flows.js';
export { JackFlowController } from './jack-flow.js';
export { BunnyFlowController } from './bunny-flow.js';
export { JennyFlowController } from './jenny-flow.js';

import type { AgentModel, IFlowController } from './types.js';
import { DMCFlowController } from './dmc-flow.js';
import { CTFlowController } from './ct-flow.js';
import { TILTFlowController } from './tilt-flow.js';
import { MortgageFlowController } from './mortgage-flow.js';
import { RealEstateFlowController } from './real-estate-flow.js';
import { EurekaFlowController, LoanServicingFlowController, IFSEFlowController } from './eureka-loan-ifse-flows.js';
import { JackFlowController } from './jack-flow.js';
import { BunnyFlowController } from './bunny-flow.js';
import { JennyFlowController } from './jenny-flow.js';

// Singleton instances
const flows = new Map<AgentModel, IFlowController>();

function initFlows(): void {
  if (flows.size > 0) return;
  const controllers: IFlowController[] = [
    new DMCFlowController(),
    new CTFlowController(),
    new TILTFlowController(),
    new MortgageFlowController(),
    new RealEstateFlowController(),
    new EurekaFlowController(),
    new LoanServicingFlowController(),
    new IFSEFlowController(),
    new JackFlowController(),
    new BunnyFlowController(),
    new JennyFlowController(),
  ];
  for (const c of controllers) {
    flows.set(c.model, c);
  }
}

/**
 * Get the flow controller for a given agent model.
 * Falls back to DMC if the model is unknown.
 */
export function getFlowController(model: AgentModel | string): IFlowController {
  initFlows();
  return flows.get(model as AgentModel) ?? flows.get('DMC')!;
}

/**
 * Get all registered flow controllers.
 */
export function getAllFlowControllers(): IFlowController[] {
  initFlows();
  return Array.from(flows.values());
}

/**
 * Get the list of all supported agent models.
 */
export function getSupportedModels(): AgentModel[] {
  initFlows();
  return Array.from(flows.keys());
}
