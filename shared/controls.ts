import type { CheckSettings, GateSettings, WorkflowNode } from './types';

export const defaultCheckSettings: CheckSettings = {
  requireOutput: true, requireFindingEvidence: true, requireJudgment: false, blockedSeverities: [],
};
export const defaultGateSettings: GateSettings = { maxCorrections: 3, approval: 'human', risk: 'contained' };

/** Control nodes use no model and make no tool calls. */
export function makeControlNode(type: 'check' | 'gate', id: string, position: WorkflowNode['position']): WorkflowNode {
  return { id, type, position, data: {
    label: type === 'check' ? 'Report check' : 'Acceptance gate', role: 'custom', color: type === 'check' ? 'blue' : 'teal',
    description: type === 'check' ? 'Check report requirements with code' : 'Accept passing work or return a scoped correction',
    persona: '', prompt: '', responsibilities: [], tools: [], modelId: '', status: 'idle',
    ...(type === 'check' ? { check: { ...defaultCheckSettings, blockedSeverities: [] } } : { gate: { ...defaultGateSettings } }),
  } };
}
