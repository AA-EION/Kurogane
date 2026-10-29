import type { GraphModel, GraphNode } from './build';

/**
 * One company's slice of the graph: the company with everything on its
 * machines, plus — from other companies — only what its own services depend
 * on: the machines its services run on, and the proxies (with their machines)
 * that publish its services. Those borrowed nodes are marked `context`, and
 * their companies show how much of them is drawn.
 */
export function focusCompany(model: GraphModel, tenantId: string): GraphModel {
  const root = `tenant:${tenantId}`;
  if (!model.byId.has(root)) return model;
  const keep = new Set<string>(['internet', root]);
  const withAncestors = (id: string) => {
    for (let n: GraphNode | undefined = model.byId.get(id); n && !keep.has(n.id); n = n.parentId ? model.byId.get(n.parentId) : undefined) keep.add(n.id);
  };
  const stack = [root];
  while (stack.length) for (const child of model.children.get(stack.pop()!) ?? []) (keep.add(child), stack.push(child));
  const own = new Set(keep);
  for (const n of model.nodes) if (n.ownerTenantId === tenantId) (own.add(n.id), withAncestors(n.id));

  // Proxies elsewhere that publish this company's services, and whatever this company's own proxies publish.
  for (const e of model.edges) {
    if (e.kind !== 'route') continue;
    if (own.has(e.target)) withAncestors(e.source);
    else if (own.has(e.source)) withAncestors(e.target);
  }

  const shown = new Map<string, number>();
  for (const id of keep) {
    const n = model.byId.get(id)!;
    if (n.kind === 'host' && n.parentId) shown.set(n.parentId, (shown.get(n.parentId) ?? 0) + 1);
  }
  const edges = model.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
  const routeCount = new Set(edges.flatMap((e) => (e.kind === 'route' ? e.routeIds : []))).size;
  const children = new Map<string, string[]>();
  for (const [parent, kids] of model.children) {
    if (!keep.has(parent)) continue;
    children.set(parent, kids.filter((k) => keep.has(k)));
  }
  // The focused company comes first (top-left of the grid), then the companies it borrows from.
  const rank = (n: GraphNode) => (n.kind === 'internet' ? 0 : n.tenantId === tenantId ? 1 : 2);
  const nodes = model.nodes
    .filter((n) => keep.has(n.id))
    .sort((a, b) => rank(a) - rank(b))
    .map((n): GraphNode => {
      if (n.kind === 'internet') return { ...n, sublabel: `${routeCount} published route${routeCount === 1 ? '' : 's'}` };
      if (n.tenantId === tenantId || n.ownerTenantId === tenantId) return n;
      if (n.kind === 'tenant') {
        const total = n.count ?? 0;
        return { ...n, context: true, sublabel: `Context · ${shown.get(n.id) ?? 0} of ${total} ${total === 1 ? 'machine' : 'machines'}` };
      }
      // A borrowed machine with none of its workloads drawn becomes a compact leaf.
      if (n.kind === 'host' && !children.get(n.id)?.length) return { ...n, context: true, appliance: true };
      return { ...n, context: true };
    });
  const refToNode = new Map([...model.refToNode].filter(([, id]) => keep.has(id)));
  const edgeIds = new Set(edges.map((e) => e.id));
  const routeTrace = new Map<string, string[]>();
  for (const [rid, trace] of model.routeTrace) if (trace.every((id) => edgeIds.has(id))) routeTrace.set(rid, trace);
  return { nodes, edges, children, byId: new Map(nodes.map((n) => [n.id, n])), refToNode, routeTrace };
}
