/**
 * Call Registry — Singleton tracking all active calls
 *
 * Decouples the server's active call state from the dashboard.
 * Server writes to it, dashboard reads from it.
 */

import { EventEmitter } from 'events';

export interface ActiveCall {
  callSid: string;
  model: string;
  direction: 'inbound' | 'outbound';
  callerPhone: string;
  calledPhone: string;
  startedAt: Date;
  pipelineMode: string;
}

class CallRegistryImpl extends EventEmitter {
  private calls = new Map<string, ActiveCall>();

  register(call: ActiveCall): void {
    this.calls.set(call.callSid, call);
    this.emit('call:started', call);
  }

  unregister(callSid: string, reason: string = 'completed'): void {
    const call = this.calls.get(callSid);
    if (call) {
      this.calls.delete(callSid);
      const durationMs = Date.now() - call.startedAt.getTime();
      this.emit('call:ended', { callSid, reason, durationMs });
    }
  }

  get(callSid: string): ActiveCall | undefined {
    return this.calls.get(callSid);
  }

  getAll(): ActiveCall[] {
    return Array.from(this.calls.values());
  }

  get size(): number {
    return this.calls.size;
  }
}

/** Global singleton — import from anywhere */
export const callRegistry = new CallRegistryImpl();
