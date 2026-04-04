(() => {
  const credentials = new Credentials();
  const preferences = new Preferences();

  const SERVICE_NAME = "dagny-sync";
  const PREF_BASE_URL = "dagnyBaseUrl";
  const PREF_PROJECT_MAPPINGS = "projectMappings";
  const PREF_STATUS_MAPPINGS = "statusMappings";

  const lib = new PlugIn.Library(new Version("0.1"));

  // ---- Configuration helpers ----

  lib.getBaseUrl = function (): string {
    return preferences.readString(PREF_BASE_URL) || "https://dagny.co/api";
  };

  lib.setBaseUrl = function (url: string): void {
    preferences.write(PREF_BASE_URL, url);
  };

  lib.getProjectMappings = function (): ProjectMapping[] {
    const raw = preferences.readString(PREF_PROJECT_MAPPINGS);
    return raw ? JSON.parse(raw) : [];
  };

  lib.setProjectMappings = function (mappings: ProjectMapping[]): void {
    preferences.write(PREF_PROJECT_MAPPINGS, JSON.stringify(mappings));
  };

  lib.getStatusMappings = function (): ProjectStatusMapping[] {
    const raw = preferences.readString(PREF_STATUS_MAPPINGS);
    return raw ? JSON.parse(raw) : [];
  };

  lib.setStatusMappings = function (mappings: ProjectStatusMapping[]): void {
    preferences.write(PREF_STATUS_MAPPINGS, JSON.stringify(mappings));
  };

  // ---- HTTP client with session management ----

  // Session state — stored in module-level vars since library object
  // properties may not persist across async calls in Omni Automation.
  var sessionCookie: string | null = null;
  var xsrfToken: string | null = null;

  lib.login = async function (
    username?: string,
    password?: string,
  ): Promise<void> {
    if (!username || !password) {
      const cred = credentials.read(SERVICE_NAME);
      if (!cred) {
        throw new Error(
          "No Dagny credentials configured. Run Configure first.",
        );
      }
      username = cred.user;
      password = cred.password;
    }
    const baseUrl: string = lib.getBaseUrl();
    const req = new URL.FetchRequest();
    req.url = URL.fromString(baseUrl + "/login");
    req.method = "POST";
    req.headers = { "Content-Type": "application/json;charset=utf-8" };
    req.bodyString = JSON.stringify({ username, password });
    const resp = await req.fetch();
    if (resp.statusCode !== 204 && resp.statusCode !== 200) {
      throw new Error("Dagny login failed: HTTP " + resp.statusCode);
    }
    const cookieKey = Object.keys(resp.headers).find(
      (k: string) => k.toLowerCase() === "set-cookie",
    );
    if (cookieKey) {
      const raw = String(resp.headers[cookieKey]);
      const jwtMatch = raw.match(/JWT-Cookie=([^;]+)/);
      const xsrfMatch = raw.match(/XSRF-TOKEN=([^;]+)/);
      if (jwtMatch && xsrfMatch) {
        sessionCookie =
          "JWT-Cookie=" + jwtMatch[1] + "; XSRF-TOKEN=" + xsrfMatch[1];
        xsrfToken = xsrfMatch[1];
      } else if (jwtMatch) {
        sessionCookie = "JWT-Cookie=" + jwtMatch[1];
      }
    }
  };

  lib.buildRequest = function (
    method: string,
    path: string,
    body?: any,
  ): URL.FetchRequest {
    const baseUrl: string = lib.getBaseUrl();
    const req = new URL.FetchRequest();
    req.url = URL.fromString(baseUrl + path);
    req.method = method;
    const hdrs: Record<string, string> = {
      "Content-Type": "application/json;charset=utf-8",
    };
    if (sessionCookie) {
      hdrs["Cookie"] = sessionCookie;
    }
    if (xsrfToken) {
      hdrs["X-XSRF-TOKEN"] = xsrfToken;
    }
    req.headers = hdrs;
    if (body) {
      req.bodyString = JSON.stringify(body);
    }
    return req;
  };

  lib.fetch = async function (
    method: string,
    path: string,
    body?: any,
  ): Promise<any> {
    if (!sessionCookie) {
      await lib.login();
    }
    let resp = await lib.buildRequest(method, path, body).fetch();
    if (resp.statusCode === 401) {
      await lib.login();
      resp = await lib.buildRequest(method, path, body).fetch();
    }
    return lib.parseResponse(resp);
  };

  lib.parseResponse = function (resp: URL.FetchResponse): any {
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      if (resp.bodyString && resp.bodyString.length > 0) {
        return JSON.parse(resp.bodyString);
      }
      return null;
    }
    throw new Error(
      "Dagny API error: HTTP " +
        resp.statusCode +
        " " +
        (resp.bodyString || ""),
    );
  };

  // ---- Dagny API wrappers ----

  lib.getProjects = function (): Promise<DagnyProject[]> {
    return lib.fetch("GET", "/projects");
  };

  lib.createProject = function (name: string): Promise<DagnyProject> {
    return lib.fetch("POST", "/projects", { name: name });
  };

  lib.getStatuses = function (projectId: string): Promise<DagnyStatus[]> {
    return lib.fetch("GET", "/statuses/" + projectId);
  };

  lib.getTasks = function (
    projectId: string,
    params?: TaskQueryParams,
  ): Promise<DagnyTaskWithId[]> {
    let qs = "";
    if (params) {
      const parts: string[] = [];
      if (params.status_ids) {
        params.status_ids.forEach((id: string) => {
          parts.push("status_id=" + encodeURIComponent(id));
        });
      }
      if (params.tags) {
        params.tags.forEach((t: string) => {
          parts.push("tag=" + encodeURIComponent(t));
        });
      }
      if (parts.length) {
        qs = "?" + parts.join("&");
      }
    }
    return lib.fetch("GET", "/tasks/" + projectId + qs);
  };

  lib.createTask = function (
    projectId: string,
    task: DagnyTaskCreate,
  ): Promise<string> {
    return lib.fetch("POST", "/tasks/" + projectId, task);
  };

  lib.updateTask = function (
    projectId: string,
    taskId: string,
    patch: DagnyTaskUpdate,
  ): Promise<void> {
    return lib.fetch("PATCH", "/tasks/" + projectId + "/" + taskId, patch);
  };

  lib.getProjectMembers = function (
    projectId: string,
  ): Promise<ProjectMember[]> {
    return lib.fetch("GET", "/projects/" + projectId + "/members");
  };

  lib.getMe = function (): Promise<UserProfile> {
    return lib.fetch("GET", "/users/me");
  };

  // ---- Sync identity helpers ----

  const DAGNY_ATTACHMENT_NAME = "dagny.json";

  lib.getDagnyMarker = function (ofTask: Task): DagnyMarker | null {
    for (var i = 0; i < ofTask.attachments.length; i++) {
      const att = ofTask.attachments[i];
      if (
        (att.preferredFilename === DAGNY_ATTACHMENT_NAME ||
          att.filename === DAGNY_ATTACHMENT_NAME) &&
        att.contents
      ) {
        try {
          const data = JSON.parse(att.contents.toString());
          if (data.projectId && data.taskId) {
            return { projectId: data.projectId, taskId: data.taskId };
          }
        } catch (e) {
          // Malformed attachment — ignore
        }
      }
    }
    return null;
  };

  lib.markerMatchesProject = function (
    marker: DagnyMarker,
    mapping: ProjectMapping,
  ): boolean {
    return marker.projectId === mapping.dagnyProjectId;
  };

  lib.setDagnyMarker = function (
    ofTask: Task,
    dagnyProjectId: string,
    dagnyTaskId: string,
  ): void {
    // Remove existing dagny.json attachment if present
    for (var i = ofTask.attachments.length - 1; i >= 0; i--) {
      const att = ofTask.attachments[i];
      if (
        att.preferredFilename === DAGNY_ATTACHMENT_NAME ||
        att.filename === DAGNY_ATTACHMENT_NAME
      ) {
        ofTask.removeAttachmentAtIndex(i);
      }
    }
    const json = JSON.stringify({
      projectId: dagnyProjectId,
      taskId: dagnyTaskId,
    });
    const wrapper = FileWrapper.withContents(
      DAGNY_ATTACHMENT_NAME,
      Data.fromString(json),
    );
    ofTask.addAttachment(wrapper);
  };

  // ---- Tag helpers ----

  lib.ensureTagHierarchy = function (colonSeparatedName: string): Tag {
    const parts = colonSeparatedName.split(":");
    let current: Tag | null = null;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i].trim();
      if (i === 0) {
        current = flattenedTags.byName(name);
        if (!current) {
          current = new Tag(name, tags.ending);
        }
      } else {
        const child: Tag | undefined = current!.children.find(
          (t: Tag) => t.name === name,
        );
        if (child) {
          current = child;
        } else {
          current = new Tag(name, current!.ending);
        }
      }
    }
    return current!;
  };

  lib.ensureStatusTag = function (statusName: string): Tag {
    return lib.ensureTagHierarchy("Dagny status:" + statusName);
  };

  lib.ofTagToDagnyString = function (tag: Tag): string {
    const parts: string[] = [];
    let t: Tag | null = tag;
    while (t) {
      parts.unshift(t.name);
      t = t.parent;
    }
    return parts.join(":");
  };

  lib.isStatusTag = function (tag: Tag): boolean {
    return tag.parent != null && tag.parent.name === "Dagny status";
  };

  lib.isWaitingOnTag = function (tag: Tag): boolean {
    return tag.parent != null && tag.parent.name === "waiting on";
  };

  lib.getWaitingOnUsername = function (tag: Tag): string | null {
    if (lib.isWaitingOnTag(tag)) {
      return tag.name;
    }
    return null;
  };

  lib.ensureWaitingOnTag = function (username: string): Tag {
    return lib.ensureTagHierarchy("waiting on:" + username);
  };

  // ---- OF target resolution ----

  lib.resolveOFTarget = function (mapping: ProjectMapping): OFTarget {
    if (mapping.ofType === "project") {
      const proj = flattenedProjects.byName(mapping.ofName!);
      if (!proj) {
        throw new Error("OmniFocus project not found: " + mapping.ofName);
      }
      return { tasks: proj.flattenedTasks, container: proj, type: "project" };
    } else if (mapping.ofType === "folder") {
      const folder = flattenedFolders.byName(mapping.ofName!);
      if (!folder) {
        throw new Error("OmniFocus folder not found: " + mapping.ofName);
      }
      const allTasks: Task[] = [];
      folder.flattenedProjects.forEach((p: Project) => {
        p.flattenedTasks.forEach((t: Task) => {
          allTasks.push(t);
        });
      });
      let defaultProj: Project | null = null;
      if (mapping.ofDefaultProject) {
        defaultProj =
          folder.flattenedProjects.find(
            (p: Project) => p.name === mapping.ofDefaultProject,
          ) || null;
      }
      if (!defaultProj && folder.flattenedProjects.length > 0) {
        defaultProj = folder.flattenedProjects[0];
      }
      return {
        tasks: allTasks,
        container: defaultProj,
        folder: folder,
        type: "folder",
      };
    } else {
      return {
        tasks: flattenedTasks as Task[],
        container: null,
        type: "everything",
      };
    }
  };

  lib.insertionLocationForTarget = function (target: OFTarget): any {
    if (target.type === "project" && target.container) {
      return target.container.ending;
    } else if (target.type === "folder" && target.container) {
      return target.container.ending;
    } else {
      return inbox.ending;
    }
  };

  // ---- Status mapping helpers ----

  lib.getProjectStatusMap = function (
    dagnyProjectId: string,
  ): ProjectStatusMapping | undefined {
    const all: ProjectStatusMapping[] = lib.getStatusMappings();
    return all.find(
      (sm: ProjectStatusMapping) => sm.dagnyProjectId === dagnyProjectId,
    );
  };

  lib.applyStatusToOFTask = function (
    ofTask: Task,
    dagnyStatusId: string,
    projStatusMap: ProjectStatusMapping | undefined,
  ): void {
    if (!projStatusMap || !projStatusMap.mappings) return;

    const entry = projStatusMap.mappings.find(
      (m: StatusMappingEntry) => m.dagnyStatusId === dagnyStatusId,
    );
    if (!entry) return;

    const existingStatusTags = ofTask.tags.filter((t: Tag) =>
      lib.isStatusTag(t),
    );
    if (existingStatusTags.length > 0) {
      ofTask.removeTags(existingStatusTags);
    }

    if (entry.ofAction === "completed") {
      if (!ofTask.completed) {
        ofTask.markComplete();
      }
    } else if (entry.ofAction === "dropped") {
      if (ofTask.taskStatus !== Task.Status.Dropped) {
        ofTask.drop(false);
      }
    } else {
      if (ofTask.completed) {
        ofTask.markIncomplete();
      }
    }

    if (!entry.isDefault) {
      const statusTag = lib.ensureStatusTag(entry.dagnyStatusName);
      ofTask.addTag(statusTag);
    }
  };

  lib.dagnyStatusFromOFTask = function (
    ofTask: Task,
    projStatusMap: ProjectStatusMapping | undefined,
  ): string | null {
    if (!projStatusMap || !projStatusMap.mappings) return null;

    if (ofTask.completed) {
      const completed = projStatusMap.mappings.find(
        (m: StatusMappingEntry) => m.ofAction === "completed" && m.isDefault,
      );
      if (completed) return completed.dagnyStatusId;
      const anyCompleted = projStatusMap.mappings.find(
        (m: StatusMappingEntry) => m.ofAction === "completed",
      );
      if (anyCompleted) return anyCompleted.dagnyStatusId;
    }

    if (ofTask.taskStatus === Task.Status.Dropped) {
      const dropped = projStatusMap.mappings.find(
        (m: StatusMappingEntry) => m.ofAction === "dropped" && m.isDefault,
      );
      if (dropped) return dropped.dagnyStatusId;
      const anyDropped = projStatusMap.mappings.find(
        (m: StatusMappingEntry) => m.ofAction === "dropped",
      );
      if (anyDropped) return anyDropped.dagnyStatusId;
    }

    const statusTags = ofTask.tags.filter((t: Tag) => lib.isStatusTag(t));
    if (statusTags.length > 0) {
      const statusName = statusTags[0].name;
      const byTag = projStatusMap.mappings.find(
        (m: StatusMappingEntry) => m.dagnyStatusName === statusName,
      );
      if (byTag) return byTag.dagnyStatusId;
    }

    const defaultActive = projStatusMap.mappings.find(
      (m: StatusMappingEntry) => m.ofAction === "active" && m.isDefault,
    );
    if (defaultActive) return defaultActive.dagnyStatusId;

    const anyActive = projStatusMap.mappings.find(
      (m: StatusMappingEntry) => m.ofAction === "active",
    );
    return anyActive ? anyActive.dagnyStatusId : null;
  };

  // ---- Credential management ----

  lib.saveCredentials = function (username: string, password: string): void {
    credentials.write(SERVICE_NAME, username, password);
  };

  lib.hasCredentials = function (): boolean {
    return credentials.read(SERVICE_NAME) !== null;
  };

  lib.clearCredentials = function (): void {
    credentials.remove(SERVICE_NAME);
  };

  return lib;
})();
