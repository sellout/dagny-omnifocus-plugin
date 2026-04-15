import { describe, it, expect } from "vitest";
import { graphToDot, treeToDot } from "../src/dotEmitter.js";
import { buildDag, transitiveReduction, dagToTree } from "../src/dagGraph.js";
import { parseDot } from "../src/dotParser.js";

function makeTask(id: string, dependsOn: string[] = []): DagnyTaskWithId {
  return {
    taskId: id,
    title: "Task " + id,
    description: "",
    dependsOn,
    statusId: "",
    tags: [],
    estimate: 0,
  };
}

describe("graphToDot", () => {
  it("emits a reduced graph as DOT", () => {
    const tasks = [
      makeTask("A", ["B", "C"]),
      makeTask("B", ["C"]),
      makeTask("C"),
    ];
    const dag = buildDag(tasks);
    const reduced = transitiveReduction(dag.dependsOn, dag.taskIds);
    const dot = graphToDot(tasks, reduced);
    expect(dot).toContain("digraph");
    expect(dot).toContain("Task A");
    expect(dot).toContain("Task B");
    expect(dot).toContain("Task C");
    // A -> C should be removed by transitive reduction (A -> B -> C)
    // A should only have edge to B
  });

  it("emits edges in dependsOn direction", () => {
    const tasks = [makeTask("A", ["B"]), makeTask("B")];
    const dag = buildDag(tasks);
    const reduced = transitiveReduction(dag.dependsOn, dag.taskIds);
    const dot = graphToDot(tasks, reduced);
    expect(dot).toContain("A");
    expect(dot).toContain("B");
  });
});

describe("treeToDot", () => {
  it("emits tree as DOT with clusters", () => {
    const tasks = [makeTask("A"), makeTask("B"), makeTask("X", ["A", "B"])];
    const tree = dagToTree(tasks, "conservative");
    const dot = treeToDot(tree);
    expect(dot).toContain("digraph");
    expect(dot).toContain("X");
    expect(dot).toContain("par");
  });

  it("emits sequential groups", () => {
    const tasks = [makeTask("A"), makeTask("B", ["A"]), makeTask("C", ["B"])];
    const tree = dagToTree(tasks, "conservative", false);
    const dot = treeToDot(tree);
    expect(dot).toContain("digraph");
  });
});

describe("round-trip", () => {
  it("parse DOT -> reduce -> emit DOT -> parse again preserves structure", () => {
    const inputDot = `digraph {
      A [label="Task A"]
      B [label="Task B"]
      C [label="Task C"]
      A -> B
      B -> C
    }`;

    // First pass
    const tasks1 = parseDot(inputDot);
    const dag1 = buildDag(tasks1);
    const reduced1 = transitiveReduction(dag1.dependsOn, dag1.taskIds);
    const emittedDot = graphToDot(tasks1, reduced1);

    // Second pass
    const tasks2 = parseDot(emittedDot);
    const dag2 = buildDag(tasks2);
    const reduced2 = transitiveReduction(dag2.dependsOn, dag2.taskIds);

    // Same set of nodes
    expect(dag2.taskIds).toEqual(dag1.taskIds);

    // Same reduced edges
    for (const id of dag1.taskIds) {
      expect(reduced2.get(id)).toEqual(reduced1.get(id));
    }
  });
});
