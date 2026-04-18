(() => {
  const action = new PlugIn.Action(async function (
    this: any,
    selection: any,
    sender: any,
  ) {
    const lib = this.plugIn.library("dagnyLib");
    const DagnyAPIError = lib.DagnyAPIError;

    try {
      const mappings: ProjectMapping[] = lib.getProjectMappings();
      if (!mappings || mappings.length === 0) {
        const alert = new Alert(
          "Not Configured",
          "No project mappings found. Run Configure first.",
        );
        await alert.show(null);
        return;
      }

      await lib.login();

      let totalCreated = 0;
      let totalUpdated = 0;

      const me: UserProfile = await lib.getMe();
      const myUserId = me.userId;

      for (const mapping of mappings) {
        const projStatusMap: ProjectStatusMapping | undefined =
          lib.getProjectStatusMap(mapping.dagnyProjectId);
        const target: OFTarget = lib.resolveOFTarget(mapping);

        const members: ProjectMember[] = await lib.getProjectMembers(
          mapping.dagnyProjectId,
        );
        const usernameToId = new Map<string, string>();
        for (const m of members) {
          usernameToId.set(m.username, m.userId);
        }

        const dagnyTasks: DagnyTaskWithId[] = await lib.getTasks(
          mapping.dagnyProjectId,
        );
        const dagnyIndex = new Map<string, DagnyTaskWithId>();
        for (const dt of dagnyTasks) {
          dagnyIndex.set(dt.taskId, dt);
        }

        const tasksToScan: Task[] =
          target.type === "everything"
            ? (flattenedTasks as Task[])
            : target.tasks;

        const ofProjectChildren = new Map<string, string[]>();
        const ofProjectSequential = new Map<string, boolean>();

        const ofToDagnyId = new Map<string, string>();
        for (const ofTask of tasksToScan) {
          const m: DagnyMarker | null = lib.getDagnyMarker(ofTask);
          if (m && lib.markerMatchesProject(m, mapping)) {
            ofToDagnyId.set(ofTask.id.primaryKey, m.taskId);
          }
        }

        async function retryWithoutStaleStatus(
          e: InstanceType<typeof DagnyAPIError>,
          projectId: string,
          statusId: string | undefined,
          retry: () => Promise<void>,
        ): Promise<boolean> {
          if (!statusId) return false;
          if (e.message.indexOf("Status transition not allowed") >= 0) {
            await retry();
            return true;
          }
          const freshStatuses: DagnyStatus[] = await lib.getStatuses(projectId);
          const found = freshStatuses.some(
            (s: DagnyStatus) => s.id === statusId,
          );
          if (found) return false;
          await retry();
          return true;
        }

        async function processSiblings(
          siblings: Task[],
          isSequential: boolean,
          predecessor: string | null,
        ): Promise<void> {
          for (var i = 0; i < siblings.length; i++) {
            var ofTask = siblings[i];
            var marker: DagnyMarker | null = lib.getDagnyMarker(ofTask);

            var childPredecessor: string | null = null;
            if (isSequential && i > 0) {
              childPredecessor =
                ofToDagnyId.get(siblings[i - 1].id.primaryKey) || null;
            } else {
              // Parallel context or first child of sequential: inherit
              // predecessor from above so it propagates through nested groups.
              childPredecessor = predecessor;
            }

            if (marker && lib.markerMatchesProject(marker, mapping)) {
              var existingDagnyTask = dagnyIndex.get(marker.taskId);
              var patch = buildPatchFromOFTask(
                ofTask,
                existingDagnyTask || null,
                projStatusMap,
                lib,
                usernameToId,
                myUserId,
                mapping.estimateMultiplier || 1,
                mapping,
              );
              if (patch) {
                try {
                  await lib.updateTask(
                    mapping.dagnyProjectId,
                    marker.taskId,
                    patch,
                  );
                } catch (e: any) {
                  if (e instanceof DagnyAPIError) {
                    var recovered = await retryWithoutStaleStatus(
                      e,
                      mapping.dagnyProjectId,
                      patch.statusId,
                      async function () {
                        delete patch.statusId;
                        await lib.updateTask(
                          mapping.dagnyProjectId,
                          marker!.taskId,
                          patch,
                        );
                      },
                    );
                    if (!recovered) {
                      if (
                        patch.statusId &&
                        e.message.indexOf("Status transition not allowed") >= 0
                      ) {
                        var statusName = patch.statusId;
                        if (projStatusMap) {
                          var entry = projStatusMap.mappings.find(
                            (m: StatusMappingEntry) =>
                              m.dagnyStatusId === patch.statusId,
                          );
                          if (entry) statusName = entry.dagnyStatusName;
                        }
                        e.withContext(
                          "Setting status to \u201c" + statusName + "\u201d",
                        );
                      }
                      throw e.withContext(
                        "Updating \u201c" + ofTask.name + "\u201d",
                      );
                    }
                  } else {
                    throw e;
                  }
                }
                totalUpdated++;
              }
              if (ofTask.hasChildren) {
                var groupPred = childPredecessor;
                await processSiblings(
                  ofTask.children,
                  ofTask.sequential,
                  groupPred,
                );
              }
              continue;
            }

            if (marker) continue;

            if (!taskBelongsToMapping(ofTask, mapping, target)) {
              continue;
            }

            if (ofTask.hasChildren) {
              var groupPred = childPredecessor;
              await processSiblings(
                ofTask.children,
                ofTask.sequential,
                groupPred,
              );
            }

            var dagnyTask = buildDagnyTaskFromOF(
              ofTask,
              projStatusMap,
              lib,
              usernameToId,
              myUserId,
              mapping.estimateMultiplier || 1,
              mapping,
            );

            dagnyTask.dependsOn = computeDependencies(
              ofTask,
              i,
              siblings,
              isSequential,
              predecessor,
              ofToDagnyId,
            );

            var newId;
            try {
              newId = await lib.createTask(mapping.dagnyProjectId, dagnyTask);
            } catch (e: any) {
              if (e instanceof DagnyAPIError) {
                var recovered = await retryWithoutStaleStatus(
                  e,
                  mapping.dagnyProjectId,
                  dagnyTask.statusId,
                  async function () {
                    delete dagnyTask.statusId;
                    newId = await lib.createTask(
                      mapping.dagnyProjectId,
                      dagnyTask,
                    );
                  },
                );
                if (!recovered) {
                  throw e.withContext(
                    "Creating \u201c" + ofTask.name + "\u201d",
                  );
                }
              } else {
                throw e;
              }
            }
            var taskId: string =
              typeof newId === "string"
                ? newId
                : (newId as any).taskId || newId;
            lib.setDagnyMarker(ofTask, mapping.dagnyProjectId, taskId);
            ofToDagnyId.set(ofTask.id.primaryKey, taskId);
            totalCreated++;

            await updateReverseDeps(ofTask, taskId, i, siblings, isSequential);
          }
        }

        async function updateReverseDeps(
          ofTask: Task,
          newDagnyId: string,
          index: number,
          siblings: Task[],
          isSequential: boolean,
        ): Promise<void> {
          if (isSequential) {
            var isLast = index === siblings.length - 1;
            if (!isLast) {
              var nextSibling = siblings[index + 1];
              await addToDependsOn(nextSibling, newDagnyId);
            } else {
              await addToContainerDepsOn(ofTask, newDagnyId);
            }
          } else {
            await addToContainerDepsOn(ofTask, newDagnyId);
          }
        }

        async function addToDependsOn(
          ofTask: Task,
          newDepId: string,
        ): Promise<void> {
          var marker: DagnyMarker | null = lib.getDagnyMarker(ofTask);
          if (!marker || !lib.markerMatchesProject(marker, mapping)) {
            return;
          }
          var existing = dagnyIndex.get(marker.taskId);
          var currentDeps: string[] =
            existing && existing.dependsOn ? existing.dependsOn.slice() : [];
          if (currentDeps.indexOf(newDepId) === -1) {
            currentDeps.push(newDepId);
            await lib.updateTask(mapping.dagnyProjectId, marker.taskId, {
              dependsOn: currentDeps,
            });
            if (existing) existing.dependsOn = currentDeps;
          }
        }

        async function addToContainerDepsOn(
          ofTask: Task,
          newDepId: string,
        ): Promise<void> {
          var parentTask = ofTask.parent;
          if (parentTask) {
            await addToDependsOn(parentTask, newDepId);
          }
        }

        const ofProjectMarkerIds = new Map<string, string>();

        async function processProject(proj: Project): Promise<void> {
          var kids = proj.task.children;
          await processSiblings(kids, proj.sequential, null);

          if (target.type === "folder" || target.type === "everything") {
            var childDagnyIds: string[] = [];
            for (var k = 0; k < kids.length; k++) {
              var dagnyId = ofToDagnyId.get(kids[k].id.primaryKey);
              if (dagnyId) childDagnyIds.push(dagnyId);
            }
            if (childDagnyIds.length > 0) {
              ofProjectChildren.set(proj.name, childDagnyIds);
              ofProjectSequential.set(proj.name, proj.sequential);
            }
            // Track Dagny marker on project task for container lookup.
            var projMarker: DagnyMarker | null = lib.getDagnyMarker(proj.task);
            if (projMarker && lib.markerMatchesProject(projMarker, mapping)) {
              ofProjectMarkerIds.set(proj.name, projMarker.taskId);
              // Ensure Dagny link is up to date on the project task.
              lib.setDagnyMarker(
                proj.task,
                mapping.dagnyProjectId,
                projMarker.taskId,
              );
            }
          }
        }

        if (target.type === "project" && target.container) {
          await processProject(target.container);
        } else if (target.type === "folder" && target.folder) {
          for (var proj of target.folder.flattenedProjects as Project[]) {
            await processProject(proj);
          }
        } else {
          for (var proj of flattenedProjects as Project[]) {
            await processProject(proj);
          }
          var inboxTasks: Task[] = inbox ? Array.from(inbox) : [];
          if (inboxTasks.length > 0) {
            await processSiblings(inboxTasks, false, null);
          }
        }

        if (
          (target.type === "folder" || target.type === "everything") &&
          ofProjectChildren.size > 0
        ) {
          const projectDagnyIds = await syncProjectTasks(
            mapping,
            ofProjectChildren,
            ofProjectSequential,
            ofProjectMarkerIds,
            dagnyIndex,
            projStatusMap,
            lib,
          );

          const foldersToSync: Folder[] =
            target.type === "folder" && target.folder
              ? (target.folder.flattenedFolders as Folder[])
              : (flattenedFolders as Folder[]);

          if (foldersToSync.length > 0) {
            await syncFolderTasks(
              mapping,
              foldersToSync,
              projectDagnyIds,
              dagnyIndex,
              projStatusMap,
              lib,
            );
          }
        }
      }

      const summary = new Alert(
        "Push Complete",
        "Created " +
          totalCreated +
          " task(s), updated " +
          totalUpdated +
          " task(s) in Dagny.",
      );
      await summary.show(null);
    } catch (err: any) {
      const errAlert = new Alert("Push Error", err.message);
      await errAlert.show(null);
    }
  });

  function computeDependencies(
    ofTask: Task,
    index: number,
    siblings: Task[],
    isSequential: boolean,
    predecessor: string | null,
    ofToDagnyId: Map<string, string>,
  ): string[] {
    var deps: string[] = [];

    if (ofTask.hasChildren) {
      var children = ofTask.children;
      if (ofTask.sequential && children.length > 0) {
        var lastDagnyId = ofToDagnyId.get(
          children[children.length - 1].id.primaryKey,
        );
        if (lastDagnyId) deps.push(lastDagnyId);
      } else {
        for (var c = 0; c < children.length; c++) {
          var childDagnyId = ofToDagnyId.get(children[c].id.primaryKey);
          if (childDagnyId) deps.push(childDagnyId);
        }
      }
      return deps;
    }

    if (isSequential && index > 0) {
      var prevDagnyId = ofToDagnyId.get(siblings[index - 1].id.primaryKey);
      if (prevDagnyId) deps.push(prevDagnyId);
    }

    if (predecessor) {
      var shouldGet = !isSequential || index === 0;
      if (shouldGet && deps.indexOf(predecessor) === -1) {
        deps.push(predecessor);
      }
    }

    return deps;
  }

  function taskBelongsToMapping(
    ofTask: Task,
    mapping: ProjectMapping,
    target: OFTarget,
  ): boolean {
    if (target.type === "project") {
      return (
        ofTask.containingProject != null &&
        ofTask.containingProject.name === mapping.ofName
      );
    } else if (target.type === "folder") {
      if (!ofTask.containingProject) return false;
      const proj = ofTask.containingProject;
      let folder = proj.parentFolder;
      while (folder) {
        if (folder.name === mapping.ofName) return true;
        folder = folder.parent;
      }
      return false;
    } else {
      return true;
    }
  }

  function resolveAssignee(
    ofTask: Task,
    existingDagnyTask: DagnyTaskWithId | null,
    lib: any,
    usernameToId: Map<string, string>,
    myUserId: string,
  ): string | null | undefined {
    const waitingOnTags = ofTask.tags.filter(
      (t: Tag) => lib.isWaitingOnTag(t) && usernameToId.has(t.name),
    );
    if (waitingOnTags.length > 0) {
      return usernameToId.get(waitingOnTags[0].name)!;
    }
    if (existingDagnyTask && existingDagnyTask.assigneeId === myUserId) {
      return undefined;
    }
    return null;
  }

  function buildPatchFromOFTask(
    ofTask: Task,
    existingDagnyTask: DagnyTaskWithId | null,
    projStatusMap: ProjectStatusMapping | undefined,
    lib: any,
    usernameToId: Map<string, string>,
    myUserId: string,
    estimateMultiplier: number,
    mapping: ProjectMapping,
  ): DagnyTaskUpdate {
    const patch: DagnyTaskUpdate = {};

    patch.title = ofTask.name;
    patch.description = lib.stripDagnyLinkLine(ofTask.note || "");

    const dagnyStatusId: string | null = lib.dagnyStatusFromOFTask(
      ofTask,
      projStatusMap,
    );
    if (dagnyStatusId) {
      patch.statusId = dagnyStatusId;
    }

    patch.tags = collectDagnyTags(
      ofTask,
      lib,
      usernameToId,
      mapping.tagPrefix || null,
    );

    if (ofTask.estimatedMinutes != null) {
      patch.estimate = Math.round(ofTask.estimatedMinutes / estimateMultiplier);
    }

    if (ofTask.flagged) {
      var curVal = existingDagnyTask ? existingDagnyTask.value : null;
      var curEff = existingDagnyTask ? existingDagnyTask.effectiveValue : null;
      var hasValue =
        (curVal != null && curVal > 0) || (curEff != null && curEff > 0);
      if (!hasValue) {
        patch.value = 1;
      }
    } else {
      patch.value = null;
    }

    const assignee = resolveAssignee(
      ofTask,
      existingDagnyTask,
      lib,
      usernameToId,
      myUserId,
    );
    if (assignee !== undefined) {
      patch.assigneeId = assignee;
    }

    return patch;
  }

  function buildDagnyTaskFromOF(
    ofTask: Task,
    projStatusMap: ProjectStatusMapping | undefined,
    lib: any,
    usernameToId: Map<string, string>,
    myUserId: string,
    estimateMultiplier: number,
    mapping: ProjectMapping,
  ): DagnyTaskCreate {
    const dagnyTask: DagnyTaskCreate = {
      title: ofTask.name,
      description: lib.stripDagnyLinkLine(ofTask.note || ""),
      dependsOn: [],
      tags: collectDagnyTags(
        ofTask,
        lib,
        usernameToId,
        mapping.tagPrefix || null,
      ),
      estimate: Math.round((ofTask.estimatedMinutes || 1) / estimateMultiplier),
      value: ofTask.flagged ? 1 : null,
    };

    const dagnyStatusId: string | null = lib.dagnyStatusFromOFTask(
      ofTask,
      projStatusMap,
    );
    if (dagnyStatusId) {
      dagnyTask.statusId = dagnyStatusId;
    }

    if (mapping.teamUserId && mapping.newTaskAssignment === "user") {
      dagnyTask.assigneeId = mapping.teamUserId;
    } else if (
      mapping.teamUserId &&
      mapping.newTaskAssignment === "unassigned"
    ) {
      // Leave assigneeId unset (null)
    } else {
      const assignee = resolveAssignee(
        ofTask,
        null,
        lib,
        usernameToId,
        myUserId,
      );
      if (assignee !== undefined && assignee !== null) {
        dagnyTask.assigneeId = assignee;
      }
    }

    return dagnyTask;
  }

  function collectDagnyTags(
    ofTask: Task,
    lib: any,
    usernameToId: Map<string, string>,
    tagPrefix: string | null,
  ): string[] {
    const dagnyTags: string[] = [];
    for (const tag of ofTask.tags) {
      if (lib.isStatusTag(tag)) continue;
      if (lib.isWaitingOnTag(tag) && usernameToId.has(tag.name)) continue;
      var dagnyStr = lib.ofTagToDagnyString(tag);
      if (tagPrefix && dagnyStr.startsWith(tagPrefix + ":")) {
        dagnyStr = dagnyStr.substring(tagPrefix.length + 1);
      }
      dagnyTags.push(dagnyStr);
    }
    return dagnyTags;
  }

  async function syncProjectTasks(
    mapping: ProjectMapping,
    ofProjectChildren: Map<string, string[]>,
    ofProjectSequential: Map<string, boolean>,
    ofProjectMarkerIds: Map<string, string>,
    dagnyIndex: Map<string, DagnyTaskWithId>,
    projStatusMap: ProjectStatusMapping | undefined,
    lib: any,
  ): Promise<Map<string, string>> {
    const projectDagnyIds = new Map<string, string>();
    for (const [projName, childIds] of ofProjectChildren) {
      const isSequential = ofProjectSequential.get(projName) || false;

      const deps =
        isSequential && childIds.length > 0
          ? [childIds[childIds.length - 1]]
          : childIds;

      // Find existing container task: first by marker, then by name.
      let existingProjectTask: DagnyTaskWithId | null = null;
      const markerTaskId = ofProjectMarkerIds.get(projName);
      if (markerTaskId) {
        existingProjectTask = dagnyIndex.get(markerTaskId) || null;
      }
      if (!existingProjectTask) {
        for (const [id, dt] of dagnyIndex) {
          if (dt.title === projName) {
            existingProjectTask = dt;
            break;
          }
        }
      }

      if (existingProjectTask) {
        await lib.updateTask(
          mapping.dagnyProjectId,
          existingProjectTask.taskId,
          { dependsOn: deps },
        );
        projectDagnyIds.set(projName, existingProjectTask.taskId);
      } else {
        const defaultStatus: StatusMappingEntry | undefined = projStatusMap
          ? projStatusMap.mappings.find(
              (m: StatusMappingEntry) => m.ofAction === "active" && m.isDefault,
            )
          : undefined;

        const projectTask: DagnyTaskCreate = {
          title: projName,
          description: "",
          dependsOn: deps,
          tags: [],
          estimate: 1,
        };
        if (defaultStatus) {
          projectTask.statusId = defaultStatus.dagnyStatusId;
        }
        var newId = await lib.createTask(mapping.dagnyProjectId, projectTask);
        var taskId: string =
          typeof newId === "string" ? newId : (newId as any).taskId || newId;
        projectDagnyIds.set(projName, taskId);
      }
    }
    return projectDagnyIds;
  }

  async function syncFolderTasks(
    mapping: ProjectMapping,
    folders: Folder[],
    projectDagnyIds: Map<string, string>,
    dagnyIndex: Map<string, DagnyTaskWithId>,
    projStatusMap: ProjectStatusMapping | undefined,
    lib: any,
  ): Promise<void> {
    function folderDepth(f: Folder): number {
      var d = 0;
      var p = f.parent;
      while (p) {
        d++;
        p = p.parent;
      }
      return d;
    }

    const sorted = folders.slice().sort(function (a: Folder, b: Folder) {
      return folderDepth(b) - folderDepth(a);
    });

    const folderDagnyIds = new Map<string, string>();

    for (const folder of sorted) {
      const deps: string[] = [];

      for (const proj of folder.projects) {
        var projId = projectDagnyIds.get(proj.name);
        if (projId) deps.push(projId);
      }
      for (const child of folder.folders) {
        var folderId = folderDagnyIds.get(child.name);
        if (folderId) deps.push(folderId);
      }

      if (deps.length === 0) continue;

      let existingFolderTask: DagnyTaskWithId | null = null;
      for (const [id, dt] of dagnyIndex) {
        if (dt.title === folder.name) {
          existingFolderTask = dt;
          break;
        }
      }

      if (existingFolderTask) {
        await lib.updateTask(
          mapping.dagnyProjectId,
          existingFolderTask.taskId,
          { dependsOn: deps },
        );
        folderDagnyIds.set(folder.name, existingFolderTask.taskId);
      } else {
        const defaultStatus: StatusMappingEntry | undefined = projStatusMap
          ? projStatusMap.mappings.find(
              (m: StatusMappingEntry) => m.ofAction === "active" && m.isDefault,
            )
          : undefined;

        const folderTask: DagnyTaskCreate = {
          title: folder.name,
          description: "",
          dependsOn: deps,
          tags: [],
          estimate: 1,
        };
        if (defaultStatus) {
          folderTask.statusId = defaultStatus.dagnyStatusId;
        }
        var newId = await lib.createTask(mapping.dagnyProjectId, folderTask);
        var taskId: string =
          typeof newId === "string" ? newId : (newId as any).taskId || newId;
        folderDagnyIds.set(folder.name, taskId);
      }
    }
  }

  action.validate = function (selection: any, sender: any): boolean {
    return true;
  };

  return action;
})();
