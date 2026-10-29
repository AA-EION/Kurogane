import type { GraphModel } from './build';

/** The node and everything it contains (a company's machines and workloads, a machine's workloads). */
export function membersOf(model: GraphModel, nodeId: string): Set<string> {
  const out = new Set<string>([nodeId]);
  const stack = [nodeId];
  while (stack.length) for (const child of model.children.get(stack.pop()!) ?? []) if (!out.has(child)) (out.add(child), stack.push(child));
  return out;
}

/**
 * Edges to light when a node is selected or hovered: every edge touching the
 * node or its members, plus the full Internet → ingress → proxy → route chain
 * of each route involved. A proxy's ingress edge is shared by all its routes,
 * so it is pulled in but never fans out to sibling routes.
 */
export function litEdges(model: GraphModel, nodeId: string | null): Set<string> {
  const out = new Set<string>();
  if (!nodeId || !model.byId.has(nodeId)) return out;
  if (nodeId === 'internet') {
    for (const e of model.edges) if (e.kind === 'ingress') out.add(e.id);
    return out;
  }
  const members = membersOf(model, nodeId);
  for (const e of model.edges) {
    if (!members.has(e.source) && !members.has(e.target)) continue;
    out.add(e.id);
    if (e.kind !== 'route') continue;
    for (const rid of e.routeIds) for (const id of model.routeTrace.get(rid) ?? []) out.add(id);
  }
  return out;
}

/** Nodes that stay at full opacity: the selection, its members, every lit edge's endpoints and their containers. */
export function litNodes(model: GraphModel, nodeId: string | null, edges: Set<string>): Set<string> {
  const out = nodeId && model.byId.has(nodeId) ? membersOf(model, nodeId) : new Set<string>();
  for (const e of model.edges) if (edges.has(e.id)) (out.add(e.source), out.add(e.target));
  for (const id of [...out]) {
    let parent = model.byId.get(id)?.parentId;
    while (parent && !out.has(parent)) {
      out.add(parent);
      parent = model.byId.get(parent)?.parentId;
    }
  }
  return out;
}
