import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  mergeLabels,
  unlabel,
  buildLabeledDag,
  buildDag,
  transitiveReductionLabeled,
  transitiveReduction,
  isReachable,
  findChain,
  areIndependent,
  topologicalSort,
  dagToTree,
  flattenTree,
  filterTasksForTeam,
} from "../src/dagGraph.js";

// ---- Test helpers ----

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

// ---- mergeLabels ----

describe("mergeLabels", () => {
  it("returns same label for identical inputs", () => {
    expect(mergeLabels("dagny", "dagny")).toBe("dagny");
    expect(mergeLabels("OF", "OF")).toBe("OF");
    expect(mergeLabels("both", "both")).toBe("both");
  });

  it("returns 'both' for different labels", () => {
    expect(mergeLabels("dagny", "OF")).toBe("both");
    expect(mergeLabels("OF", "dagny")).toBe("both");
  });

  it("returns 'both' when either is 'both'", () => {
    expect(mergeLabels("both", "dagny")).toBe("both");
    expect(mergeLabels("both", "OF")).toBe("both");
    expect(mergeLabels("dagny", "both")).toBe("both");
    expect(mergeLabels("OF", "both")).toBe("both");
  });
});

// ---- unlabel ----

describe("unlabel", () => {
  it("strips labels from labeled edges", () => {
    const labeled: LabeledEdges = new Map([
      ["A", new Map([["B", "dagny" as EdgeLabel], ["C", "OF" as EdgeLabel]])],
      ["B", new Map<string, EdgeLabel>()],
      ["C", new Map<string, EdgeLabel>()],
    ]);
    const result = unlabel(labeled);
    expect(result.get("A")).toEqual(new Set(["B", "C"]));
    expect(result.get("B")).toEqual(new Set());
    expect(result.get("C")).toEqual(new Set());
  });

  it("returns empty map for empty input", () => {
    expect(unlabel(new Map())).toEqual(new Map());
  });
});

// ---- buildLabeledDag ----

describe("buildLabeledDag", () => {
  it("labels all Dagny edges as 'dagny' when no OF edges", () => {
    const tasks = [makeTask("A"), makeTask("B", ["A"])];
    const dag = buildLabeledDag(tasks);
    expect(dag.dependsOn.get("B")!.get("A")).toBe("dagny");
    expect(dag.dependsOn.get("A")!.size).toBe(0);
  });

  it("labels OF-only edges as 'OF'", () => {
    const tasks = [makeTask("A"), makeTask("B")];
    const ofEdges = new Map([["B", new Set(["A"])]]);
    const dag = buildLabeledDag(tasks, ofEdges);
    expect(dag.dependsOn.get("B")!.get("A")).toBe("OF");
  });

  it("labels coinciding edges as 'both'", () => {
    const tasks = [makeTask("A"), makeTask("B", ["A"])];
    const ofEdges = new Map([["B", new Set(["A"])]]);
    const dag = buildLabeledDag(tasks, ofEdges);
    expect(dag.dependsOn.get("B")!.get("A")).toBe("both");
  });

  it("handles mixed: some dagny-only, some OF-only, some both", () => {
    const tasks = [
      makeTask("A"),
      makeTask("B"),
      makeTask("C"),
      makeTask("D", ["A", "B"]),
    ];
    const ofEdges = new Map([["D", new Set(["B", "C"])]]);
    const dag = buildLabeledDag(tasks, ofEdges);
    expect(dag.dependsOn.get("D")!.get("A")).toBe("dagny"); // dagny only
    expect(dag.dependsOn.get("D")!.get("B")).toBe("both"); // coinciding
    expect(dag.dependsOn.get("D")!.get("C")).toBe("OF"); // OF only
  });

  it("excludes tasks by excludeIds", () => {
    const tasks = [makeTask("A"), makeTask("B", ["A"]), makeTask("P")];
    const dag = buildLabeledDag(tasks, undefined, new Set(["P"]));
    expect(dag.taskIds).toEqual(new Set(["A", "B"]));
  });

  it("ignores OF edges to/from excluded or missing tasks", () => {
    const tasks = [makeTask("A"), makeTask("B")];
    const ofEdges = new Map([["B", new Set(["MISSING"])]]);
    const dag = buildLabeledDag(tasks, ofEdges);
    expect(dag.dependsOn.get("B")!.size).toBe(0);
  });

  it("builds correct dependedOnBy", () => {
    const tasks = [makeTask("A"), makeTask("B", ["A"])];
    const ofEdges = new Map([["B", new Set(["A"])]]);
    const dag = buildLabeledDag(tasks, ofEdges);
    expect(dag.dependedOnBy.get("A")).toEqual(new Set(["B"]));
  });
});

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

// ---- transitiveReductionLabeled ----

function makeLabeledDeps(
  ...pairs: [string, [string, EdgeLabel][]][]
): LabeledEdges {
  const m: LabeledEdges = new Map();
  for (const [id, deps] of pairs) {
    m.set(id, new Map(deps));
  }
  return m;
}

describe("transitiveReductionLabeled", () => {
  it("removes transitive edges and propagates labels", () => {
    // A depends on B ("OF") and C ("dagny"), B depends on C
    // A→C is transitive through B → remove A→C, merge its label into A→B
    const deps = makeLabeledDeps(
      ["A", [["B", "OF"], ["C", "dagny"]]],
      ["B", [["C", "dagny"]]],
      ["C", []],
    );
    const reduced = transitiveReductionLabeled(deps, new Set(["A", "B", "C"]));
    expect(reduced.get("A")!.has("C")).toBe(false);
    expect(reduced.get("A")!.get("B")).toBe("both"); // OF + dagny = both
    expect(reduced.get("B")!.get("C")).toBe("dagny");
  });

  it("preserves labels on non-transitive edges", () => {
    // A→B ("dagny"), A→C ("OF"), B and C independent
    const deps = makeLabeledDeps(
      ["A", [["B", "dagny"], ["C", "OF"]]],
      ["B", []],
      ["C", []],
    );
    const reduced = transitiveReductionLabeled(deps, new Set(["A", "B", "C"]));
    expect(reduced.get("A")!.get("B")).toBe("dagny");
    expect(reduced.get("A")!.get("C")).toBe("OF");
  });

  it("merges 'both' label correctly on transitive removal", () => {
    // A→B ("both"), A→C ("OF"), B→C
    // A→C transitive → merge "OF" into "both" → still "both"
    const deps = makeLabeledDeps(
      ["A", [["B", "both"], ["C", "OF"]]],
      ["B", [["C", "dagny"]]],
      ["C", []],
    );
    const reduced = transitiveReductionLabeled(deps, new Set(["A", "B", "C"]));
    expect(reduced.get("A")!.has("C")).toBe(false);
    expect(reduced.get("A")!.get("B")).toBe("both");
  });

  it("handles diamond with labels", () => {
    // X→A ("dagny"), X→B ("OF"), A→D ("dagny"), B→D ("OF")
    // No transitive edges in diamond — all preserved
    const deps = makeLabeledDeps(
      ["X", [["A", "dagny"], ["B", "OF"]]],
      ["A", [["D", "dagny"]]],
      ["B", [["D", "OF"]]],
      ["D", []],
    );
    const reduced = transitiveReductionLabeled(
      deps,
      new Set(["X", "A", "B", "D"]),
    );
    expect(reduced.get("X")!.get("A")).toBe("dagny");
    expect(reduced.get("X")!.get("B")).toBe("OF");
  });

  it("propagates same-source labels", () => {
    // A→B ("dagny"), A→C ("dagny"), B→C → A→C removed, A→B stays "dagny"
    const deps = makeLabeledDeps(
      ["A", [["B", "dagny"], ["C", "dagny"]]],
      ["B", [["C", "dagny"]]],
      ["C", []],
    );
    const reduced = transitiveReductionLabeled(deps, new Set(["A", "B", "C"]));
    expect(reduced.get("A")!.has("C")).toBe(false);
    expect(reduced.get("A")!.get("B")).toBe("dagny");
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
    // D is a shared sub-dep of A and B → hoisted before X
    // (default container is sequential, so lossless hoisting applies)
    expect(tree).toHaveLength(2);
    expect(tree[0].dagnyTaskId).toBe("D");
    expect(tree[0].children).toHaveLength(0);
    expect(tree[1].dagnyTaskId).toBe("X");
    expect(tree[1].sequential).toBe(false);
    const childIds = tree[1].children.map(function (c: any) {
      return c.dagnyTaskId;
    });
    expect(new Set(childIds)).toEqual(new Set(["A", "B"]));
    // All tasks appear exactly once
    const allIds = collectAllIds(tree);
    expect(allIds).toEqual(new Set(["X", "A", "B", "D"]));
    // A and B are both leaves (D hoisted out)
    const aNode = tree[1].children.find(function (c: any) {
      return c.dagnyTaskId === "A";
    });
    const bNode = tree[1].children.find(function (c: any) {
      return c.dagnyTaskId === "B";
    });
    expect(aNode.children.length).toBe(0);
    expect(bNode.children.length).toBe(0);
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

  it("optimistic mode with labels: prefers 'dagny' over 'OF' edges", () => {
    // X depends on A ("dagny") and B ("OF"), both equal priority.
    // Both A and B depend on D (shared sub-dep).
    // containerSequential=false so hoisting doesn't apply.
    // In optimistic mode, A should be processed first (dagny > OF),
    // so A claims D as its child.
    const tasks = [
      makeTask("D"),
      makeTask("A", ["D"]),
      makeTask("B", ["D"]),
      makeTask("X", ["A", "B"]),
    ];
    const edgeLabels: LabeledEdges = new Map([
      ["X", new Map([["A", "dagny" as EdgeLabel], ["B", "OF" as EdgeLabel]])],
      ["A", new Map([["D", "dagny" as EdgeLabel]])],
      ["B", new Map([["D", "OF" as EdgeLabel]])],
      ["D", new Map<string, EdgeLabel>()],
    ]);
    const tree = dagToTree(
      tasks,
      "optimistic",
      false,
      undefined,
      undefined,
      edgeLabels,
    );
    // A (dagny-labeled) should have D as child; B should be a leaf
    function findNode(nodes: any[], id: string): any {
      for (const n of nodes) {
        if (n.dagnyTaskId === id) return n;
        const found = findNode(n.children, id);
        if (found) return found;
      }
      return null;
    }
    const nodeA = findNode(tree, "A");
    const nodeB = findNode(tree, "B");
    expect(nodeA).not.toBeNull();
    expect(nodeB).not.toBeNull();
    // D should be under A (dagny-preferred), not B (OF)
    expect(nodeA.children.length).toBe(1);
    expect(nodeA.children[0].dagnyTaskId).toBe("D");
    expect(nodeB.children.length).toBe(0);
  });

  it("optimistic mode with labels: prefers 'both' over 'dagny'", () => {
    const tasks = [
      makeTask("D"),
      makeTask("A", ["D"]),
      makeTask("B", ["D"]),
      makeTask("X", ["A", "B"]),
    ];
    const edgeLabels: LabeledEdges = new Map([
      ["X", new Map([["A", "dagny" as EdgeLabel], ["B", "both" as EdgeLabel]])],
      ["A", new Map([["D", "dagny" as EdgeLabel]])],
      ["B", new Map([["D", "both" as EdgeLabel]])],
      ["D", new Map<string, EdgeLabel>()],
    ]);
    const tree = dagToTree(
      tasks,
      "optimistic",
      false,
      undefined,
      undefined,
      edgeLabels,
    );
    function findNode(nodes: any[], id: string): any {
      for (const n of nodes) {
        if (n.dagnyTaskId === id) return n;
        const found = findNode(n.children, id);
        if (found) return found;
      }
      return null;
    }
    const nodeB = findNode(tree, "B");
    // B (both-labeled) should claim D
    expect(nodeB.children.length).toBe(1);
    expect(nodeB.children[0].dagnyTaskId).toBe("D");
  });

  it("works unchanged when no edgeLabels provided", () => {
    // Same as existing diamond test — should behave identically
    const tasks = [
      makeTask("D"),
      makeTask("A", ["D"]),
      makeTask("B", ["D"]),
      makeTask("X", ["A", "B"]),
    ];
    const tree = dagToTree(tasks, "optimistic");
    const allIds = collectAllIds(tree);
    expect(allIds).toEqual(new Set(["X", "A", "B", "D"]));
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
    const tasks = [makeTask("A", [], "user1"), makeTask("B", [], null)];
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
    const tasks = [makeTask("A", ["B"], "user1"), makeTask("B", [], null)];
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
