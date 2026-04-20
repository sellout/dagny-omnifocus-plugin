// Library entry point for the graph conversion library.

export {
  mergeLabels,
  unlabel,
  buildLabeledDag,
  buildDag,
  transitiveReductionLabeled,
  transitiveReduction,
  labelScore,
  isReachable,
  findChain,
  areIndependent,
  topologicalSort,
  subtreePriority,
  sortByPriority,
  dagToTree,
  pruneBlockedLeaves,
  flattenTree,
  filterTasksForTeam,
} from "./dagGraph.js";

export { parseDot } from "./dotParser.js";
export { graphToDot, treeToDot } from "./dotEmitter.js";

import { parseDot } from "./dotParser.js";
import { buildDag, transitiveReduction, dagToTree } from "./dagGraph.js";
import { graphToDot } from "./dotEmitter.js";

export function processGraph(
  dotInput: string,
  options?: {
    mode?: DependencyMode;
    format?: "dot" | "json" | "both";
  },
): { tree: OFTreeNode[]; reducedDot?: string; treeJson?: string } {
  const tasks = parseDot(dotInput);
  const mode = options?.mode ?? "conservative";
  const format = options?.format ?? "both";

  const tree = dagToTree(tasks, mode);

  const result: { tree: OFTreeNode[]; reducedDot?: string; treeJson?: string } =
    { tree };

  if (format === "dot" || format === "both") {
    const dag = buildDag(tasks);
    const reduced = transitiveReduction(dag.dependsOn, dag.taskIds);
    result.reducedDot = graphToDot(tasks, reduced);
  }

  if (format === "json" || format === "both") {
    result.treeJson = JSON.stringify(tree, null, 2);
  }

  return result;
}
