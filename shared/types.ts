export type AgentRole = 'crawler' | 'tester' | 'designer' | 'reviewer' | 'coordinator' | 'judge' | 'custom';
export type AgentStatus = 'idle' | 'running' | 'done' | 'error';
export interface AgentData extends Record<string, unknown> {
  label: string; role: AgentRole; description: string; persona: string; prompt: string;
  responsibilities: string[]; modelId: string; color: string;
  tools: ('read' | 'screenshot' | 'edit' | 'test')[]; status: AgentStatus; judgeRubric?: string;
  check?: CheckSettings; gate?: GateSettings;
}
export interface CheckSettings {
  requireOutput: boolean; requireFindingEvidence: boolean; requireJudgment: boolean;
  blockedSeverities: ReportFinding['severity'][];
  requireTests?: boolean;
}
export interface ProjectCommand { id: string; name: string; command: string; timeoutSeconds: number; }
export interface ProjectSettings { path: string; previewUrl: string; allowEdits: boolean; allowTests: boolean; testCommands: ProjectCommand[]; }
export interface TestExecution { commandId: string; name: string; exitCode: number | null; passed: boolean; timedOut: boolean; durationMs: number; output: string; projectRevision?: number; }
export interface ProjectChange { path: string; action: 'created' | 'edited'; }
export interface GateSettings { maxCorrections: number; approval: 'automatic' | 'human'; risk: 'contained' | 'wide' | 'high-impact'; }
export interface WorkflowLesson { id: string; text: string; nodeIds: string[]; enabled: boolean; }
export interface CheckUnit { nodeId: string; passed: boolean; retryable: boolean; reasons: string[]; }
export interface CheckOutcome { passed: boolean; units: CheckUnit[]; }
export interface GateOutcome { verdict: 'accepted' | 'rejected'; checkNodeIds: string[]; corrections: number; risk: GateSettings['risk']; approvedByHuman?: boolean; }
export interface UnitOutcome { id: string; nodeId: string; gateNodeId: string; cycle: number; attempt: number; verdict: 'accepted' | 'rejected'; reasons: string[]; modelId: string; createdAt: string; }
export interface GateApproval { gateNodeId: string; cycle: number; status: 'pending' | 'approved' | 'rejected'; requestedAt: string; resolvedAt?: string; results?: NodeResult[]; }
export interface WorkflowNode { id: string; type: 'agent' | 'check' | 'gate'; position: {x: number; y: number}; data: AgentData; }
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
  settings: {mode: 'loop' | 'once'; maxCycles: number; continuous?: boolean; intervalSeconds: number; entryNodeId: string; projectPath: string; previewUrl: string; executionMode: 'demo' | 'pi'; codeMode?: boolean; supervisorModelId?: string; maxEscalationsPerCycle?: number; maxEscalationsPerRun?: number; maxParallelAgents?: number; maxParallel?: number; routing?: RoutingSettings; lessons?: WorkflowLesson[]};
}
export interface ModelConfig { id: string; name: string; provider: 'anthropic' | 'openai' | 'ollama' | 'custom'; modelId: string; kind: 'local' | 'cloud'; baseUrl: string; apiKeyEnv: string; enabled: boolean; contextWindow?: number; supportsImages?: boolean; maxOutputTokens?: number; timeoutSeconds?: number; reasoningEffort?: 'off' | 'low' | 'medium' | 'high'; authMethod?: 'apiKey' | 'chatgpt'; chatgptProfileId?: string; maxConcurrentRequests?: number; }
export interface ModelReadiness { id: string; ready: boolean; message: string; }
export interface RuntimeStatus { piAvailable: boolean; models: ModelReadiness[]; }
export interface Finding { id: string; title: string; description: string; severity: 'critical' | 'high' | 'medium' | 'low'; status: 'open' | 'in_progress' | 'resolved'; file?: string; line?: number; nodeId: string; createdAt: string; screenshot?: string; demo?: boolean; }
export interface Message { id: string; from: string; to: string; text: string; type: 'message' | 'assignment' | 'system'; createdAt: string; runId?: string; }
export interface ReportFinding {title: string; description: string; severity: Finding['severity']; file?: string; line?: number; screenshot?: string; demo?: boolean;}
export interface Judgment {winnerNodeId: string | null; reasoning: string; scores: {nodeId: string; score: number; reasoning: string}[];}
export type ExecutionResult = Judgment;
export interface NodeResult {nodeId: string; nodeName: string; modelId: string; cycle: number; output: string; findings: ReportFinding[]; judgment?: Judgment; check?: CheckOutcome; gate?: GateOutcome; attempt?: number; tests?: TestExecution[]; changes?: ProjectChange[]; requiredTestIds?: string[]; projectRevision?: number; completedAt: string;}
export interface Run { id: string; status: 'running' | 'completed' | 'stopped' | 'failed'; mode: 'demo' | 'pi'; startedAt: string; finishedAt?: string; cycle: number; steps: number; escalations?: number; activeNodeId?: string; activeNodeIds?: string[]; results?: NodeResult[]; error?: string; decisionCount?: number; decisions?: RoutingDecision[]; outcomes?: UnitOutcome[]; approval?: GateApproval; }
export interface AppState { workflow: Workflow; models: ModelConfig[]; findings: Finding[]; messages: Message[]; runs: Run[]; workspace?: WorkspaceInfo; project?: ProjectSettings; }
export interface PublicUser { id: string; username: string; createdAt: string; }
export interface AuthSession { user: PublicUser | null; csrfToken?: string; registrationEnabled: boolean; }
export interface WorkspaceInfo { projectsRoot: string; hosted: boolean; modelKeyNames: string[]; modelEndpointOrigins: string[]; previewOrigins: string[]; }
