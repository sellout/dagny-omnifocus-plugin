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
              );
              if (patch) {
                await lib.updateTask(
                  mapping.dagnyProjectId,
                  marker.taskId,
                  patch,
                );
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
            );

            dagnyTask.dependsOn = computeDependencies(
              ofTask,
              i,
              siblings,
              isSequential,
              predecessor,
              ofToDagnyId,
            );

            var newId = await lib.createTask(mapping.dagnyProjectId, dagnyTask);
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
          }
        }

        if (target.type === "project" && target.container) {
          await processProject(target.container);
        } else if (target.type === "folder" && target.folder) {
          for (var proj of target.folder.flattenedProjects) {
            await processProject(proj);
          }
        } else {
          for (var proj of flattenedProjects as Project[]) {
            await processProject(proj);
          }
          var inboxTasks: Task[] = inbox ? inbox.tasks || [] : [];
          if (inboxTasks.length > 0) {
            await processSiblings(inboxTasks, false, null);
          }
        }

        if (
          (target.type === "folder" || target.type === "everything") &&
          ofProjectChildren.size > 0
        ) {
          await syncProjectTasks(
            mapping,
            ofProjectChildren,
            ofProjectSequential,
            dagnyIndex,
            projStatusMap,
            lib,
          );
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
      await summary.show();
    } catch (err: any) {
      const errAlert = new Alert("Push Error", err.message);
      await errAlert.show();
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
  ): DagnyTaskUpdate {
    const patch: DagnyTaskUpdate = {};

    patch.title = ofTask.name;
    patch.description = ofTask.note || "";

    const dagnyStatusId: string | null = lib.dagnyStatusFromOFTask(
      ofTask,
      projStatusMap,
    );
    if (dagnyStatusId) {
      patch.statusId = dagnyStatusId;
    }

    patch.tags = collectDagnyTags(ofTask, lib, usernameToId);

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
  ): DagnyTaskCreate {
    const dagnyTask: DagnyTaskCreate = {
      title: ofTask.name,
      description: ofTask.note || "",
      dependsOn: [],
      tags: collectDagnyTags(ofTask, lib, usernameToId),
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

    const assignee = resolveAssignee(ofTask, null, lib, usernameToId, myUserId);
    if (assignee !== undefined && assignee !== null) {
      dagnyTask.assigneeId = assignee;
    }

    return dagnyTask;
  }

  function collectDagnyTags(
    ofTask: Task,
    lib: any,
    usernameToId: Map<string, string>,
  ): string[] {
    const dagnyTags: string[] = [];
    for (const tag of ofTask.tags) {
      if (lib.isStatusTag(tag)) continue;
      if (lib.isWaitingOnTag(tag) && usernameToId.has(tag.name)) continue;
      dagnyTags.push(lib.ofTagToDagnyString(tag));
    }
    return dagnyTags;
  }

  async function syncProjectTasks(
    mapping: ProjectMapping,
    ofProjectChildren: Map<string, string[]>,
    ofProjectSequential: Map<string, boolean>,
    dagnyIndex: Map<string, DagnyTaskWithId>,
    projStatusMap: ProjectStatusMapping | undefined,
    lib: any,
  ): Promise<void> {
    for (const [projName, childIds] of ofProjectChildren) {
      const dagnyTitle = "[OF Project] " + projName;
      const isSequential = ofProjectSequential.get(projName) || false;

      const deps =
        isSequential && childIds.length > 0
          ? [childIds[childIds.length - 1]]
          : childIds;

      let existingProjectTask: DagnyTaskWithId | null = null;
      for (const [id, dt] of dagnyIndex) {
        if (dt.title === dagnyTitle) {
          existingProjectTask = dt;
          break;
        }
      }

      if (existingProjectTask) {
        await lib.updateTask(
          mapping.dagnyProjectId,
          existingProjectTask.taskId,
          { dependsOn: deps },
        );
      } else {
        const defaultStatus: StatusMappingEntry | undefined = projStatusMap
          ? projStatusMap.mappings.find(
              (m: StatusMappingEntry) => m.ofAction === "active" && m.isDefault,
            )
          : undefined;

        const projectTask: DagnyTaskCreate = {
          title: dagnyTitle,
          description: "Represents OmniFocus project: " + projName,
          dependsOn: deps,
          tags: [],
          estimate: 1,
        };
        if (defaultStatus) {
          projectTask.statusId = defaultStatus.dagnyStatusId;
        }
        await lib.createTask(mapping.dagnyProjectId, projectTask);
      }
    }
  }

  action.validate = function (selection: any, sender: any): boolean {
    return true;
  };

  return action;
})();
