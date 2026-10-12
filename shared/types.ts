export type AgentRole = 'crawler' | 'tester' | 'designer' | 'reviewer' | 'coordinator' | 'custom';
export type AgentStatus = 'idle' | 'running' | 'done' | 'error';
export interface AgentData extends Record<string, unknown> {
  label: string; role: AgentRole; description: string; persona: string; prompt: string;
  responsibilities: string[]; modelId: string; color: string;
  tools: ('read' | 'screenshot')[]; status: AgentStatus;
}
export interface WorkflowNode { id: string; type: 'agent'; position: {x: number; y: number}; data: AgentData; }
export interface WorkflowEdge { id: string; source: string; target: string; label?: string; type?: string; animated?: boolean; data?: {loop?: boolean}; }
export interface RoutingSettings {
  mode: 'off' | 'shadow' | 'active'; backend: 'system-one' | 'llama-cpp';
  baseUrl: string; modelId: string; apiKeyEnv: string; confidenceThreshold: number;
  timeoutSeconds: number; maxDecisionsPerCycle: number; maxDecisionsPerRun: number;
  maxConcurrentRequests: number; contextWindow: number; temperature: number;
}
export type RoutingChoice = 'assigned' | 'supervisor' | 'review';
export interface RoutingAnswer {
  choice: RoutingChoice; probabilities: Record<RoutingChoice, number>; confidence: number;
  modelId: string; durationMs: number; inputTokens: number;
}
export interface RoutingDecision {
  id: string; nodeId: string; cycle: number; createdAt: string; questionVersion: string;
  mode: 'shadow' | 'active'; backend: RoutingSettings['backend']; configuredModelId: string;
  modelId?: string; threshold: number; status: 'pending' | 'completed' | 'error' | 'cancelled' | 'budget';
  choice?: RoutingChoice; probabilities?: Record<RoutingChoice, number>; confidence?: number;
  recommendation?: RoutingChoice; selectedModelId?: string; reason?: string; durationMs?: number; inputTokens?: number;
}
export interface Workflow {
  id: string; name: string; description: string; nodes: WorkflowNode[]; edges: WorkflowEdge[];
  settings: {mode: 'loop' | 'once'; maxCycles: number; continuous?: boolean; intervalSeconds: number; entryNodeId: string; projectPath: string; previewUrl: string; executionMode: 'demo' | 'pi'; codeMode?: boolean; supervisorModelId?: string; maxEscalationsPerCycle?: number; maxEscalationsPerRun?: number; maxParallelAgents?: number; routing?: RoutingSettings};
}
export interface ModelConfig { id: string; name: string; provider: 'anthropic' | 'openai' | 'ollama' | 'custom'; modelId: string; kind: 'local' | 'cloud'; baseUrl: string; apiKeyEnv: string; enabled: boolean; contextWindow?: number; supportsImages?: boolean; maxOutputTokens?: number; timeoutSeconds?: number; reasoningEffort?: 'off' | 'low' | 'medium' | 'high'; authMethod?: 'apiKey' | 'chatgpt'; chatgptProfileId?: string; maxConcurrentRequests?: number; }
export interface ModelReadiness { id: string; ready: boolean; message: string; }
export interface RuntimeStatus { piAvailable: boolean; models: ModelReadiness[]; }
export interface Finding { id: string; title: string; description: string; severity: 'critical' | 'high' | 'medium' | 'low'; status: 'open' | 'in_progress' | 'resolved'; file?: string; line?: number; nodeId: string; createdAt: string; screenshot?: string; demo?: boolean; }
export interface Message { id: string; from: string; to: string; text: string; type: 'message' | 'assignment' | 'system'; createdAt: string; runId?: string; }
export interface Run { id: string; status: 'running' | 'completed' | 'stopped' | 'failed'; mode: 'demo' | 'pi'; startedAt: string; finishedAt?: string; cycle: number; steps: number; escalations?: number; activeNodeId?: string; activeNodeIds?: string[]; error?: string; decisionCount?: number; decisions?: RoutingDecision[]; }
export interface AppState { workflow: Workflow; models: ModelConfig[]; findings: Finding[]; messages: Message[]; runs: Run[]; }
