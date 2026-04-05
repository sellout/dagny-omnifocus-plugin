// Pure DAG-to-tree conversion functions.
// Testable independently of OmniFocus or Dagny.
// Compiled into syncPull.js via tsconfig.syncPull.json (outFile).

function buildDag(
  tasks: DagnyTaskWithId[],
  excludeIds?: Set<string>,
): {
  dependsOn: Map<string, Set<string>>;
  dependedOnBy: Map<string, Set<string>>;
  taskIds: Set<string>;
} {
  const dependsOn = new Map<string, Set<string>>();
  const dependedOnBy = new Map<string, Set<string>>();
  const taskIds = new Set<string>();

  for (const t of tasks) {
    if (excludeIds && excludeIds.has(t.taskId)) continue;
    taskIds.add(t.taskId);
    dependsOn.set(t.taskId, new Set<string>());
    dependedOnBy.set(t.taskId, new Set<string>());
  }

  for (const t of tasks) {
    if (!taskIds.has(t.taskId)) continue;
    for (const depId of t.dependsOn) {
      if (!taskIds.has(depId)) continue;
      dependsOn.get(t.taskId)!.add(depId);
      dependedOnBy.get(depId)!.add(t.taskId);
    }
  }

  return { dependsOn, dependedOnBy, taskIds };
}

function transitiveReduction(
  dependsOn: Map<string, Set<string>>,
  taskIds: Set<string>,
): Map<string, Set<string>> {
  const reduced = new Map<string, Set<string>>();
  for (const [id, deps] of dependsOn) {
    reduced.set(id, new Set(deps));
  }

  for (const node of taskIds) {
    const directDeps = Array.from(reduced.get(node) || []);
    for (const dep of directDeps) {
      for (const otherDep of directDeps) {
        if (otherDep === dep) continue;
        if (isReachable(otherDep, dep, reduced)) {
          reduced.get(node)!.delete(dep);
          break;
        }
      }
    }
  }

  return reduced;
}

function isReachable(
  from: string,
  to: string,
  dependsOn: Map<string, Set<string>>,
): boolean {
  const visited = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const curr = stack.pop()!;
    if (curr === to) return true;
    if (visited.has(curr)) continue;
    visited.add(curr);
    const deps = dependsOn.get(curr);
    if (deps) {
      for (const d of deps) {
        stack.push(d);
      }
    }
  }
  return false;
}

function findChain(
  taskIds: string[],
  dependsOn: Map<string, Set<string>>,
): string[] | null {
  if (taskIds.length <= 1) return taskIds;

  const subset = new Set(taskIds);
  const inDegree = new Map<string, number>();
  const successors = new Map<string, string[]>();

  for (const id of taskIds) {
    inDegree.set(id, 0);
    successors.set(id, []);
  }

  for (const id of taskIds) {
    const deps = dependsOn.get(id);
    if (!deps) continue;
    for (const dep of deps) {
      if (subset.has(dep)) {
        inDegree.set(id, (inDegree.get(id) || 0) + 1);
        successors.get(dep)!.push(id);
      }
    }
  }

  const starts = taskIds.filter(function (id) {
    return inDegree.get(id) === 0;
  });
  if (starts.length !== 1) return null;

  const chain: string[] = [];
  var current: string | null = starts[0];
  while (current !== null) {
    chain.push(current);
    const succs: string[] = successors.get(current)!.filter(function (
      s: string,
    ) {
      return subset.has(s);
    });
    if (succs.length > 1) return null;
    current = succs.length === 0 ? null : succs[0];
  }

  return chain.length === taskIds.length ? chain : null;
}

function areIndependent(
  taskIds: string[],
  dependsOn: Map<string, Set<string>>,
): boolean {
  const subset = new Set(taskIds);
  for (const id of taskIds) {
    const deps = dependsOn.get(id);
    if (!deps) continue;
    for (const dep of deps) {
      if (subset.has(dep)) return false;
    }
  }
  return true;
}

function topologicalSort(
  taskIds: string[],
  dependsOn: Map<string, Set<string>>,
): string[] {
  const subset = new Set(taskIds);
  const inDegree = new Map<string, number>();

  for (const id of taskIds) {
    inDegree.set(id, 0);
  }

  for (const id of taskIds) {
    const deps = dependsOn.get(id);
    if (!deps) continue;
    for (const dep of deps) {
      if (subset.has(dep)) {
        inDegree.set(id, (inDegree.get(id) || 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const id of taskIds) {
    if (inDegree.get(id) === 0) {
      queue.push(id);
    }
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const curr = queue.shift()!;
    sorted.push(curr);
    for (const id of taskIds) {
      const deps = dependsOn.get(id);
      if (deps && deps.has(curr) && subset.has(id)) {
        const newDeg = (inDegree.get(id) || 1) - 1;
        inDegree.set(id, newDeg);
        if (newDeg === 0) {
          queue.push(id);
        }
      }
    }
  }

  for (const id of taskIds) {
    if (sorted.indexOf(id) === -1) {
      sorted.push(id);
    }
  }

  return sorted;
}

// Max effectiveValue of a node and all its descendants in the OF tree.
// A group with no priority but containing a high-priority child should
// sort above a low-priority leaf.
function subtreePriority(
  node: OFTreeNode,
  taskMap: Map<string, DagnyTaskWithId>,
): number {
  const dt = taskMap.get(node.dagnyTaskId);
  var best = (dt && dt.effectiveValue) || 0;
  for (const child of node.children) {
    const cp = subtreePriority(child, taskMap);
    if (cp > best) best = cp;
  }
  return best;
}

// Sort children of parallel groups by priority (highest first).
// Sequential group children are left in dependency order.
function sortByPriority(
  nodes: OFTreeNode[],
  taskMap: Map<string, DagnyTaskWithId>,
  parentSequential: boolean,
): OFTreeNode[] {
  const processed = nodes.map(function (node) {
    return {
      dagnyTaskId: node.dagnyTaskId,
      sequential: node.sequential,
      children: sortByPriority(node.children, taskMap, node.sequential),
    };
  });

  if (!parentSequential) {
    processed.sort(function (a, b) {
      return subtreePriority(b, taskMap) - subtreePriority(a, taskMap);
    });
  }

  return processed;
}

function dagToTree(
  tasks: DagnyTaskWithId[],
  mode: DependencyMode,
  containerSequential?: boolean,
  excludeIds?: Set<string>,
): OFTreeNode[] {
  const dag = buildDag(tasks, excludeIds);
  const reduced = transitiveReduction(dag.dependsOn, dag.taskIds);

  const reducedBy = new Map<string, Set<string>>();
  for (const id of dag.taskIds) {
    reducedBy.set(id, new Set<string>());
  }
  for (const [id, deps] of reduced) {
    for (const dep of deps) {
      reducedBy.get(dep)!.add(id);
    }
  }

  const placed = new Set<string>();

  function buildSubtree(taskId: string): OFTreeNode {
    placed.add(taskId);

    const deps = Array.from(reduced.get(taskId) || []).filter(function (d) {
      return !placed.has(d);
    });

    if (deps.length === 0) {
      return { dagnyTaskId: taskId, sequential: false, children: [] };
    }

    const chain = findChain(deps, reduced);

    if (chain !== null) {
      const childNodes: OFTreeNode[] = [];
      for (const depId of chain) {
        if (!placed.has(depId)) {
          childNodes.push(buildSubtree(depId));
        }
      }
      return { dagnyTaskId: taskId, sequential: true, children: childNodes };
    } else if (areIndependent(deps, reduced)) {
      const childNodes: OFTreeNode[] = [];
      for (const depId of deps) {
        if (!placed.has(depId)) {
          childNodes.push(buildSubtree(depId));
        }
      }
      return {
        dagnyTaskId: taskId,
        sequential: false,
        children: childNodes,
      };
    } else {
      if (mode === "conservative") {
        const sorted = topologicalSort(deps, reduced);
        const childNodes: OFTreeNode[] = [];
        for (const depId of sorted) {
          if (!placed.has(depId)) {
            childNodes.push(buildSubtree(depId));
          }
        }
        return {
          dagnyTaskId: taskId,
          sequential: true,
          children: childNodes,
        };
      } else {
        const sorted = topologicalSort(deps, reduced);
        const childNodes: OFTreeNode[] = [];
        for (const depId of sorted) {
          if (!placed.has(depId)) {
            childNodes.push(buildSubtree(depId));
          }
        }
        return {
          dagnyTaskId: taskId,
          sequential: false,
          children: childNodes,
        };
      }
    }
  }

  const roots: string[] = [];
  for (const id of dag.taskIds) {
    if (reducedBy.get(id)!.size === 0) {
      roots.push(id);
    }
  }

  const result: OFTreeNode[] = [];
  for (const rootId of roots) {
    if (!placed.has(rootId)) {
      result.push(buildSubtree(rootId));
    }
  }

  for (const id of dag.taskIds) {
    if (!placed.has(id)) {
      result.push(buildSubtree(id));
    }
  }

  // Build task lookup for priority sorting
  const taskMap = new Map<string, DagnyTaskWithId>();
  for (const t of tasks) {
    taskMap.set(t.taskId, t);
  }

  const parentSeq = containerSequential !== undefined ? containerSequential : true;
  const flattened = flattenTree(result, parentSeq);
  return sortByPriority(flattened, taskMap, parentSeq);
}

// Flatten sequential groups that are inside a sequential context.
// E.g., Seq[A(seq)->[B, C]] becomes Seq[B, C, A(leaf)].
// The parent node absorbs the children, and the group node becomes a leaf.
function flattenTree(
  nodes: OFTreeNode[],
  parentSequential: boolean,
): OFTreeNode[] {
  const result: OFTreeNode[] = [];
  for (const node of nodes) {
    // First, recursively flatten children
    const flatChildren = flattenTree(node.children, node.sequential);

    if (parentSequential && node.sequential && flatChildren.length > 0) {
      // Flatten: hoist children before this node, make this node a leaf
      for (const child of flatChildren) {
        result.push(child);
      }
      result.push({
        dagnyTaskId: node.dagnyTaskId,
        sequential: false,
        children: [],
      });
    } else {
      result.push({
        dagnyTaskId: node.dagnyTaskId,
        sequential: node.sequential,
        children: flatChildren,
      });
    }
  }
  return result;
}
