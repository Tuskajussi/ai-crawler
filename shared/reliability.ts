import type { ModelConfig } from './types';

export const reliabilityToolNames = ['project_read', 'project_ls', 'project_find', 'project_grep', 'list_staff', 'capture_ui', 'codemode', 'connection_check', '[unknown tool]'] as const;
export type ReliabilityToolName = typeof reliabilityToolNames[number];
export const reliabilityOutcomes = ['success', 'invalid_arguments', 'unknown_tool', 'execution_error', 'code_error', 'blocked', 'cancelled', 'interrupted', 'truncated'] as const;
export type ReliabilityOutcome = typeof reliabilityOutcomes[number];
export type ReliabilityVisitStatus = 'success' | 'failed' | 'cancelled' | 'interrupted';
export type ReliabilityFailure = 'transient' | 'report' | 'configuration' | 'timeout';

/** Execution settings only. Credentials, environment-variable names and request content are excluded. */
export interface ReliabilityModel {
  fingerprint: string; configId: string; name: string; provider: ModelConfig['provider']; kind: ModelConfig['kind'];
  modelId: string; endpoint: string; authMethod: 'apiKey' | 'chatgpt'; chatgptProfileId?: string;
  reasoningEffort: NonNullable<ModelConfig['reasoningEffort']>; contextWindow: number; maxOutputTokens: number;
  timeoutSeconds: number; maxConcurrentRequests: number; supportsImages: boolean;
}
export interface ReliabilityToolCall { tool: ReliabilityToolName; outcome: ReliabilityOutcome; durationMs: number }
export interface ReliabilityVisit {
  id: string; model: ReliabilityModel; runId: string; nodeId: string; cycle: number; source: 'workflow' | 'probe';
  codeMode: boolean; status: ReliabilityVisitStatus; failure?: ReliabilityFailure;
  startedAt: string; finishedAt: string; durationMs: number; retryAttempts: number; requests: number;
  providerFailures: number; reportRejections: number; reportRepairs: number; calls: ReliabilityToolCall[]; omittedCalls: number;
}
export interface ReliabilityToolSummary {
  total: number; completed: number; outcomes: Record<ReliabilityOutcome, number>;
  /** Success / completed. Blocked, cancelled and interrupted calls are excluded; null means no completed calls. */
  successRate: number | null;
  averageDurationMs: number | null;
}
export interface ModelReliabilitySummary {
  key: string; model: ReliabilityModel; codeMode: boolean; visits: number;
  statuses: Record<ReliabilityVisitStatus, number>; failures: Record<ReliabilityFailure, number>; modelFailures: number;
  retryAttempts: number; requests: number; providerFailures: number; reportRejections: number; reportRepairs: number;
  tools: ReliabilityToolSummary; codeModeCalls: ReliabilityToolSummary;
  byTool: Partial<Record<ReliabilityToolName, ReliabilityToolSummary>>; omittedCalls: number; lastSeenAt: string;
}
export interface ReliabilitySnapshot {
  version: 1; retention: { maxVisits: 1000; retainedVisits: number; oldestAt?: string };
  models: ModelReliabilitySummary[]; recentVisits: ReliabilityVisit[];
  storage: { healthy: boolean; message?: string }; updatedAt: string;
}
