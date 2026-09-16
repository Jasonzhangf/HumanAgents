import type { AgentIoBudgetRecord, AgentIoRestartBudgetStore } from './types.js';

export function createMemoryRestartBudgetStore(): AgentIoRestartBudgetStore {
  const records = new Map<string, AgentIoBudgetRecord>();
  return {
    async read(requestId) {
      return records.get(requestId) ? structuredClone(records.get(requestId)!) : null;
    },
    async write(requestId, record) {
      records.set(requestId, structuredClone(record));
    },
  };
}

export function emptyAgentIoBudgetRecord(): AgentIoBudgetRecord {
  return { totalTurns: 0, noProgressTurns: 0, controlRepairAttempts: 0, restartCount: 0 };
}
