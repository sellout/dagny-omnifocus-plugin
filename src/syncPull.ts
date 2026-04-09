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
    taskCategories: Map<string, TaskCategory> | null,
  ): void {
    for (var i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const dt = dagnyTaskMap.get(node.dagnyTaskId);
      if (!dt) continue;

      var ofTask: Task | undefined = existingIndex.get(dt.taskId);
      const isNew = !ofTask;

      if (isNew) {
        ofTask = new Task(dt.title, parentPosition);
        lib.setDagnyMarker(ofTask, mapping.dagnyProjectId, dt.taskId);
        counters.created++;
      } else {
        moveTasks([ofTask!], parentPosition);
        counters.updated++;
      }

      const category = taskCategories
        ? taskCategories.get(node.dagnyTaskId) || null
        : null;

      updateTaskFields(
        ofTask!,
        dt,
        mapping,
        projStatusMap,
        memberMap,
        myUserId,
        lib,
        category,
      );

      if (node.children.length > 0) {
        ofTask!.sequential = node.sequential;
        if (category === "blocked") {
          ofTask!.completedByChildren = true;
        }
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
          taskCategories,
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
    taskCategory: TaskCategory | null,
  ): void {
    ofTask.name = dt.title;
    ofTask.note = dt.description || "";

    // Ensure attachment marker is up to date
    lib.setDagnyMarker(ofTask, mapping.dagnyProjectId, dt.taskId);

    if (dt.estimate != null) {
      const mult = mapping.estimateMultiplier || 1;
      ofTask.estimatedMinutes = dt.estimate * mult;
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

    if (taskCategory === "blocker") {
      // Tag blockers with waiting on:<assignee>
      if (dt.assigneeId) {
        const assigneeName = memberMap.get(dt.assigneeId);
        if (assigneeName) {
          ofTask.addTag(lib.ensureWaitingOnTag(assigneeName));
        }
      } else {
        // Unassigned: use the parent "waiting on" tag directly
        ofTask.addTag(lib.ensureTagHierarchy("waiting on"));
      }
    } else if (taskCategory === null) {
      // No team filtering: existing behavior
      if (dt.assigneeId && dt.assigneeId !== myUserId) {
        const assigneeName = memberMap.get(dt.assigneeId);
        if (assigneeName) {
          ofTask.addTag(lib.ensureWaitingOnTag(assigneeName));
        }
      }
    }
    // taskCategory === "mine": no waiting-on tag
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

        // ---- Team filtering ----
        var activeTasks = dagnyTasks;
        var taskCategories: Map<string, TaskCategory> | null = null;
        var noFlattenIds: Set<string> | undefined = undefined;

        if (mapping.teamUserId) {
          const result = filterTasksForTeam(
            dagnyTasks,
            mapping.teamUserId,
            mapping.includeUnassigned !== false,
          );
          activeTasks = result.filteredTasks;
          taskCategories = result.categories;
          noFlattenIds = new Set<string>();
          for (const [id, cat] of result.categories) {
            if (cat === "blocked") {
              noFlattenIds.add(id);
            }
          }
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
        for (const dt of activeTasks) {
          dagnyTaskMap.set(dt.taskId, dt);
        }

        // Build set of container task IDs to exclude from the tree.
        // Projects: identified by Dagny markers on OF project .task.
        // Folders: matched by name against OF folders.
        const containerIds = new Set<string>();
        const containerProjectMap = new Map<string, string>();
        const containerFolderMap = new Map<string, string>();
        var ofFolders: Folder[] = [];

        if (target.type !== "project") {
          const ofProjects: Project[] =
            target.type === "folder" && target.folder
              ? target.folder.flattenedProjects
              : (flattenedProjects as Project[]);
          for (const proj of ofProjects) {
            const marker: DagnyMarker | null = lib.getDagnyMarker(proj.task);
            if (marker && lib.markerMatchesProject(marker, mapping)) {
              containerIds.add(marker.taskId);
              containerProjectMap.set(marker.taskId, proj.name);
            }
          }

          ofFolders =
            target.type === "folder" && target.folder
              ? (target.folder.flattenedFolders as Folder[])
              : (flattenedFolders as Folder[]);
          for (const folder of ofFolders) {
            for (const dt of activeTasks) {
              if (dt.title === folder.name && !containerIds.has(dt.taskId)) {
                containerIds.add(dt.taskId);
                containerFolderMap.set(dt.taskId, folder.name);
              }
            }
          }

          // Also detect legacy [OmniFocus:] description tags and
          // clean them up while adding to containerIds.
          for (const dt of activeTasks) {
            if (lib.isOFContainerTask(dt)) {
              containerIds.add(dt.taskId);
              if (lib.isOFProjectTask(dt)) {
                const projName = lib.getOFProjectName(dt);
                if (projName) {
                  containerProjectMap.set(dt.taskId, projName);
                }
              }
              // Remove legacy tag from Dagny.
              const cleanDesc = dt.description
                .replace(/\[OmniFocus:[^\]]*\]/, "")
                .trim();
              if (cleanDesc !== dt.description) {
                await lib.updateTask(mapping.dagnyProjectId, dt.taskId, {
                  description: cleanDesc,
                });
                dt.description = cleanDesc;
              }
            }
          }
        }

        const mode: DependencyMode = mapping.dependencyMode || "conservative";
        const containerSequential =
          target.type === "project" && target.container
            ? target.container.sequential
            : false;
        const tree = dagToTree(
          activeTasks,
          mode,
          containerSequential,
          containerIds,
          noFlattenIds,
        );

        if (target.type === "project") {
          if (target.container && tree.length > 1) {
            target.container.sequential = false;
          }

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
            taskCategories,
          );
        } else {
          // folder / everything: roots must go into OF projects.

          // Map dagnyTaskId → OF project name from container tasks.
          const rootToProject = new Map<string, string>();
          for (const dt of dagnyTasks) {
            const projName = containerProjectMap.get(dt.taskId);
            if (!projName) continue;
            for (const depId of dt.dependsOn) {
              rootToProject.set(depId, projName);
            }
          }

          // Group roots by their OF project name.
          const projectGroups = new Map<string, OFTreeNode[]>();
          const unclaimed: OFTreeNode[] = [];
          for (const root of tree) {
            const projName = rootToProject.get(root.dagnyTaskId);
            if (projName) {
              var group = projectGroups.get(projName);
              if (!group) {
                group = [];
                projectGroups.set(projName, group);
              }
              group.push(root);
            } else {
              unclaimed.push(root);
            }
          }

          // Map project name → parent folder name, by checking which
          // folder container task has the project container in its
          // dependsOn.
          const projectParentFolder = new Map<string, string>();
          for (const dt of dagnyTasks) {
            const folderName = containerFolderMap.get(dt.taskId);
            if (!folderName) continue;
            for (const depId of dt.dependsOn) {
              const projName = containerProjectMap.get(depId);
              if (projName) {
                projectParentFolder.set(projName, folderName);
              }
            }
          }

          // Default position for creating new projects.
          const defaultProjectPosition =
            target.type === "folder" && target.folder
              ? target.folder.ending
              : undefined;

          // Helper to find an existing OF project by name.
          function findOFProject(name: string): Project | null {
            const projects: Project[] =
              target.type === "folder" && target.folder
                ? target.folder.flattenedProjects
                : (flattenedProjects as Project[]);
            for (var p = 0; p < projects.length; p++) {
              if (projects[p].name === name) return projects[p];
            }
            return null;
          }

          // Helper to find an existing OF folder by name.
          function findOFFolder(name: string): Folder | null {
            for (var f = 0; f < ofFolders.length; f++) {
              if (ofFolders[f].name === name) return ofFolders[f];
            }
            return null;
          }

          // Position for creating a project, respecting folder nesting.
          function projectPosition(projName: string): any {
            const parentName = projectParentFolder.get(projName);
            if (parentName) {
              const parentFolder = findOFFolder(parentName);
              if (parentFolder) return parentFolder.ending;
            }
            return defaultProjectPosition;
          }

          // Apply claimed roots to their OF projects.
          for (const [projName, roots] of projectGroups) {
            var ofProj: Project =
              findOFProject(projName) ||
              new Project(projName, projectPosition(projName));
            if (roots.length > 1) {
              ofProj.sequential = false;
            }
            var flatRoots = flattenTree(roots, ofProj.sequential);
            applyTree(
              flatRoots,
              ofProj.ending,
              dagnyTaskMap,
              existingIndex,
              mapping,
              projStatusMap,
              memberMap,
              myUserId,
              lib,
              counters,
              taskCategories,
            );
          }

          // Create new OF projects for unclaimed roots.
          for (const root of unclaimed) {
            const dt = dagnyTaskMap.get(root.dagnyTaskId);
            if (!dt) continue;

            var ofProj: Project = new Project(
              dt.title,
              projectPosition(dt.title),
            );
            ofProj.sequential = root.sequential;
            lib.setDagnyMarker(ofProj.task, mapping.dagnyProjectId, dt.taskId);
            existingIndex.set(dt.taskId, ofProj.task);

            const rootCategory = taskCategories
              ? taskCategories.get(root.dagnyTaskId) || null
              : null;
            updateTaskFields(
              ofProj.task,
              dt,
              mapping,
              projStatusMap,
              memberMap,
              myUserId,
              lib,
              rootCategory,
            );
            counters.created++;

            if (root.children.length > 0) {
              var flatChildren = flattenTree(root.children, root.sequential);
              applyTree(
                flatChildren,
                ofProj.ending,
                dagnyTaskMap,
                existingIndex,
                mapping,
                projStatusMap,
                memberMap,
                myUserId,
                lib,
                counters,
                taskCategories,
              );
            }
          }
        }
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
