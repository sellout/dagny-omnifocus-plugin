// Parse Graphviz DOT format into DagnyTaskWithId[].
// Edge semantics: A -> B means "A depends on B".

import { fromDot } from "ts-graphviz";

export function parseDot(dot: string): DagnyTaskWithId[] {
  const graph = fromDot(dot);

  // Collect node attributes by id
  const nodeAttrs = new Map<
    string,
    { label?: string; effectiveValue?: number; assigneeId?: string }
  >();
  for (const node of graph.nodes) {
    const id = node.id;
    const label = node.attributes.get("label") as string | undefined;
    const ev = node.attributes.get("xlabel") as string | undefined;
    const assignee = node.attributes.get("tooltip") as string | undefined;
    nodeAttrs.set(id, {
      label: label ?? undefined,
      effectiveValue: ev !== undefined ? Number(ev) : undefined,
      assigneeId: assignee ?? undefined,
    });
  }

  // Collect edges: A -> B means A depends on B
  const dependsOn = new Map<string, string[]>();
  const allIds = new Set<string>();

  for (const node of graph.nodes) {
    allIds.add(node.id);
  }

  for (const edge of graph.edges) {
    const targets = edge.targets;
    for (let i = 0; i < targets.length - 1; i++) {
      const from = targetId(targets[i]);
      const to = targetId(targets[i + 1]);
      if (from === null || to === null) continue;
      allIds.add(from);
      allIds.add(to);
      if (!dependsOn.has(from)) dependsOn.set(from, []);
      dependsOn.get(from)!.push(to);
    }
  }

  // Build tasks
  const tasks: DagnyTaskWithId[] = [];
  for (const id of allIds) {
    const attrs = nodeAttrs.get(id);
    tasks.push({
      taskId: id,
      title: attrs?.label ?? id,
      description: "",
      dependsOn: dependsOn.get(id) ?? [],
      statusId: "",
      tags: [],
      estimate: 0,
      effectiveValue: attrs?.effectiveValue ?? null,
      assigneeId: attrs?.assigneeId ?? null,
    });
  }

  return tasks;
}

function targetId(target: unknown): string | null {
  if (typeof target === "string") return target;
  if (target && typeof target === "object" && "id" in target) {
    return (target as { id: string }).id;
  }
  return null;
}
