(() => {
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

      let totalCreated = 0;
      let totalUpdated = 0;

      const me: UserProfile = await lib.getMe();
      const myUserId = me.userId;

      for (const mapping of mappings) {
        const dagnyTasks: DagnyTaskWithId[] = await lib.getTasks(
          mapping.dagnyProjectId,
        );
        const dagnyStatuses: DagnyStatus[] = await lib.getStatuses(
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

        const index = new Map<string, Task>();
        const tasksToScan: Task[] =
          target.type === "everything"
            ? (flattenedTasks as Task[])
            : target.tasks;

        for (const ofTask of tasksToScan) {
          const marker: DagnyMarker | null = lib.getDagnyMarker(ofTask);
          if (marker && lib.markerMatchesProject(marker, mapping)) {
            index.set(marker.taskId, ofTask);
          }
        }

        for (const dt of dagnyTasks) {
          if (dt.title.startsWith("[OF Project] ")) continue;

          let ofTask: Task | undefined = index.get(dt.taskId);
          const isNew = !ofTask;

          if (isNew) {
            const insertLoc = lib.insertionLocationForTarget(target);
            ofTask = new Task(dt.title, insertLoc);
            lib.setDagnyMarker(ofTask, mapping.dagnyProjectName, dt.taskId);
            totalCreated++;
          } else {
            totalUpdated++;
          }

          ofTask!.name = dt.title;

          const description = dt.description || "";
          const marker =
            "[dagny:" + mapping.dagnyProjectName + ":" + dt.taskId + "]";
          if (description) {
            ofTask!.note = description + "\n" + marker;
          } else {
            ofTask!.note = marker;
          }

          if (dt.estimate != null) {
            ofTask!.estimatedMinutes = dt.estimate;
          }

          const ev = dt.effectiveValue != null ? dt.effectiveValue : dt.value;
          ofTask!.flagged = ev != null && ev > 0;

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
              if (!ofTask!.tags.includes(ofTag)) {
                ofTask!.addTag(ofTag);
              }
            }
          }

          const existingWaitingOn = ofTask!.tags.filter((t: Tag) =>
            lib.isWaitingOnTag(t),
          );
          if (existingWaitingOn.length > 0) {
            ofTask!.removeTags(existingWaitingOn);
          }
          if (dt.assigneeId && dt.assigneeId !== myUserId) {
            const assigneeName = memberMap.get(dt.assigneeId);
            if (assigneeName) {
              ofTask!.addTag(lib.ensureWaitingOnTag(assigneeName));
            }
          }
        }
      }

      const summary = new Alert(
        "Pull Complete",
        "Created " +
          totalCreated +
          " task(s), updated " +
          totalUpdated +
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
