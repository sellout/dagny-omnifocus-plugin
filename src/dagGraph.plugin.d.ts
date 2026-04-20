// Ambient declarations for dagGraph functions used by the plugin.
// The actual implementations are injected into syncPull.js by build.mjs.

declare function mergeLabels(a: EdgeLabel, b: EdgeLabel): EdgeLabel;

declare function unlabel(
  labeled: LabeledEdges,
): Map<string, Set<string>>;

declare function buildLabeledDag(
  tasks: DagnyTaskWithId[],
  ofEdges?: Map<string, Set<string>>,
  excludeIds?: Set<string>,
): {
  dependsOn: LabeledEdges;
  dependedOnBy: Map<string, Set<string>>;
  taskIds: Set<string>;
};

declare function buildDag(
  tasks: DagnyTaskWithId[],
  excludeIds?: Set<string>,
): {
  dependsOn: Map<string, Set<string>>;
  dependedOnBy: Map<string, Set<string>>;
  taskIds: Set<string>;
};

declare function transitiveReductionLabeled(
  dependsOn: LabeledEdges,
  taskIds: Set<string>,
): LabeledEdges;

declare function transitiveReduction(
  dependsOn: Map<string, Set<string>>,
  taskIds: Set<string>,
): Map<string, Set<string>>;

declare function isReachable(
  from: string,
  to: string,
  dependsOn: Map<string, Set<string>>,
): boolean;

declare function findChain(
  taskIds: string[],
  dependsOn: Map<string, Set<string>>,
): string[] | null;

declare function areIndependent(
  taskIds: string[],
  dependsOn: Map<string, Set<string>>,
): boolean;

declare function topologicalSort(
  taskIds: string[],
  dependsOn: Map<string, Set<string>>,
): string[];

declare function labelScore(label: EdgeLabel): number;

declare function dagToTree(
  tasks: DagnyTaskWithId[],
  mode: DependencyMode,
  containerSequential?: boolean,
  excludeIds?: Set<string>,
  noFlattenIds?: Set<string>,
  edgeLabels?: LabeledEdges,
): OFTreeNode[];

declare function flattenTree(
  nodes: OFTreeNode[],
  parentSequential: boolean,
): OFTreeNode[];

declare function filterTasksForTeam(
  tasks: DagnyTaskWithId[],
  teamUserId: string,
  includeUnassigned: boolean,
): {
  filteredTasks: DagnyTaskWithId[];
  categories: Map<string, TaskCategory>;
};
