// Pure DAG-to-tree conversion functions.
// Testable independently of OmniFocus or Dagny.
// Built as an ES module (tsconfig.lib.json); module syntax is stripped
// by build.mjs before injection into the OmniFocus plugin bundle.

export function mergeLabels(a: EdgeLabel, b: EdgeLabel): EdgeLabel {
  if (a === b) return a;
  return "both";
}

export function unlabel(
  labeled: LabeledEdges,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const [id, deps] of labeled) {
    result.set(id, new Set(deps.keys()));
  }
  return result;
}

export function buildLabeledDag(
  tasks: DagnyTaskWithId[],
  ofEdges?: Map<string, Set<string>>,
  excludeIds?: Set<string>,
): {
  dependsOn: LabeledEdges;
  dependedOnBy: Map<string, Set<string>>;
  taskIds: Set<string>;
} {
  const dependsOn: LabeledEdges = new Map();
  const dependedOnBy = new Map<string, Set<string>>();
  const taskIds = new Set<string>();

  for (const t of tasks) {
    if (excludeIds && excludeIds.has(t.taskId)) continue;
    taskIds.add(t.taskId);
    dependsOn.set(t.taskId, new Map<string, EdgeLabel>());
    dependedOnBy.set(t.taskId, new Set<string>());
  }

  // Add Dagny edges, labeled "dagny"
  for (const t of tasks) {
    if (!taskIds.has(t.taskId)) continue;
    for (const depId of t.dependsOn) {
      if (!taskIds.has(depId)) continue;
      dependsOn.get(t.taskId)!.set(depId, "dagny");
      dependedOnBy.get(depId)!.add(t.taskId);
    }
  }

  // Merge OF edges: coinciding → "both", new → "OF"
  if (ofEdges) {
    for (const [id, deps] of ofEdges) {
      if (!taskIds.has(id)) continue;
      const edgeMap = dependsOn.get(id);
      if (!edgeMap) continue;
      for (const depId of deps) {
        if (!taskIds.has(depId)) continue;
        const existing = edgeMap.get(depId);
        if (existing) {
          edgeMap.set(depId, mergeLabels(existing, "OF"));
        } else {
          edgeMap.set(depId, "OF");
        }
        dependedOnBy.get(depId)!.add(id);
      }
    }
  }

  return { dependsOn, dependedOnBy, taskIds };
}

export function buildDag(
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

export function transitiveReductionLabeled(
  dependsOn: LabeledEdges,
  taskIds: Set<string>,
): LabeledEdges {
  const reduced: LabeledEdges = new Map();
  for (const [id, deps] of dependsOn) {
    reduced.set(id, new Map(deps));
  }

  // Pre-compute unlabeled view for reachability checks
  var unlabeled = unlabel(reduced);

  for (const node of taskIds) {
    const nodeDeps = reduced.get(node);
    if (!nodeDeps) continue;
    const directDeps = Array.from(nodeDeps.keys());
    for (const dep of directDeps) {
      if (!nodeDeps.has(dep)) continue;
      for (const otherDep of directDeps) {
        if (otherDep === dep) continue;
        if (!nodeDeps.has(otherDep)) continue;
        if (isReachable(otherDep, dep, unlabeled)) {
          // Propagate removed edge's label to the kept edge
          const removedLabel = nodeDeps.get(dep)!;
          const keptLabel = nodeDeps.get(otherDep)!;
          nodeDeps.set(otherDep, mergeLabels(removedLabel, keptLabel));
          nodeDeps.delete(dep);
          // Update unlabeled view
          unlabeled.get(node)!.delete(dep);
          break;
        }
      }
    }
  }

  return reduced;
}

export function transitiveReduction(
  dependsOn: Map<string, Set<string>>,
  taskIds: Set<string>,
): Map<string, Set<string>> {
  // Wrap in labels, reduce, then unwrap
  const labeled: LabeledEdges = new Map();
  for (const [id, deps] of dependsOn) {
    const m = new Map<string, EdgeLabel>();
    for (const dep of deps) {
      m.set(dep, "dagny");
    }
    labeled.set(id, m);
  }
  const reduced = transitiveReductionLabeled(labeled, taskIds);
  return unlabel(reduced);
}

export function isReachable(
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

export function findChain(
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

export function areIndependent(
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

export function topologicalSort(
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
export function subtreePriority(
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
export function sortByPriority(
  nodes: OFTreeNode[],
  taskMap: Map<string, DagnyTaskWithId>,
  parentSequential: boolean,
): OFTreeNode[] {
  const processed = nodes.map(function (node) {
    return {
      dagnyTaskId: node.dagnyTaskId,
      sequential: node.sequential,
      children: sortByPriority(node.children, taskMap, node.sequential),
      noFlatten: node.noFlatten,
    };
  });

  if (!parentSequential) {
    processed.sort(function (a, b) {
      return subtreePriority(b, taskMap) - subtreePriority(a, taskMap);
    });
  }

  return processed;
}

// Find sub-dependencies shared by 2+ of the given deps.
export function findSharedSubDeps(
  deps: string[],
  dependsOn: Map<string, Set<string>>,
): Set<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const dep of deps) {
    const visited = new Set<string>();
    const stack = Array.from(dependsOn.get(dep) || []);
    while (stack.length > 0) {
      const curr = stack.pop()!;
      if (visited.has(curr)) continue;
      visited.add(curr);
      if (seen.has(curr)) {
        shared.add(curr);
      }
      for (const d of dependsOn.get(curr) || []) {
        stack.push(d);
      }
    }
    for (const v of visited) {
      seen.add(v);
    }
  }
  return shared;
}

export function labelScore(label: EdgeLabel): number {
  if (label === "both") return 2;
  if (label === "dagny") return 1;
  return 0; // "OF"
}

export function dagToTree(
  tasks: DagnyTaskWithId[],
  mode: DependencyMode,
  containerSequential?: boolean,
  excludeIds?: Set<string>,
  noFlattenIds?: Set<string>,
  edgeLabels?: LabeledEdges,
): OFTreeNode[] {
  const dag = buildDag(tasks, excludeIds);

  // When labeled edges are provided, do a labeled transitive reduction
  // to propagate labels through removed edges, then extract connectivity.
  var reducedLabeled: LabeledEdges | null = null;
  var reduced: Map<string, Set<string>>;
  if (edgeLabels) {
    // Filter edgeLabels to only include tasks in the dag
    const filtered: LabeledEdges = new Map();
    for (const id of dag.taskIds) {
      const edges = edgeLabels.get(id);
      if (edges) {
        const m = new Map<string, EdgeLabel>();
        for (const [depId, label] of edges) {
          if (dag.taskIds.has(depId)) {
            m.set(depId, label);
          }
        }
        filtered.set(id, m);
      } else {
        filtered.set(id, new Map());
      }
    }
    reducedLabeled = transitiveReductionLabeled(filtered, dag.taskIds);
    reduced = unlabel(reducedLabeled);
  } else {
    reduced = transitiveReduction(dag.dependsOn, dag.taskIds);
  }

  const reducedBy = new Map<string, Set<string>>();
  for (const id of dag.taskIds) {
    reducedBy.set(id, new Set<string>());
  }
  for (const [id, deps] of reduced) {
    for (const dep of deps) {
      reducedBy.get(dep)!.add(id);
    }
  }

  // Build task lookup early so buildSubtree can use it for priority sorting
  const taskMap = new Map<string, DagnyTaskWithId>();
  for (const t of tasks) {
    taskMap.set(t.taskId, t);
  }

  const placed = new Set<string>();
  // Track prereq IDs that have been built so we don't duplicate them.
  const builtPrereqs = new Set<string>();

  // buildSubtree returns the node plus any prerequisite task IDs that
  // should ideally be placed before it in a sequential context.  The
  // prereqs are pre-placed (in the `placed` set) but NOT yet built — the
  // caller builds them at its own level when possible.
  function buildSubtree(
    taskId: string,
    parentIsSequential: boolean,
  ): { node: OFTreeNode; prereqs: string[] } {
    placed.add(taskId);
    const nf = noFlattenIds && noFlattenIds.has(taskId) ? true : undefined;
    const useConservative =
      mode === "conservative" ||
      (noFlattenIds !== undefined && noFlattenIds.has(taskId));

    const deps = Array.from(reduced.get(taskId) || []).filter(function (d) {
      return !placed.has(d);
    });

    // In optimistic mode with labels, sort deps so better-labeled edges
    // are processed first (claiming shared sub-deps).
    // Order: priority (highest first), then label (both > dagny > OF).
    if (reducedLabeled && mode === "optimistic" && deps.length > 1) {
      const edgesForTask = reducedLabeled.get(taskId);
      deps.sort(function (a, b) {
        const pa = subtreePriority(
          { dagnyTaskId: a, sequential: false, children: [] },
          taskMap,
        );
        const pb = subtreePriority(
          { dagnyTaskId: b, sequential: false, children: [] },
          taskMap,
        );
        if (pb !== pa) return pb - pa;
        const la = edgesForTask ? edgesForTask.get(a) : undefined;
        const lb = edgesForTask ? edgesForTask.get(b) : undefined;
        return labelScore(lb || "OF") - labelScore(la || "OF");
      });
    }

    if (deps.length === 0) {
      return {
        node: {
          dagnyTaskId: taskId,
          sequential: false,
          children: [],
          noFlatten: nf,
        },
        prereqs: [],
      };
    }

    const chain = findChain(deps, reduced);

    if (chain !== null) {
      // Chain: sequential.  Integrate any child prereqs at this level.
      const childNodes: OFTreeNode[] = [];
      for (const depId of chain) {
        if (!placed.has(depId)) {
          var r = buildSubtree(depId, true);
          // Prereqs are pre-placed but not built — build at this level
          for (const pId of r.prereqs) {
            if (!builtPrereqs.has(pId)) {
              builtPrereqs.add(pId);
              childNodes.push(buildSubtree(pId, true).node);
            }
          }
          childNodes.push(r.node);
        }
      }
      return {
        node: {
          dagnyTaskId: taskId,
          sequential: true,
          children: childNodes,
          noFlatten: nf,
        },
        prereqs: [],
      };
    } else if (areIndependent(deps, reduced)) {
      const shared = findSharedSubDeps(deps, reduced);
      // Remove shared sub-deps already placed elsewhere in the tree
      for (const sid of Array.from(shared)) {
        if (placed.has(sid)) {
          shared.delete(sid);
        }
      }

      if (shared.size > 0 && parentIsSequential) {
        // Lossless: parent is sequential, so hoist shared sub-deps.
        // Pre-place them so children don't claim them, then return
        // their IDs as prereqs for the parent to build.
        for (const sid of shared) {
          placed.add(sid);
        }
        const childNodes: OFTreeNode[] = [];
        for (const depId of deps) {
          if (!placed.has(depId)) {
            var r = buildSubtree(depId, false);
            childNodes.push(r.node);
          }
        }
        var sortedPrereqs = topologicalSort(Array.from(shared), reduced);
        return {
          node: {
            dagnyTaskId: taskId,
            sequential: false,
            children: childNodes,
            noFlatten: nf,
          },
          prereqs: sortedPrereqs,
        };
      } else if (shared.size > 0 && useConservative) {
        // Lossy + conservative: build shared deps first, then original
        // deps sorted by priority (highest first), all sequential.
        const sharedNodes: OFTreeNode[] = [];
        var sortedShared = topologicalSort(Array.from(shared), reduced);
        for (const sid of sortedShared) {
          if (!placed.has(sid)) {
            sharedNodes.push(buildSubtree(sid, true).node);
          }
        }
        const depNodes: OFTreeNode[] = [];
        for (const depId of deps) {
          if (!placed.has(depId)) {
            depNodes.push(buildSubtree(depId, true).node);
          }
        }
        depNodes.sort(function (a, b) {
          return subtreePriority(b, taskMap) - subtreePriority(a, taskMap);
        });
        var childNodes2: OFTreeNode[] = [];
        for (const n of sharedNodes) {
          childNodes2.push(n);
        }
        for (const n of depNodes) {
          childNodes2.push(n);
        }
        return {
          node: {
            dagnyTaskId: taskId,
            sequential: true,
            children: childNodes2,
            noFlatten: nf,
          },
          prereqs: [],
        };
      } else {
        // No shared sub-deps, or optimistic without sequential parent.
        const childNodes: OFTreeNode[] = [];
        for (const depId of deps) {
          if (!placed.has(depId)) {
            childNodes.push(buildSubtree(depId, false).node);
          }
        }
        return {
          node: {
            dagnyTaskId: taskId,
            sequential: false,
            children: childNodes,
            noFlatten: nf,
          },
          prereqs: [],
        };
      }
    } else {
      // Mixed deps (typically unreachable after transitive reduction).
      const sorted = topologicalSort(deps, reduced);
      const childNodes: OFTreeNode[] = [];
      for (const depId of sorted) {
        if (!placed.has(depId)) {
          childNodes.push(buildSubtree(depId, useConservative).node);
        }
      }
      return {
        node: {
          dagnyTaskId: taskId,
          sequential: useConservative ? true : false,
          children: childNodes,
          noFlatten: nf,
        },
        prereqs: [],
      };
    }
  }

  const roots: string[] = [];
  for (const id of dag.taskIds) {
    if (reducedBy.get(id)!.size === 0) {
      roots.push(id);
    }
  }

  const parentSeq =
    containerSequential !== undefined ? containerSequential : true;

  var result: OFTreeNode[] = [];
  for (const rootId of roots) {
    if (!placed.has(rootId)) {
      var r = buildSubtree(rootId, parentSeq);
      // Hoist prereqs to root level when container is sequential.
      // Prereqs are pre-placed but not yet built — build them now.
      for (const pId of r.prereqs) {
        if (!builtPrereqs.has(pId)) {
          builtPrereqs.add(pId);
          result.push(buildSubtree(pId, parentSeq).node);
        }
      }
      result.push(r.node);
    }
  }

  for (const id of dag.taskIds) {
    if (!placed.has(id)) {
      result.push(buildSubtree(id, parentSeq).node);
    }
  }

  if (noFlattenIds) {
    result = pruneBlockedLeaves(result, noFlattenIds);
  }

  const flattened = flattenTree(result, parentSeq);
  return sortByPriority(flattened, taskMap, parentSeq);
}

// Remove blocked tasks (identified by noFlattenIds) that ended up as
// leaves — they have no dependency children to auto-complete, so they
// would appear as actions the user must complete manually.
export function pruneBlockedLeaves(
  nodes: OFTreeNode[],
  blockedIds: Set<string>,
): OFTreeNode[] {
  const result: OFTreeNode[] = [];
  for (const node of nodes) {
    const prunedChildren = pruneBlockedLeaves(node.children, blockedIds);
    if (blockedIds.has(node.dagnyTaskId) && prunedChildren.length === 0) {
      continue;
    }
    result.push({
      dagnyTaskId: node.dagnyTaskId,
      sequential: node.sequential,
      children: prunedChildren,
      noFlatten: node.noFlatten,
    });
  }
  return result;
}

// Flatten sequential groups that are inside a sequential context.
// E.g., Seq[A(seq)->[B, C]] becomes Seq[B, C, A(leaf)].
// The parent node absorbs the children, and the group node becomes a leaf.
export function flattenTree(
  nodes: OFTreeNode[],
  parentSequential: boolean,
): OFTreeNode[] {
  const result: OFTreeNode[] = [];
  for (const node of nodes) {
    // First, recursively flatten children
    const flatChildren = flattenTree(node.children, node.sequential);

    if (
      parentSequential &&
      node.sequential &&
      flatChildren.length > 0 &&
      !node.noFlatten
    ) {
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
        noFlatten: node.noFlatten,
      });
    }
  }
  return result;
}

export function filterTasksForTeam(
  tasks: DagnyTaskWithId[],
  teamUserId: string,
  includeUnassigned: boolean,
): {
  filteredTasks: DagnyTaskWithId[];
  categories: Map<string, TaskCategory>;
} {
  const taskMap = new Map<string, DagnyTaskWithId>();
  const dependsOn = new Map<string, Set<string>>();
  const dependedOnBy = new Map<string, Set<string>>();

  for (const t of tasks) {
    taskMap.set(t.taskId, t);
    dependsOn.set(t.taskId, new Set<string>());
    dependedOnBy.set(t.taskId, new Set<string>());
  }
  for (const t of tasks) {
    for (const depId of t.dependsOn) {
      if (taskMap.has(depId)) {
        dependsOn.get(t.taskId)!.add(depId);
        dependedOnBy.get(depId)!.add(t.taskId);
      }
    }
  }

  // Identify "my tasks"
  const mine = new Set<string>();
  for (const t of tasks) {
    if (t.assigneeId === teamUserId) {
      mine.add(t.taskId);
    } else if (
      includeUnassigned &&
      (t.assigneeId === null || t.assigneeId === undefined)
    ) {
      mine.add(t.taskId);
    }
  }

  // BFS backward through dependsOn to find blockers
  const blockers = new Set<string>();
  var queue: string[] = [];
  for (const id of mine) {
    for (const depId of dependsOn.get(id)!) {
      if (!mine.has(depId)) {
        queue.push(depId);
      }
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (blockers.has(id) || mine.has(id)) continue;
    blockers.add(id);
    for (const depId of dependsOn.get(id)!) {
      if (!blockers.has(depId) && !mine.has(depId)) {
        queue.push(depId);
      }
    }
  }

  // BFS forward through dependedOnBy to find blocked tasks
  const blocked = new Set<string>();
  queue = [];
  for (const id of mine) {
    for (const depId of dependedOnBy.get(id)!) {
      if (!mine.has(depId) && !blockers.has(depId)) {
        queue.push(depId);
      }
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (blocked.has(id) || mine.has(id) || blockers.has(id)) continue;
    blocked.add(id);
    for (const depId of dependedOnBy.get(id)!) {
      if (!blocked.has(depId) && !mine.has(depId) && !blockers.has(depId)) {
        queue.push(depId);
      }
    }
  }

  const categories = new Map<string, TaskCategory>();
  const filteredTasks: DagnyTaskWithId[] = [];
  for (const t of tasks) {
    if (mine.has(t.taskId)) {
      categories.set(t.taskId, "mine");
      filteredTasks.push(t);
    } else if (blockers.has(t.taskId)) {
      categories.set(t.taskId, "blocker");
      filteredTasks.push(t);
    } else if (blocked.has(t.taskId)) {
      categories.set(t.taskId, "blocked");
      filteredTasks.push(t);
    }
  }

  return { filteredTasks, categories };
}
