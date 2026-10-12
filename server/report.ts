import path from 'node:path';
import type { Workflow } from '../shared/types';
import type { AgentReport } from './engine';
import type { ProjectReader } from './project';

export async function parseAgentReport(output: string, workflow: Workflow, project: ProjectReader, screenshot?: string): Promise<AgentReport> {
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
  return { findings, messages: parseMessages(body.messages, 'messages'), assignments: parseMessages(body.assignments, 'assignments'), ...(escalation ? { escalation } : {}) };
}
