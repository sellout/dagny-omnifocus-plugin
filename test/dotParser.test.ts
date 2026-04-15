import { describe, it, expect } from "vitest";
import { parseDot } from "../src/dotParser.js";

describe("parseDot", () => {
  it("parses nodes with labels", () => {
    const dot = `digraph {
      A [label="Task A"]
      B [label="Task B"]
    }`;
    const tasks = parseDot(dot);
    expect(tasks).toHaveLength(2);
    const a = tasks.find((t) => t.taskId === "A");
    expect(a?.title).toBe("Task A");
  });

  it("parses edges as dependsOn (A -> B means A depends on B)", () => {
    const dot = `digraph {
      A -> B
    }`;
    const tasks = parseDot(dot);
    const a = tasks.find((t) => t.taskId === "A");
    const b = tasks.find((t) => t.taskId === "B");
    expect(a?.dependsOn).toEqual(["B"]);
    expect(b?.dependsOn).toEqual([]);
  });

  it("parses multiple edges", () => {
    const dot = `digraph {
      A -> B
      A -> C
      B -> C
    }`;
    const tasks = parseDot(dot);
    const a = tasks.find((t) => t.taskId === "A");
    expect(a?.dependsOn).toContain("B");
    expect(a?.dependsOn).toContain("C");
    const b = tasks.find((t) => t.taskId === "B");
    expect(b?.dependsOn).toEqual(["C"]);
  });

  it("uses node id as title when no label", () => {
    const dot = `digraph { A -> B }`;
    const tasks = parseDot(dot);
    const a = tasks.find((t) => t.taskId === "A");
    expect(a?.title).toBe("A");
  });

  it("parses effectiveValue from xlabel attribute", () => {
    const dot = `digraph {
      A [xlabel="5"]
    }`;
    const tasks = parseDot(dot);
    const a = tasks.find((t) => t.taskId === "A");
    expect(a?.effectiveValue).toBe(5);
  });

  it("parses assigneeId from tooltip attribute", () => {
    const dot = `digraph {
      A [tooltip="user1"]
    }`;
    const tasks = parseDot(dot);
    const a = tasks.find((t) => t.taskId === "A");
    expect(a?.assigneeId).toBe("user1");
  });

  it("handles empty graph", () => {
    const dot = `digraph {}`;
    const tasks = parseDot(dot);
    expect(tasks).toHaveLength(0);
  });

  it("creates default tasks for nodes only in edges", () => {
    const dot = `digraph { A -> B }`;
    const tasks = parseDot(dot);
    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      expect(t.description).toBe("");
      expect(t.statusId).toBe("");
      expect(t.tags).toEqual([]);
      expect(t.estimate).toBe(0);
    }
  });

  it("handles chain A -> B -> C", () => {
    const dot = `digraph { A -> B -> C }`;
    const tasks = parseDot(dot);
    const a = tasks.find((t) => t.taskId === "A");
    const b = tasks.find((t) => t.taskId === "B");
    const c = tasks.find((t) => t.taskId === "C");
    expect(a?.dependsOn).toContain("B");
    expect(b?.dependsOn).toContain("C");
    expect(c?.dependsOn).toEqual([]);
  });
});
