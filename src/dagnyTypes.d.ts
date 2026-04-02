// Dagny REST API types and plugin configuration types.

interface DagnyProject {
  id: string;
  name: string;
  createdAt?: string;
  archivedAt?: string | null;
}

interface DagnyStatus {
  id: string;
  name: string;
  color: string;
  isClosed: boolean;
  sortOrder: number;
}

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
  hasGitHubLink?: boolean;
  hasPR?: boolean;
}

interface DagnyTaskCreate {
  title: string;
  description: string;
  dependsOn: string[];
  statusId?: string;
  tags: string[];
  estimate: number;
  value?: number | null;
  assigneeId?: string | null;
}

interface DagnyTaskUpdate {
  title?: string;
  description?: string;
  dependsOn?: string[];
  statusId?: string;
  tags?: string[];
  estimate?: number;
  value?: number | null;
  assigneeId?: string | null;
  collaboratorIds?: string[];
}

interface ProjectMember {
  userId: string;
  username: string;
  role: string;
}

interface UserProfile {
  userId: string;
  username: string;
  email: string;
  hasPassword: boolean;
  isSiteAdmin: boolean;
}

// ---- Plugin Configuration ----

type OFTargetType = "project" | "folder" | "everything";
type OFAction = "active" | "completed" | "dropped";

type DependencyMode = "conservative" | "optimistic";

interface ProjectMapping {
  dagnyProjectId: string;
  dagnyProjectName: string;
  ofType: OFTargetType;
  ofName: string | null;
  ofDefaultProject: string | null;
  dependencyMode?: DependencyMode;
}

// Tree structure computed from Dagny's dependency DAG,
// describing the intended OF hierarchy.
interface OFTreeNode {
  dagnyTaskId: string;
  sequential: boolean;
  children: OFTreeNode[];
}

interface StatusMappingEntry {
  dagnyStatusId: string;
  dagnyStatusName: string;
  isClosed: boolean;
  ofAction: OFAction;
  isDefault: boolean;
}

interface ProjectStatusMapping {
  dagnyProjectId: string;
  mappings: StatusMappingEntry[];
}

interface DagnyMarker {
  projectKey: string;
  taskId: string;
}

interface OFTarget {
  tasks: Task[];
  container: Project | null;
  folder?: Folder;
  type: OFTargetType;
}

interface TaskQueryParams {
  status_ids?: string[];
  tags?: string[];
}
