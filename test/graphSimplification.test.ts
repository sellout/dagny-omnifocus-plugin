import { describe, it, expect } from "vitest";
import { fromDot } from "ts-graphviz";
import type { RootGraphModel } from "ts-graphviz";
import { parseDot } from "../src/dotParser.js";
import { buildDag, transitiveReduction, dagToTree } from "../src/dagGraph.js";
import { graphToDot, treeToDot } from "../src/dotEmitter.js";

// ---- Structural comparison helpers ----

interface GraphStructure {
  nodes: Set<string>;
  edges: Set<string>; // "A->B" or "A->B[dotted]"
  clusters: Map<string, Set<string>>; // label -> node ids
}

function extractStructure(dot: string): GraphStructure {
  const graph = fromDot(dot);
  const result: GraphStructure = {
    nodes: new Set(),
    edges: new Set(),
    clusters: new Map(),
  };
  walkGraph(graph, result, null);
  return result;
}

function walkGraph(
  g: {
    nodes: ReadonlyArray<any>;
    edges: ReadonlyArray<any>;
    subgraphs: ReadonlyArray<any>;
  },
  out: GraphStructure,
  clusterLabel: string | null,
): void {
  for (const node of g.nodes) {
    out.nodes.add(node.id);
    if (clusterLabel !== null) {
      if (!out.clusters.has(clusterLabel))
        out.clusters.set(clusterLabel, new Set());
      out.clusters.get(clusterLabel)!.add(node.id);
    }
  }
  for (const edge of g.edges) {
    const targets = edge.targets;
    const style = edge.attributes?.get("style");
    for (let i = 0; i < targets.length - 1; i++) {
      const from = nodeId(targets[i]);
      const to = nodeId(targets[i + 1]);
      if (from && to) {
        out.nodes.add(from);
        out.nodes.add(to);
        const suffix = style === "dotted" ? "[dotted]" : "";
        out.edges.add(`${from}->${to}${suffix}`);
      }
    }
  }
  for (const sg of g.subgraphs) {
    const label = sg.get?.("label") ?? sg.id ?? null;
    walkGraph(sg, out, label);
  }
}

function nodeId(target: unknown): string | null {
  if (typeof target === "string") return target;
  if (target && typeof target === "object" && "id" in target) {
    return (target as { id: string }).id;
  }
  return null;
}

// ---- Test runners ----

function expectReduction(inputDot: string, expectedDot: string): void {
  const tasks = parseDot(inputDot);
  const dag = buildDag(tasks);
  const reduced = transitiveReduction(dag.dependsOn, dag.taskIds);
  const actualDot = graphToDot(tasks, reduced);

  const actual = extractStructure(actualDot);
  const expected = extractStructure(expectedDot);

  expect(actual.nodes).toEqual(expected.nodes);
  expect(actual.edges).toEqual(expected.edges);
}

function expectTree(
  inputDot: string,
  expectedDot: string,
  mode: DependencyMode,
  containerSequential?: boolean,
): void {
  const tasks = parseDot(inputDot);
  const tree = dagToTree(tasks, mode, containerSequential);
  const actualDot = treeToDot(tree);

  const actual = extractStructure(actualDot);
  const expected = extractStructure(expectedDot);

  expect(actual.nodes).toEqual(expected.nodes);
  expect(actual.edges).toEqual(expected.edges);
  expect(actual.clusters).toEqual(expected.clusters);
}

// ---- Transitive reduction tests ----

describe("transitive reduction (DOT)", () => {
  it("drops shortcut edge in a chain", () => {
    expectReduction(
      `digraph { A -> B; B -> C; A -> C }`,
      `digraph { A -> B; B -> C }`,
    );
  });

  it("drops shortcut in a diamond", () => {
    expectReduction(
      `digraph { A -> B; A -> C; B -> D; C -> D; A -> D }`,
      `digraph { A -> B; A -> C; B -> D; C -> D }`,
    );
  });

  it("preserves independent branches", () => {
    expectReduction(`digraph { A -> B; A -> C }`, `digraph { A -> B; A -> C }`);
  });

  it("drops multiple shortcuts in a long chain", () => {
    expectReduction(
      `digraph { A -> B; B -> C; C -> D; A -> C; A -> D; B -> D }`,
      `digraph { A -> B; B -> C; C -> D }`,
    );
  });

  it("handles two diamonds sharing a node", () => {
    // First diamond: A -> B, A -> C, B -> D, C -> D
    // Second diamond: D -> E, D -> F, E -> G, F -> G
    // Plus shortcuts: A -> D, D -> G
    expectReduction(
      `digraph {
        A -> B; A -> C; B -> D; C -> D; A -> D;
        D -> E; D -> F; E -> G; F -> G; D -> G
      }`,
      `digraph {
        A -> B; A -> C; B -> D; C -> D;
        D -> E; D -> F; E -> G; F -> G
      }`,
    );
  });

  it("preserves a simple chain with no redundancy", () => {
    expectReduction(
      `digraph { A -> B; B -> C; C -> D }`,
      `digraph { A -> B; B -> C; C -> D }`,
    );
  });

  it("handles fan-out with no redundancy", () => {
    expectReduction(
      `digraph { A -> B; A -> C; A -> D }`,
      `digraph { A -> B; A -> C; A -> D }`,
    );
  });

  it("handles fan-in with no redundancy", () => {
    expectReduction(
      `digraph { B -> A; C -> A; D -> A }`,
      `digraph { B -> A; C -> A; D -> A }`,
    );
  });
});

// ---- Tree conversion tests ----

describe("tree conversion (DOT)", () => {
  it("flattens a chain into leaves (default sequential container)", () => {
    // A -> B -> C: chain flattens to 3 leaves since parent is sequential
    expectTree(
      `digraph { A -> B -> C }`,
      `digraph { C; B; A }`,
      "conservative",
    );
  });

  it("produces sequential cluster when container is parallel", () => {
    // With containerSequential=false, the chain becomes a seq cluster
    expectTree(
      `digraph { A -> B -> C }`,
      `digraph {
        subgraph cluster_0 {
          label = "A [seq]"
          A [shape=box]
          C
          B
          C -> B [style=dotted]
        }
      }`,
      "conservative",
      false,
    );
  });

  it("produces parallel cluster for fan-in", () => {
    expectTree(
      `digraph { X -> A; X -> B }`,
      `digraph {
        subgraph cluster_0 {
          label = "X [par]"
          X [shape=box]
          A
          B
        }
      }`,
      "conservative",
    );
  });

  it("nests clusters for a diamond", () => {
    // X -> A, X -> B, A -> D, B -> D
    // D gets placed under whichever of A/B is processed first
    expectTree(
      `digraph { X -> A; X -> B; A -> D; B -> D }`,
      `digraph {
        subgraph cluster_0 {
          label = "X [par]"
          X [shape=box]
          B
          subgraph cluster_1 {
            label = "A [seq]"
            A [shape=box]
            D
          }
        }
      }`,
      "conservative",
    );
  });

  it("sorts parallel children by priority (highest first)", () => {
    expectTree(
      `digraph {
        A [xlabel="1"]
        B [xlabel="5"]
        C [xlabel="3"]
        X -> A; X -> B; X -> C
      }`,
      `digraph {
        subgraph cluster_0 {
          label = "X [par]"
          X [shape=box]
          B
          C
          A
        }
      }`,
      "conservative",
    );
  });

  it("handles independent tasks as separate leaves", () => {
    expectTree(`digraph { A; B; C }`, `digraph { A; B; C }`, "conservative");
  });
});
