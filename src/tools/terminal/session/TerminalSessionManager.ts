import type { TerminalSessionPlan } from './TerminalSession.js';

export type TerminalSessionStatus = 'idle' | 'busy' | 'closed';

export interface TerminalSessionRecord {
  id: string;
  status: TerminalSessionStatus;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  envKeys: string[];
  metadata?: Record<string, unknown>;
}

export interface TerminalSessionAcquireRequest {
  plan: TerminalSessionPlan;
  cwd: string;
  env: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export interface TerminalSessionLease {
  record: TerminalSessionRecord;
  release(update?: Partial<Omit<TerminalSessionRecord, 'id' | 'createdAt'>>): void;
}

export interface TerminalSessionManager {
  acquire(request: TerminalSessionAcquireRequest): TerminalSessionLease;
  get(id: string): TerminalSessionRecord | null;
  close(id: string): TerminalSessionRecord | null;
  list(): TerminalSessionRecord[];
  cleanup(now?: Date): TerminalSessionRecord[];
}
