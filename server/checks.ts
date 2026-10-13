import type { CheckOutcome, CheckUnit, Judgment, NodeResult, WorkflowNode } from '../shared/types';

function validJudgment(value: Judgment | undefined): boolean {
  if (!value || typeof value.reasoning !== 'string' || !value.reasoning.trim() || !Array.isArray(value.scores) || value.scores.length < 2) return false;
  if (new Set(value.scores.map(score => score?.nodeId)).size !== value.scores.length || value.scores.some(score => !score
    || typeof score.nodeId !== 'string' || !score.nodeId || !Number.isFinite(score.score) || score.score < 0 || score.score > 100
    || typeof score.reasoning !== 'string' || !score.reasoning.trim())) return false;
  const highest = Math.max(...value.scores.map(score => score.score));
  const winners = value.scores.filter(score => score.score === highest);
  return winners.length === 1 ? value.winnerNodeId === winners[0].nodeId : value.winnerNodeId === null;
}

/** Evaluate already-verified direct agent reports without invoking a model or a tool. */
export function evaluateCheck(node: WorkflowNode, inputs: NodeResult[], projectRevision?: number): CheckOutcome {
  const settings = node.data.check;
  if (node.type !== 'check' || !settings || inputs.length > 100) return {
    passed: false, units: [{ nodeId: node.id, passed: false, retryable: false, reasons: ['Check configuration or input count is invalid.'] }],
  };
  const counts = new Map<string, number>();
  for (const result of inputs) counts.set(result.nodeId, (counts.get(result.nodeId) ?? 0) + 1);
  const units: CheckUnit[] = [...new Map(inputs.map(result => [result.nodeId, result])).values()].map(result => {
    const reasons: string[] = [];
    let retryable = true;
    const add = (reason: string, essential = false) => {
      if (reasons.length < 30) reasons.push(reason.slice(0, 1000));
      else if (essential) reasons[29] = reason.slice(0, 1000);
    };
    if (counts.get(result.nodeId)! > 1 || result.check !== undefined || result.gate !== undefined) {
      add('Checks require one direct agent report per unit; deterministic results and duplicate reports are invalid.');
      retryable = false;
    }
    if (settings.requireOutput && (typeof result.output !== 'string' || !result.output.trim())) add('The report needs a non-empty output describing the completed assignment.');
    if (!Array.isArray(result.findings)) {
      add('The report needs a findings list, which may be empty when no issues were found.');
    } else for (const finding of result.findings) {
      const title = typeof finding?.title === 'string' ? finding.title.slice(0, 300) : 'Untitled finding';
      if (settings.requireFindingEvidence) {
        const source = typeof finding?.file === 'string' && Boolean(finding.file.trim()) && Number.isSafeInteger(finding.line) && finding.line! > 0;
        const screenshot = typeof finding?.screenshot === 'string' && Boolean(finding.screenshot.trim());
        if (finding?.demo === true) add(`Finding "${title}" contains demo evidence. Run a real inspection to provide a verified source line or screenshot.`);
        else if (!source && !screenshot) add(`Finding "${title}" needs a verified file with a positive line number, or a captured screenshot.`);
      }
      if (settings.blockedSeverities.includes(finding?.severity)) {
        add(`Finding "${title}" has blocked severity ${finding.severity}. Resolve or review the reported issue; do not hide it by rewriting the report.`, true);
        retryable = false;
      }
    }
    if (settings.requireJudgment && !validJudgment(result.judgment)) add('The report needs a complete judgment with scores, reasoning, and a winner consistent with the highest score.');
    if (settings.requireTests && (!result.requiredTestIds?.length || !result.tests?.length
      || result.requiredTestIds.some(id => !result.tests!.some(test => test.commandId === id && test.passed && test.exitCode === 0 && !test.timedOut && (projectRevision === undefined || test.projectRevision === projectRevision)))
      || result.tests.some(test => !test.passed || test.exitCode !== 0 || test.timedOut))) add('Run every configured test command after the last edit and correct any failures. The latest actual executions must all pass; a model claim is not test evidence.');
    return { nodeId: result.nodeId, passed: reasons.length === 0, retryable: reasons.length > 0 && retryable, reasons };
  });
  // Empty input cannot approve work, even when every optional criterion is disabled.
  return { passed: units.length > 0 && units.every(unit => unit.passed), units };
}
