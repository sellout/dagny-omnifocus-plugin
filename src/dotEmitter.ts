// Emit Graphviz DOT format from graph structures.

import { Digraph, toDot } from "ts-graphviz";

// Emit the transitively-reduced DAG as DOT.
export function graphToDot(
  tasks: DagnyTaskWithId[],
  reducedEdges: Map<string, Set<string>>,
): string {
  const g = new Digraph();

  for (const t of tasks) {
    if (!reducedEdges.has(t.taskId)) continue;
    g.node(t.taskId, { label: t.title });
  }

  for (const [id, deps] of reducedEdges) {
    for (const dep of deps) {
      // A depends on B => A -> B
      g.edge([id, dep]);
    }
  }

  return toDot(g);
}

// Emit the OFTreeNode[] tree as DOT with subgraph clusters for groups.
export function treeToDot(nodes: OFTreeNode[]): string {
  const g = new Digraph();
  let clusterId = 0;

  function emitNodes(
    container: Digraph | ReturnType<Digraph["subgraph"]>,
    children: OFTreeNode[],
  ): void {
    for (const node of children) {
      if (node.children.length === 0) {
        container.node(node.dagnyTaskId, { label: node.dagnyTaskId });
      } else {
        const label = `${node.dagnyTaskId} [${node.sequential ? "seq" : "par"}]`;
        const sgId = `cluster_${clusterId++}`;
        container.subgraph(sgId, (sg) => {
          sg.apply({ label, style: "dashed" });
          sg.node(node.dagnyTaskId, { label: node.dagnyTaskId, shape: "box" });
          emitNodes(sg as any, node.children);
          // Show ordering within sequential groups
          if (node.sequential && node.children.length > 1) {
            for (let i = 0; i < node.children.length - 1; i++) {
              sg.edge(
                [
                  node.children[i].dagnyTaskId,
                  node.children[i + 1].dagnyTaskId,
                ],
                { style: "dotted" },
              );
            }
          }
        });
      }
    }
  }

  emitNodes(g, nodes);
  return toDot(g);
}
