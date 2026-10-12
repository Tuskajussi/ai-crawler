import type { ModelConfig, Workflow } from '../shared/types';
import { traversalOrder } from './validation';

export interface VisitComponent {
  id: string;
  nodeIds: string[];
  dependencies: string[];
}

/** Plan one cycle. Feedback edges carry context into the next cycle, not a dependency now. */
export function planWorkflow(workflow: Workflow): VisitComponent[] {
  const order = traversalOrder(workflow);
  const rank = new Map(order.map((id, index) => [id, index]));
  const outgoing = new Map(order.map(id => [id, [] as string[]]));
  for (const edge of workflow.edges) {
    if (edge.data?.loop === true || edge.target === workflow.settings.entryNodeId) continue;
    if (outgoing.has(edge.source) && outgoing.has(edge.target)) outgoing.get(edge.source)!.push(edge.target);
  }

  // Condense unannotated cycles so no dependency can deadlock the worker queue.
  // Nodes in a component keep the legacy traversal order and run sequentially.
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const groups: string[][] = [];
  const visit = (id: string) => {
    indices.set(id, index);
    low.set(id, index++);
    stack.push(id);
    stacked.add(id);
    for (const target of outgoing.get(id)!) {
      if (!indices.has(target)) {
        visit(target);
        low.set(id, Math.min(low.get(id)!, low.get(target)!));
      } else if (stacked.has(target)) low.set(id, Math.min(low.get(id)!, indices.get(target)!));
    }
    if (low.get(id) !== indices.get(id)) return;
    const group: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      stacked.delete(member);
      group.push(member);
    } while (member !== id);
    group.sort((left, right) => rank.get(left)! - rank.get(right)!);
    groups.push(group);
  };
  for (const id of order) if (!indices.has(id)) visit(id);
  groups.sort((left, right) => rank.get(left[0])! - rank.get(right[0])!);

  const membership = new Map(groups.flatMap(group => group.map(id => [id, group[0]] as const)));
  const components = groups.map(nodeIds => ({ id: nodeIds[0], nodeIds, dependencies: [] as string[] }));
  const dependencies = new Map(components.map(component => [component.id, new Set<string>()]));
  for (const [source, targets] of outgoing) {
    for (const target of targets) {
      const from = membership.get(source)!;
      const to = membership.get(target)!;
      if (from !== to) dependencies.get(to)!.add(from);
    }
  }
  for (const component of components) {
    component.dependencies = [...dependencies.get(component.id)!].sort((left, right) => rank.get(left)! - rank.get(right)!);
  }
  return components;
}

/** Models sharing a server also share its capacity, regardless of provider or path aliases. */
export function endpointKey(model: ModelConfig): string {
  const fallback = model.provider === 'anthropic' ? 'https://api.anthropic.com'
    : model.provider === 'openai' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:11434/v1';
  const url = new URL(model.baseUrl.trim() || fallback);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (['localhost', '127.0.0.1', '[::1]'].includes(hostname)) url.hostname = '127.0.0.1';
  else url.hostname = hostname;
  return url.origin;
}

interface Waiter {
  signal: AbortSignal;
  pool: EndpointPool;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  cancel: () => void;
}
interface EndpointPool { limit: number; active: number; }

function abortError(): DOMException { return new DOMException('Run stopped.', 'AbortError'); }

function modelLimit(model: ModelConfig): number {
  const value = model.maxConcurrentRequests;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 1;
}

export class EndpointLimiter {
  private pools = new Map<string, EndpointPool>();
  private queue: Waiter[] = [];
  private active = 0;
  private maximum: number;

  constructor(models: ModelConfig[], maxConcurrentVisits = 8) {
    this.maximum = Number.isInteger(maxConcurrentVisits) && maxConcurrentVisits > 0 ? maxConcurrentVisits : 1;
    for (const model of models.filter(item => item.enabled)) {
      const key = endpointKey(model);
      const pool = this.pools.get(key);
      if (pool) pool.limit = Math.min(pool.limit, modelLimit(model));
      else this.pools.set(key, { limit: modelLimit(model), active: 0 });
    }
  }

  async run<T>(model: ModelConfig, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(model, signal);
    try {
      if (signal.aborted) throw abortError();
      return await operation();
    } finally {
      // A cancelled active visit still owns capacity until its cleanup has settled.
      release();
    }
  }

  private acquire(model: ModelConfig, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortError());
    const key = endpointKey(model);
    let pool = this.pools.get(key);
    if (!pool) {
      pool = { limit: modelLimit(model), active: 0 };
      this.pools.set(key, pool);
    }
    const target = pool;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        signal, pool: target, resolve, reject,
        cancel: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal.removeEventListener('abort', waiter.cancel);
          reject(abortError());
        },
      };
      this.queue.push(waiter);
      signal.addEventListener('abort', waiter.cancel, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.maximum && this.queue.length) {
      // Preserve queue order among eligible visits. A busy endpoint must not
      // consume global capacity while another machine is ready to work.
      const index = this.queue.findIndex(waiter => waiter.pool.active < waiter.pool.limit);
      if (index < 0) return;
      const [waiter] = this.queue.splice(index, 1);
      waiter.signal.removeEventListener('abort', waiter.cancel);
      if (waiter.signal.aborted) { waiter.reject(abortError()); continue; }
      const pool = waiter.pool;
      pool.active++;
      this.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        pool.active--;
        this.active--;
        this.drain();
      });
    }
  }
}
