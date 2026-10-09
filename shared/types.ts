export type AgentRole = 'crawler' | 'tester' | 'designer' | 'reviewer' | 'coordinator' | 'custom';
export type AgentStatus = 'idle' | 'running' | 'done' | 'error';
export interface AgentData extends Record<string, unknown> {
  label: string; role: AgentRole; description: string; persona: string; prompt: string;
  responsibilities: string[]; modelId: string; color: string;
  tools: ('read' | 'screenshot')[]; status: AgentStatus;
}
export interface WorkflowNode { id: string; type: 'agent'; position: {x: number; y: number}; data: AgentData; }
export interface WorkflowEdge { id: string; source: string; target: string; label?: string; type?: string; animated?: boolean; data?: {loop?: boolean}; }
export interface Workflow {
  id: string; name: string; description: string; nodes: WorkflowNode[]; edges: WorkflowEdge[];
  settings: {mode: 'loop' | 'once'; maxCycles: number; continuous?: boolean; intervalSeconds: number; entryNodeId: string; projectPath: string; previewUrl: string; executionMode: 'demo' | 'pi'};
}
export interface ModelConfig { id: string; name: string; provider: 'anthropic' | 'openai' | 'ollama' | 'custom'; modelId: string; kind: 'local' | 'cloud'; baseUrl: string; apiKeyEnv: string; enabled: boolean; contextWindow?: number; supportsImages?: boolean; }
export interface Finding { id: string; title: string; description: string; severity: 'critical' | 'high' | 'medium' | 'low'; status: 'open' | 'in_progress' | 'resolved'; file?: string; line?: number; nodeId: string; createdAt: string; screenshot?: string; demo?: boolean; }
export interface Message { id: string; from: string; to: string; text: string; type: 'message' | 'assignment' | 'system'; createdAt: string; runId?: string; }
export interface Run { id: string; status: 'running' | 'completed' | 'stopped' | 'failed'; mode: 'demo' | 'pi'; startedAt: string; finishedAt?: string; cycle: number; steps: number; activeNodeId?: string; error?: string; }
export interface AppState { workflow: Workflow; models: ModelConfig[]; findings: Finding[]; messages: Message[]; runs: Run[]; }
