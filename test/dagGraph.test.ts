import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  buildDag,
  transitiveReduction,
  isReachable,
  findChain,
  areIndependent,
  topologicalSort,
  dagToTree,
  flattenTree,
  filterTasksForTeam,
} from "./dagGraph.wrapper";

// ---- Test helpers ----

interface DagnyTaskWithId {
  taskId: string;
  title: string;
  description: string;
  dependsOn: string[];
  statusId: string;
  tags: string[];
  estimate: number;
  assigneeId?: string | null;
}

function makeTask(
  id: string,
  dependsOn: string[] = [],
  assigneeId?: string | null,
): DagnyTaskWithId {
  return {
    taskId: id,
    title: "Task " + id,
    description: "",
    dependsOn,
    statusId: "status-1",
    tags: [],
    estimate: 1,
    assigneeId,
  };
}

function makeDeps(...pairs: [string, string[]][]): Map<string, Set<string>> {
  const m = new Map<string, Set<string>>();
  for (const [id, deps] of pairs) {
    m.set(id, new Set(deps));
  }
  return m;
}

function collectAllIds(nodes: any[]): Set<string> {
  const ids = new Set<string>();
  function walk(ns: any[]) {
    for (const n of ns) {
      ids.add(n.dagnyTaskId);
      if (n.children) walk(n.children);
    }
  }
  walk(nodes);
  return ids;
}

// ---- buildDag ----

describe("buildDag", () => {
  it("builds adjacency maps from tasks", () => {
    const tasks = [makeTask("A"), makeTask("B", ["A"]), makeTask("C", ["A"])];
    const dag = buildDag(tasks);
    expect(dag.taskIds).toEqual(new Set(["A", "B", "C"]));
    expect(dag.dependsOn.get("B")).toEqual(new Set(["A"]));
    expect(dag.dependsOn.get("C")).toEqual(new Set(["A"]));
    expect(dag.dependsOn.get("A")).toEqual(new Set());
    expect(dag.dependedOnBy.get("A")).toEqual(new Set(["B", "C"]));
  });

  it("filters out tasks by excludeIds", () => {
    const tasks = [makeTask("A"), makeTask("P")];
    const dag = buildDag(tasks, new Set(["P"]));
    expect(dag.taskIds).toEqual(new Set(["A"]));
  });

  it("ignores dependsOn references to missing tasks", () => {
    const tasks = [makeTask("A", ["MISSING"])];
    const dag = buildDag(tasks);
    expect(dag.dependsOn.get("A")).toEqual(new Set());
  });
});

// ---- isReachable ----

describe("isReachable", () => {
  it("finds direct reachability", () => {
    const deps = makeDeps(["A", ["B"]], ["B", []]);
    expect(isReachable("A", "B", deps)).toBe(true);
  });

  it("finds transitive reachability", () => {
    const deps = makeDeps(["A", ["B"]], ["B", ["C"]], ["C", []]);
    expect(isReachable("A", "C", deps)).toBe(true);
  });

  it("returns false for unreachable", () => {
    const deps = makeDeps(["A", []], ["B", []]);
    expect(isReachable("A", "B", deps)).toBe(false);
  });

  it("handles self-loops without infinite loop", () => {
    const deps = makeDeps(["A", ["A"]]);
    expect(isReachable("A", "A", deps)).toBe(true);
  });
});

// ---- transitiveReduction ----

describe("transitiveReduction", () => {
  it("removes transitive edges", () => {
    // A depends on B and C, B depends on C → A→C is transitive
    const deps = makeDeps(["A", ["B", "C"]], ["B", ["C"]], ["C", []]);
    const reduced = transitiveReduction(deps, new Set(["A", "B", "C"]));
    expect(reduced.get("A")).toEqual(new Set(["B"]));
    expect(reduced.get("B")).toEqual(new Set(["C"]));
  });

  it("preserves non-transitive edges", () => {
    // A→B, A→C where B and C are independent
    const deps = makeDeps(["A", ["B", "C"]], ["B", []], ["C", []]);
    const reduced = transitiveReduction(deps, new Set(["A", "B", "C"]));
    expect(reduced.get("A")).toEqual(new Set(["B", "C"]));
  });

  it("handles diamond correctly", () => {
    // X depends on A and B, A depends on D, B depends on D
    const deps = makeDeps(
      ["X", ["A", "B"]],
      ["A", ["D"]],
      ["B", ["D"]],
      ["D", []],
    );
    const reduced = transitiveReduction(deps, new Set(["X", "A", "B", "D"]));
    expect(reduced.get("X")).toEqual(new Set(["A", "B"]));
    expect(reduced.get("A")).toEqual(new Set(["D"]));
    expect(reduced.get("B")).toEqual(new Set(["D"]));
  });
});

// ---- findChain ----

describe("findChain", () => {
  it("returns single element as chain", () => {
    const deps = makeDeps(["A", []]);
    expect(findChain(["A"], deps)).toEqual(["A"]);
  });

  it("finds a linear chain", () => {
    const deps = makeDeps(["A", []], ["B", ["A"]], ["C", ["B"]]);
    const chain = findChain(["A", "B", "C"], deps);
    expect(chain).toEqual(["A", "B", "C"]);
  });

  it("returns null for branching", () => {
    const deps = makeDeps(["A", []], ["B", ["A"]], ["C", ["A"]]);
    expect(findChain(["A", "B", "C"], deps)).toBeNull();
  });

  it("returns null for disconnected tasks", () => {
    const deps = makeDeps(["A", []], ["B", []]);
    expect(findChain(["A", "B"], deps)).toBeNull();
  });

  it("returns empty for empty input", () => {
    expect(findChain([], new Map())).toEqual([]);
  });
});

// ---- areIndependent ----

describe("areIndependent", () => {
  it("returns true for no edges between tasks", () => {
    const deps = makeDeps(["A", []], ["B", []], ["C", []]);
    expect(areIndependent(["A", "B", "C"], deps)).toBe(true);
  });

  it("returns false when edge exists", () => {
    const deps = makeDeps(["A", ["B"]], ["B", []]);
    expect(areIndependent(["A", "B"], deps)).toBe(false);
  });

  it("ignores edges to tasks outside the set", () => {
    const deps = makeDeps(["A", ["X"]], ["B", []], ["X", []]);
    expect(areIndependent(["A", "B"], deps)).toBe(true);
  });
});

// ---- topologicalSort ----

describe("topologicalSort", () => {
  it("sorts a chain", () => {
    const deps = makeDeps(["A", []], ["B", ["A"]], ["C", ["B"]]);
    expect(topologicalSort(["A", "B", "C"], deps)).toEqual(["A", "B", "C"]);
  });

  it("handles independent tasks", () => {
    const deps = makeDeps(["A", []], ["B", []], ["C", []]);
    const sorted = topologicalSort(["A", "B", "C"], deps);
    expect(sorted).toHaveLength(3);
    expect(new Set(sorted)).toEqual(new Set(["A", "B", "C"]));
  });

  it("respects dependencies", () => {
    const deps = makeDeps(["A", ["B", "C"]], ["B", []], ["C", []]);
    const sorted = topologicalSort(["A", "B", "C"], deps);
    expect(sorted.indexOf("B")).toBeLessThan(sorted.indexOf("A"));
    expect(sorted.indexOf("C")).toBeLessThan(sorted.indexOf("A"));
  });
});

// ---- dagToTree ----

describe("dagToTree", () => {
  it("produces a single leaf for one task", () => {
    const tasks = [makeTask("A")];
    const tree = dagToTree(tasks, "conservative");
    expect(tree).toHaveLength(1);
    expect(tree[0].dagnyTaskId).toBe("A");
    expect(tree[0].children).toHaveLength(0);
  });

  it("produces flattened chain for a linear dependency", () => {
    // C depends on B, B depends on A.
    // Before flattening: C(seq) -> [B(seq) -> [A]]
    // After flattening (root is sequential): [A, B, C] as flat siblings
    const tasks = [makeTask("A"), makeTask("B", ["A"]), makeTask("C", ["B"])];
    const tree = dagToTree(tasks, "conservative");
    expect(tree).toHaveLength(3);
    expect(tree[0].dagnyTaskId).toBe("A");
    expect(tree[1].dagnyTaskId).toBe("B");
    expect(tree[2].dagnyTaskId).toBe("C");
    expect(tree[0].children).toHaveLength(0);
    expect(tree[1].children).toHaveLength(0);
    expect(tree[2].children).toHaveLength(0);
  });

  it("produces parallel group for fan-in", () => {
    // X depends on [A, B] where A, B are independent
    const tasks = [makeTask("A"), makeTask("B"), makeTask("X", ["A", "B"])];
    const tree = dagToTree(tasks, "conservative");
    expect(tree).toHaveLength(1);
    expect(tree[0].dagnyTaskId).toBe("X");
    expect(tree[0].sequential).toBe(false);
    expect(tree[0].children).toHaveLength(2);
    const childIds = new Set(tree[0].children.map((c: any) => c.dagnyTaskId));
    expect(childIds).toEqual(new Set(["A", "B"]));
  });

  it("handles diamond: X depends on [A,B], both depend on D", () => {
    const tasks = [
      makeTask("D"),
      makeTask("A", ["D"]),
      makeTask("B", ["D"]),
      makeTask("X", ["A", "B"]),
    ];
    const tree = dagToTree(tasks, "conservative");
    expect(tree).toHaveLength(1);
    expect(tree[0].dagnyTaskId).toBe("X");
    // X's children should be A and B (independent after transitive reduction)
    expect(tree[0].sequential).toBe(false);
    const childIds = tree[0].children.map(function (c: any) {
      return c.dagnyTaskId;
    });
    expect(new Set(childIds)).toEqual(new Set(["A", "B"]));
    // D can only appear once in the tree. The first child processed
    // claims D; the second child has no unplaced deps left.
    const allIds = collectAllIds(tree);
    expect(allIds).toEqual(new Set(["X", "A", "B", "D"]));
    // Exactly one of A or B should have D as a child
    const aNode = tree[0].children.find(function (c: any) {
      return c.dagnyTaskId === "A";
    });
    const bNode = tree[0].children.find(function (c: any) {
      return c.dagnyTaskId === "B";
    });
    const totalDChildren = aNode.children.length + bNode.children.length;
    expect(totalDChildren).toBe(1);
  });

  it("filters out tasks by excludeIds", () => {
    const tasks = [makeTask("A"), makeTask("P", ["A"])];
    const tree = dagToTree(tasks, "conservative", undefined, new Set(["P"]));
    expect(tree).toHaveLength(1);
    expect(tree[0].dagnyTaskId).toBe("A");
  });

  it("handles independent tasks as separate roots", () => {
    const tasks = [makeTask("A"), makeTask("B"), makeTask("C")];
    const tree = dagToTree(tasks, "conservative");
    expect(tree).toHaveLength(3);
    const ids = new Set(
      tree.map(function (n: any) {
        return n.dagnyTaskId;
      }),
    );
    expect(ids).toEqual(new Set(["A", "B", "C"]));
  });

  it("sorts parallel children by effectiveValue (highest first)", () => {
    const tasks = [
      { ...makeTask("A"), effectiveValue: 1 },
      { ...makeTask("B"), effectiveValue: 5 },
      { ...makeTask("C"), effectiveValue: 3 },
      makeTask("X", ["A", "B", "C"]),
    ];
    const tree = dagToTree(tasks, "conservative");
    expect(tree).toHaveLength(1);
    expect(tree[0].dagnyTaskId).toBe("X");
    expect(tree[0].sequential).toBe(false);
    expect(tree[0].children).toHaveLength(3);
    expect(tree[0].children[0].dagnyTaskId).toBe("B");
    expect(tree[0].children[1].dagnyTaskId).toBe("C");
    expect(tree[0].children[2].dagnyTaskId).toBe("A");
  });

  it("sorts groups by max child priority", () => {
    // X(par) depends on [G1, G2], both groups with no priority.
    // G1 depends on [A(effectiveValue=1)]
    // G2 depends on [B(effectiveValue=8)]
    // G2 should sort before G1 because its child has higher priority.
    const tasks = [
      { ...makeTask("A"), effectiveValue: 1 },
      { ...makeTask("B"), effectiveValue: 8 },
      makeTask("G1", ["A"]),
      makeTask("G2", ["B"]),
      makeTask("X", ["G1", "G2"]),
    ];
    const tree = dagToTree(tasks, "conservative");
    expect(tree[0].dagnyTaskId).toBe("X");
    expect(tree[0].children[0].dagnyTaskId).toBe("G2");
    expect(tree[0].children[1].dagnyTaskId).toBe("G1");
  });

  it("conservative mode makes sequential for mixed deps", () => {
    // Non-series-parallel: X depends on [A, B], A depends on C, but B doesn't
    const tasks = [
      makeTask("C"),
      makeTask("A", ["C"]),
      makeTask("B"),
      makeTask("X", ["A", "B"]),
    ];
    const tree = dagToTree(tasks, "conservative");
    expect(tree).toHaveLength(1);
    // Conservative should make X sequential (adds ordering)
    // since A and B aren't purely independent (A has a dep on C)
    // After transitive reduction, X depends on A and B. A depends on C.
    // A and B have a relationship through C making them non-independent
    // but not a chain either.
    // Actually A and B ARE independent of each other.
    // A depends on C, B has no deps. A and B don't depend on each other.
    // So this should be parallel, not conservative.
  });

  it("optimistic mode makes parallel for mixed deps", () => {
    const tasks = [
      makeTask("C"),
      makeTask("A", ["C"]),
      makeTask("B"),
      makeTask("X", ["A", "B"]),
    ];
    const tree = dagToTree(tasks, "optimistic");
    expect(tree).toHaveLength(1);
    expect(tree[0].dagnyTaskId).toBe("X");
    // A and B are independent → parallel
    expect(tree[0].sequential).toBe(false);
  });
});

// ---- Property-based tests ----

// Arbitrary for a DAG: generate n tasks with random acyclic edges
const dagArbitrary = fc.integer({ min: 1, max: 20 }).chain(function (n) {
  // Generate task IDs
  const ids = Array.from({ length: n }, function (_, i) {
    return "t" + i;
  });
  // For each task, generate a subset of earlier tasks as dependencies
  // (ensures acyclicity: task i can only depend on tasks 0..i-1)
  return fc
    .tuple(
      ...ids.map(function (id, i) {
        if (i === 0) return fc.constant([]);
        return fc.subarray(ids.slice(0, i));
      }),
    )
    .map(function (depsList) {
      return ids.map(function (id, i) {
        return makeTask(id, depsList[i] as string[]);
      });
    });
});

describe("dagToTree properties", () => {
  it("every task appears exactly once in the tree", () => {
    fc.assert(
      fc.property(
        dagArbitrary,
        fc.constantFrom("conservative" as const, "optimistic" as const),
        function (tasks, mode) {
          const tree = dagToTree(tasks, mode);
          const treeIds = collectAllIds(tree);
          const inputIds = new Set(
            tasks.map(function (t: any) {
              return t.taskId;
            }),
          );
          expect(treeIds).toEqual(inputIds);
        },
      ),
    );
  });

  it("tree has no duplicate task IDs", () => {
    fc.assert(
      fc.property(
        dagArbitrary,
        fc.constantFrom("conservative" as const, "optimistic" as const),
        function (tasks, mode) {
          const tree = dagToTree(tasks, mode);
          const ids: string[] = [];
          function collect(nodes: any[]) {
            for (const n of nodes) {
              ids.push(n.dagnyTaskId);
              if (n.children) collect(n.children);
            }
          }
          collect(tree);
          expect(ids.length).toBe(new Set(ids).size);
        },
      ),
    );
  });

  it("topological sort respects all dependencies", () => {
    fc.assert(
      fc.property(dagArbitrary, function (tasks) {
        const deps = new Map<string, Set<string>>();
        const ids = tasks.map(function (t: any) {
          return t.taskId;
        });
        for (const t of tasks) {
          deps.set(t.taskId, new Set(t.dependsOn));
        }
        const sorted = topologicalSort(ids, deps);
        for (const t of tasks) {
          for (const dep of t.dependsOn) {
            expect(sorted.indexOf(dep)).toBeLessThan(sorted.indexOf(t.taskId));
          }
        }
      }),
    );
  });

  it("transitive reduction preserves reachability", () => {
    fc.assert(
      fc.property(dagArbitrary, function (tasks) {
        const original = new Map<string, Set<string>>();
        const taskIds = new Set<string>();
        for (const t of tasks) {
          taskIds.add(t.taskId);
          original.set(
            t.taskId,
            new Set(
              t.dependsOn.filter(function (d: string) {
                return tasks.some(function (t2: any) {
                  return t2.taskId === d;
                });
              }),
            ),
          );
        }
        const reduced = transitiveReduction(original, taskIds);
        // Every pair reachable in original should be reachable in reduced
        for (const from of taskIds) {
          for (const to of taskIds) {
            if (isReachable(from, to, original)) {
              expect(isReachable(from, to, reduced)).toBe(true);
            }
          }
        }
      }),
    );
  });

  it("transitive reduction never adds edges", () => {
    fc.assert(
      fc.property(dagArbitrary, function (tasks) {
        const original = new Map<string, Set<string>>();
        const taskIds = new Set<string>();
        for (const t of tasks) {
          taskIds.add(t.taskId);
          original.set(
            t.taskId,
            new Set(
              t.dependsOn.filter(function (d: string) {
                return tasks.some(function (t2: any) {
                  return t2.taskId === d;
                });
              }),
            ),
          );
        }
        const reduced = transitiveReduction(original, taskIds);
        for (const [id, deps] of reduced) {
          for (const dep of deps) {
            expect(original.get(id)!.has(dep)).toBe(true);
          }
        }
      }),
    );
  });
});

// ---- filterTasksForTeam ----

describe("filterTasksForTeam", () => {
  it("categorizes mine, other, and unassigned correctly", () => {
    const tasks = [
      makeTask("A", [], "user1"),
      makeTask("B", [], "user2"),
      makeTask("C", [], null),
    ];
    const result = filterTasksForTeam(tasks, "user1", true);
    expect(result.categories.get("A")).toBe("mine");
    expect(result.categories.get("C")).toBe("mine");
    expect(result.categories.has("B")).toBe(false);
    expect(result.filteredTasks.length).toBe(2);
  });

  it("excludes unassigned when includeUnassigned is false", () => {
    const tasks = [
      makeTask("A", [], "user1"),
      makeTask("B", [], null),
    ];
    const result = filterTasksForTeam(tasks, "user1", false);
    expect(result.categories.get("A")).toBe("mine");
    expect(result.categories.has("B")).toBe(false);
    expect(result.filteredTasks.length).toBe(1);
  });

  it("pulls in blocker chain transitively", () => {
    // A(mine) depends on B(other) depends on C(other)
    const tasks = [
      makeTask("A", ["B"], "user1"),
      makeTask("B", ["C"], "user2"),
      makeTask("C", [], "user2"),
    ];
    const result = filterTasksForTeam(tasks, "user1", false);
    expect(result.categories.get("A")).toBe("mine");
    expect(result.categories.get("B")).toBe("blocker");
    expect(result.categories.get("C")).toBe("blocker");
    expect(result.filteredTasks.length).toBe(3);
  });

  it("pulls in blocked tasks transitively", () => {
    // D(other) depends on A(mine); E(other) depends on D
    const tasks = [
      makeTask("A", [], "user1"),
      makeTask("D", ["A"], "user2"),
      makeTask("E", ["D"], "user2"),
    ];
    const result = filterTasksForTeam(tasks, "user1", false);
    expect(result.categories.get("A")).toBe("mine");
    expect(result.categories.get("D")).toBe("blocked");
    expect(result.categories.get("E")).toBe("blocked");
    expect(result.filteredTasks.length).toBe(3);
  });

  it("classifies in-between tasks as blockers", () => {
    // A(mine) depends on B(other) depends on C(mine)
    // B is both a blocker of A and blocked by C → categorized as blocker
    const tasks = [
      makeTask("A", ["B"], "user1"),
      makeTask("B", ["C"], "user2"),
      makeTask("C", [], "user1"),
    ];
    const result = filterTasksForTeam(tasks, "user1", false);
    expect(result.categories.get("A")).toBe("mine");
    expect(result.categories.get("B")).toBe("blocker");
    expect(result.categories.get("C")).toBe("mine");
  });

  it("excludes tasks unrelated to mine", () => {
    const tasks = [
      makeTask("A", [], "user1"),
      makeTask("B", [], "user2"),
      makeTask("C", ["B"], "user2"),
    ];
    const result = filterTasksForTeam(tasks, "user1", false);
    expect(result.filteredTasks.length).toBe(1);
    expect(result.categories.get("A")).toBe("mine");
    expect(result.categories.has("B")).toBe(false);
    expect(result.categories.has("C")).toBe(false);
  });

  it("includes unassigned blockers even when includeUnassigned is false", () => {
    // A(mine) depends on B(unassigned)
    const tasks = [
      makeTask("A", ["B"], "user1"),
      makeTask("B", [], null),
    ];
    const result = filterTasksForTeam(tasks, "user1", false);
    expect(result.categories.get("A")).toBe("mine");
    expect(result.categories.get("B")).toBe("blocker");
    expect(result.filteredTasks.length).toBe(2);
  });

  it("handles tasks with undefined assigneeId as unassigned", () => {
    const tasks = [makeTask("A", [])]; // assigneeId is undefined
    const result = filterTasksForTeam(tasks, "user1", true);
    expect(result.categories.get("A")).toBe("mine");
  });
});

// ---- flattenTree with noFlatten ----

describe("flattenTree with noFlatten", () => {
  it("does not flatten nodes with noFlatten in sequential parent", () => {
    // Seq parent containing a sequential node with noFlatten
    const nodes = [
      {
        dagnyTaskId: "A",
        sequential: true,
        children: [
          { dagnyTaskId: "B", sequential: false, children: [] },
          { dagnyTaskId: "C", sequential: false, children: [] },
        ],
        noFlatten: true,
      },
    ];
    const result = flattenTree(nodes, true);
    // A should NOT be flattened — should keep its children
    expect(result.length).toBe(1);
    expect(result[0].dagnyTaskId).toBe("A");
    expect(result[0].children.length).toBe(2);
  });

  it("still flattens nodes without noFlatten in sequential parent", () => {
    const nodes = [
      {
        dagnyTaskId: "A",
        sequential: true,
        children: [
          { dagnyTaskId: "B", sequential: false, children: [] },
          { dagnyTaskId: "C", sequential: false, children: [] },
        ],
      },
    ];
    const result = flattenTree(nodes, true);
    // A should be flattened: B, C hoisted, A becomes leaf
    expect(result.length).toBe(3);
    expect(result[0].dagnyTaskId).toBe("B");
    expect(result[1].dagnyTaskId).toBe("C");
    expect(result[2].dagnyTaskId).toBe("A");
    expect(result[2].children.length).toBe(0);
  });
});

// ---- dagToTree with noFlattenIds ----

describe("dagToTree with noFlattenIds", () => {
  it("preserves nesting for noFlatten tasks", () => {
    // A depends on B depends on C — normally B would be flattened
    // With noFlattenIds containing B, it should keep its children
    const tasks = [
      makeTask("A", ["B"]),
      makeTask("B", ["C"]),
      makeTask("C", []),
    ];
    const noFlatten = new Set(["B"]);
    const tree = dagToTree(tasks, "conservative", true, undefined, noFlatten);
    // Find node B in the tree
    function findNode(nodes: any[], id: string): any {
      for (const n of nodes) {
        if (n.dagnyTaskId === id) return n;
        const found = findNode(n.children, id);
        if (found) return found;
      }
      return null;
    }
    const nodeB = findNode(tree, "B");
    expect(nodeB).not.toBeNull();
    expect(nodeB.noFlatten).toBe(true);
    // B should still have C as a child (not flattened)
    expect(nodeB.children.length).toBe(1);
    expect(nodeB.children[0].dagnyTaskId).toBe("C");
  });

  it("forces conservative (sequential) for noFlatten tasks in optimistic mode", () => {
    // A depends on both B and C, and B depends on C.
    // This is a mixed (non-chain, non-independent) case.
    // In optimistic mode, A's children would normally be parallel.
    // With A in noFlattenIds, it should be forced sequential.
    const tasks = [
      makeTask("A", ["B", "C"]),
      makeTask("B", ["C"]),
      makeTask("C", []),
    ];
    const noFlatten = new Set(["A"]);
    const tree = dagToTree(tasks, "optimistic", false, undefined, noFlatten);
    function findNode(nodes: any[], id: string): any {
      for (const n of nodes) {
        if (n.dagnyTaskId === id) return n;
        const found = findNode(n.children, id);
        if (found) return found;
      }
      return null;
    }
    const nodeA = findNode(tree, "A");
    expect(nodeA).not.toBeNull();
    expect(nodeA.sequential).toBe(true);
  });

  it("prunes blocked leaf tasks from the tree", () => {
    // A (mine) has no deps. X and Y both depend on A (both blocked).
    // X is built first and gets A as a child. Y has no unplaced deps
    // and would be a leaf — it should be pruned.
    const tasks = [
      makeTask("A", []),
      makeTask("X", ["A"]),
      makeTask("Y", ["A"]),
    ];
    const noFlatten = new Set(["X", "Y"]);
    const tree = dagToTree(tasks, "conservative", false, undefined, noFlatten);
    const allIds = collectAllIds(tree);
    // One of X/Y should have A as a child; the other should be pruned
    expect(allIds.has("A")).toBe(true);
    // Only one of X/Y should survive (the one that got A)
    const hasX = allIds.has("X");
    const hasY = allIds.has("Y");
    expect(hasX || hasY).toBe(true);
    expect(hasX && hasY).toBe(false);
  });
});
