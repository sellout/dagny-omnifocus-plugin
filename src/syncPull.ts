(() => {
  // DAG-to-tree functions (buildDag, transitiveReduction, dagToTree, etc.)
  // are defined in dagGraph.ts and available in the global scope when
  // compiled with module: "none".

  // ---- Tree-to-OF reconciliation ----

  function applyTree(
    nodes: OFTreeNode[],
    parentPosition: any,
    dagnyTaskMap: Map<string, DagnyTaskWithId>,
    existingIndex: Map<string, Task>,
    mapping: ProjectMapping,
    projStatusMap: ProjectStatusMapping | undefined,
    memberMap: Map<string, string>,
    myUserId: string,
    lib: any,
    counters: { created: number; updated: number },
  ): void {
    for (var i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const dt = dagnyTaskMap.get(node.dagnyTaskId);
      if (!dt) continue;

      var ofTask: Task | undefined = existingIndex.get(dt.taskId);
      const isNew = !ofTask;

      if (isNew) {
        ofTask = new Task(dt.title, parentPosition);
        lib.setDagnyMarker(ofTask, mapping.dagnyProjectName, dt.taskId);
        counters.created++;
      } else {
        moveTasks([ofTask!], parentPosition);
        counters.updated++;
      }

      updateTaskFields(
        ofTask!,
        dt,
        mapping,
        projStatusMap,
        memberMap,
        myUserId,
        lib,
      );

      if (node.children.length > 0) {
        ofTask!.sequential = node.sequential;
        applyTree(
          node.children,
          ofTask!.ending,
          dagnyTaskMap,
          existingIndex,
          mapping,
          projStatusMap,
          memberMap,
          myUserId,
          lib,
          counters,
        );
      }
    }
  }

  function updateTaskFields(
    ofTask: Task,
    dt: DagnyTaskWithId,
    mapping: ProjectMapping,
    projStatusMap: ProjectStatusMapping | undefined,
    memberMap: Map<string, string>,
    myUserId: string,
    lib: any,
  ): void {
    ofTask.name = dt.title;

    const description = dt.description || "";
    const marker =
      "[dagny:" + mapping.dagnyProjectName + ":" + dt.taskId + "]";
    if (description) {
      ofTask.note = description + "\n" + marker;
    } else {
      ofTask.note = marker;
    }

    if (dt.estimate != null) {
      ofTask.estimatedMinutes = dt.estimate;
    }

    // Flag based on value (not effectiveValue) since OF propagates
    // flags to children similarly to how Dagny propagates priority.
    ofTask.flagged = dt.value != null && dt.value > 0;

    if (dt.statusId) {
      lib.applyStatusToOFTask(ofTask, dt.statusId, projStatusMap);
    }

    if (dt.tags && dt.tags.length > 0) {
      for (const dagnyTagStr of dt.tags) {
        if (
          dagnyTagStr.startsWith("Dagny status:") ||
          dagnyTagStr.startsWith("waiting on:")
        ) {
          continue;
        }
        const ofTag: Tag = lib.ensureTagHierarchy(dagnyTagStr);
        if (!ofTask.tags.includes(ofTag)) {
          ofTask.addTag(ofTag);
        }
      }
    }

    const existingWaitingOn = ofTask.tags.filter(function (t: Tag) {
      return lib.isWaitingOnTag(t);
    });
    if (existingWaitingOn.length > 0) {
      ofTask.removeTags(existingWaitingOn);
    }
    if (dt.assigneeId && dt.assigneeId !== myUserId) {
      const assigneeName = memberMap.get(dt.assigneeId);
      if (assigneeName) {
        ofTask.addTag(lib.ensureWaitingOnTag(assigneeName));
      }
    }
  }

  // ---- Main action ----

  const action = new PlugIn.Action(async function (
    this: any,
    selection: any,
    sender: any,
  ) {
    const lib = this.plugIn.library("dagnyLib");

    try {
      const mappings: ProjectMapping[] = lib.getProjectMappings();
      if (!mappings || mappings.length === 0) {
        const alert = new Alert(
          "Not Configured",
          "No project mappings found. Run Configure first.",
        );
        await alert.show();
        return;
      }

      await lib.login();

      const counters = { created: 0, updated: 0 };

      const me: UserProfile = await lib.getMe();
      const myUserId = me.userId;

      for (const mapping of mappings) {
        const dagnyTasks: DagnyTaskWithId[] = await lib.getTasks(
          mapping.dagnyProjectId,
        );
        const projStatusMap: ProjectStatusMapping | undefined =
          lib.getProjectStatusMap(mapping.dagnyProjectId);

        const members: ProjectMember[] = await lib.getProjectMembers(
          mapping.dagnyProjectId,
        );
        const memberMap = new Map<string, string>();
        for (const m of members) {
          memberMap.set(m.userId, m.username);
        }

        const target: OFTarget = lib.resolveOFTarget(mapping);

        const existingIndex = new Map<string, Task>();
        const tasksToScan: Task[] =
          target.type === "everything"
            ? (flattenedTasks as Task[])
            : target.tasks;

        for (const ofTask of tasksToScan) {
          const marker: DagnyMarker | null = lib.getDagnyMarker(ofTask);
          if (marker && lib.markerMatchesProject(marker, mapping)) {
            existingIndex.set(marker.taskId, ofTask);
          }
        }

        const dagnyTaskMap = new Map<string, DagnyTaskWithId>();
        for (const dt of dagnyTasks) {
          dagnyTaskMap.set(dt.taskId, dt);
        }

        const mode: DependencyMode =
          mapping.dependencyMode || "conservative";
        const tree = dagToTree(dagnyTasks, mode);

        const rootPosition = lib.insertionLocationForTarget(target);

        applyTree(
          tree,
          rootPosition,
          dagnyTaskMap,
          existingIndex,
          mapping,
          projStatusMap,
          memberMap,
          myUserId,
          lib,
          counters,
        );
      }

      const summary = new Alert(
        "Pull Complete",
        "Created " +
          counters.created +
          " task(s), updated " +
          counters.updated +
          " task(s).",
      );
      await summary.show();
    } catch (err: any) {
      const errAlert = new Alert("Pull Error", err.message);
      await errAlert.show();
    }
  });

  action.validate = function (selection: any, sender: any): boolean {
    return true;
  };

  return action;
})();
