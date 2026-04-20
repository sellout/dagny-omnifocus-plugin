// Graph algorithm types — single source of truth.
// Ambient declarations usable by both the ES-module library build
// and the module-free OmniFocus plugin build.

interface DagnyTaskWithId {
  taskId: string;
  title: string;
  description: string;
  dependsOn: string[];
  statusId: string;
  tags: string[];
  estimate: number;
  value?: number | null;
  effectiveValue?: number | null;
  assigneeId?: string | null;
  collaboratorIds?: string[];
}

// Tree structure computed from Dagny's dependency DAG,
// describing the intended OF hierarchy.
interface OFTreeNode {
  dagnyTaskId: string;
  sequential: boolean;
  children: OFTreeNode[];
  noFlatten?: boolean;
}

type DependencyMode = "conservative" | "optimistic";

type TaskCategory = "mine" | "blocker" | "blocked";

type EdgeLabel = "dagny" | "OF" | "both";
type LabeledEdges = Map<string, Map<string, EdgeLabel>>;
