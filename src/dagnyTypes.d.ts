// Dagny REST API types and plugin configuration types.
// Graph algorithm types (DagnyTaskWithId, OFTreeNode, DependencyMode,
// TaskCategory) live in graphTypes.d.ts — do not duplicate here.

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

interface ProjectMapping {
  dagnyProjectId: string;
  dagnyProjectName: string;
  ofType: OFTargetType;
  ofName: string | null;
  ofDefaultProject: string | null;
  dependencyMode?: DependencyMode;
  estimateMultiplier?: number; // minutes per Dagny estimate unit
  teamUserId?: string | null;
  teamUsername?: string | null;
  includeUnassigned?: boolean;
  newTaskAssignment?: "user" | "unassigned";
  tagPrefix?: string | null;
  forceTagPrefix?: boolean;
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
  projectId: string;
  taskId: string;
}

interface TaskGitHubLink {
  repoId: string;
  repoOwner: string;
  repoName: string;
  itemType: string;
  itemNumber: number;
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
