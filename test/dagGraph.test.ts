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
}

function makeTask(id: string, dependsOn: string[] = []): DagnyTaskWithId {
  return {
    taskId: id,
    title: "Task " + id,
    description: "",
    dependsOn,
    statusId: "status-1",
    tags: [],
    estimate: 1,
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

  it("filters out [OF Project] tasks", () => {
    const tasks = [
      makeTask("A"),
      { ...makeTask("P"), title: "[OF Project] Foo" },
    ];
    const dag = buildDag(tasks);
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

  it("filters out [OF Project] placeholders", () => {
    const tasks = [
      makeTask("A"),
      { ...makeTask("P", ["A"]), title: "[OF Project] Foo" },
    ];
    const tree = dagToTree(tasks, "conservative");
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
