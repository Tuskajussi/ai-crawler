import path from 'node:path';
import type { NodeResult, Workflow } from '../shared/types';
import type { AgentReport } from './engine';
import type { ProjectReader } from './project';

export interface ReportInputs { upstreamResults: NodeResult[]; isJudge: boolean; }

export async function parseAgentReport(output: string, workflow: Workflow, project: ProjectReader, screenshot?: string, inputs?: ReportInputs): Promise<AgentReport> {
  const cleaned = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); } catch { throw new Error('Agent returned an invalid report. Expected a JSON object with findings, messages, and assignments.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Agent report must be a JSON object.');
  const body = parsed as Record<string, unknown>;
  const validText = (value: unknown, maximum = 10_000): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= maximum;
  const findings: NonNullable<AgentReport['findings']> = [];
  if (!Array.isArray(body.findings) || body.findings.length > 30) throw new Error('Agent report findings must be an array of at most 30 entries.');
  for (const item of body.findings) {
    if (!item || typeof item !== 'object' || !validText(item.title, 300) || !validText(item.description) || !['critical', 'high', 'medium', 'low'].includes(item.severity)) throw new Error('Agent returned a malformed finding. Each needs title, description, and a valid severity.');
    const finding: NonNullable<AgentReport['findings']>[number] = { title: item.title, description: item.description, severity: item.severity };
    if (item.file !== undefined) {
      if (!validText(item.file, 4000)) throw new Error('Finding file must be a project-relative path.');
      const resolved = await project.resolve(item.file);
      if (!project.hasObserved(resolved)) throw new Error('Finding refers to a file the agent did not inspect. Read the evidence before reporting it.');
      finding.file = path.relative(project.root, resolved).replaceAll('\\', '/');
    }
    if (item.line !== undefined) {
      if (!finding.file || !Number.isInteger(item.line) || item.line < 1 || item.line > 10_000_000) throw new Error('Finding line must be a positive line number attached to a real project file.');
      finding.line = item.line;
      if (item.line > await project.lineCount(finding.file)) throw new Error('Finding line number is beyond the referenced file.');
    }
    if (!finding.file && !screenshot) throw new Error('A real finding must reference a verified project file or a captured UI screenshot.');
    if (screenshot) finding.screenshot = screenshot;
    findings.push(finding);
  }
  const parseMessages = (value: unknown, label: string): { to: string; text: string }[] => {
    if (!Array.isArray(value) || value.length > 30) throw new Error(`Agent ${label} must be an array of at most 30 entries.`);
    return value.map(item => {
      if (!item || typeof item !== 'object' || !validText(item.text) || (item.to !== 'all' && !workflow.nodes.some(node => node.id === item.to))) throw new Error(`Agent returned an invalid ${label} recipient or message.`);
      return { to: item.to as string, text: item.text as string };
    });
  };
  let escalation: AgentReport['escalation'];
  if (body.escalation !== undefined) {
    if (!body.escalation || typeof body.escalation !== 'object' || Array.isArray(body.escalation)
      || !validText((body.escalation as Record<string, unknown>).reason, 2000)
      || Object.keys(body.escalation).some(key => key !== 'reason')) throw new Error('Agent escalation must contain only a reason of 1–2,000 characters.');
    escalation = { reason: ((body.escalation as Record<string, unknown>).reason as string).trim() };
  }
  const messages = parseMessages(body.messages, 'messages');
  const assignments = parseMessages(body.assignments, 'assignments');
  if (body.output !== undefined && !validText(body.output, 30_000)) throw new Error('Agent output must be nonempty text of at most 30,000 characters.');
  if (inputs?.isJudge && body.output === undefined) throw new Error('Judge report must include its complete evaluation in output.');
  // Older reviewer reports still produce a useful handoff without dropping observed evidence.
  const fallback = findings.length
    ? findings.map(finding => `${finding.title}: ${finding.description}`).join('\n\n')
    : messages.map(message => message.text).join('\n\n') || 'Review completed with no verified findings.';
  const report: AgentReport = { output: (body.output as string | undefined) ?? fallback.slice(0, 30_000), findings, messages, assignments, ...(escalation ? { escalation } : {}) };
  if (inputs?.isJudge || body.judgment !== undefined) {
    if (!inputs?.isJudge) throw new Error('Only a judge agent may return a judgment.');
    const judgment = body.judgment;
    if (!judgment || typeof judgment !== 'object' || Array.isArray(judgment)) throw new Error('Judge report must include a judgment object.');
    const result = judgment as Record<string, unknown>;
    const candidateIds = new Set(inputs.upstreamResults.map(candidate => candidate.nodeId));
    if (candidateIds.size < 2) throw new Error('A judge needs results from at least two direct predecessor agents.');
    if (!validText(result.reasoning) || !Array.isArray(result.scores) || result.scores.length !== candidateIds.size) throw new Error('Judge must explain its decision and score every direct predecessor exactly once.');
    const scored = new Set<string>();
    const scores: NonNullable<NodeResult['judgment']>['scores'] = result.scores.map(item => {
      if (!item || typeof item !== 'object' || typeof item.nodeId !== 'string' || !candidateIds.has(item.nodeId) || scored.has(item.nodeId) || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 100 || !validText(item.reasoning)) throw new Error('Judge scores must reference each direct predecessor once, with a score from 0 to 100 and reasoning.');
      scored.add(item.nodeId);
      return { nodeId: item.nodeId, score: item.score, reasoning: item.reasoning };
    });
    const bestScore = Math.max(...scores.map(score => score.score));
    const best = scores.filter(score => score.score === bestScore);
    if (result.winnerNodeId !== null && (typeof result.winnerNodeId !== 'string' || !candidateIds.has(result.winnerNodeId))) throw new Error('Judge winner must be a direct predecessor or null for a tie.');
    if (best.length === 1 ? result.winnerNodeId !== best[0].nodeId : result.winnerNodeId !== null) throw new Error('Judge winner must match the highest score; tied highest scores require a null winner.');
    report.judgment = { winnerNodeId: result.winnerNodeId as string | null, reasoning: result.reasoning, scores };
  }
  return report;
}
