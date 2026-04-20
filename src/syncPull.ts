(() => {
  // DAG-to-tree functions (buildDag, transitiveReduction, dagToTree, etc.)
  // are defined in dagGraph.ts and available in the global scope when
  // compiled with module: "none".

  // ---- Extract OF-implied edges ----

  // For each linked OF task, infer dependency edges from its position
  // in the OF hierarchy.  Returns edges keyed by Dagny task IDs.
  function extractOFEdges(
    existingIndex: Map<string, Task>,
  ): Map<string, Set<string>> {
    const ofEdges = new Map<string, Set<string>>();

    // Reverse map: OF primaryKey → Dagny taskId (only for linked tasks)
    const ofToDagnyId = new Map<string, string>();
    for (const [dagnyId, ofTask] of existingIndex) {
      ofToDagnyId.set(ofTask.id.primaryKey, dagnyId);
    }

    function addEdge(fromDagnyId: string, toDagnyId: string): void {
      var deps = ofEdges.get(fromDagnyId);
      if (!deps) {
        deps = new Set<string>();
        ofEdges.set(fromDagnyId, deps);
      }
      deps.add(toDagnyId);
    }

    for (const [dagnyId, ofTask] of existingIndex) {
      // 1) Group → depends on children
      if (ofTask.hasChildren) {
        var children = ofTask.children;
        if (ofTask.sequential && children.length > 0) {
          var lastDagnyId = ofToDagnyId.get(
            children[children.length - 1].id.primaryKey,
          );
          if (lastDagnyId) addEdge(dagnyId, lastDagnyId);
        } else {
          for (var c = 0; c < children.length; c++) {
            var childDagnyId = ofToDagnyId.get(children[c].id.primaryKey);
            if (childDagnyId) addEdge(dagnyId, childDagnyId);
          }
        }
      }

      // 2) Sequential sibling → depends on previous sibling
      var parent = ofTask.parent;
      if (parent) {
        var siblings = parent.children;
        var isSequential = parent.sequential;
        if (isSequential) {
          for (var i = 1; i < siblings.length; i++) {
            if (siblings[i].id.primaryKey === ofTask.id.primaryKey) {
              var prevDagnyId = ofToDagnyId.get(
                siblings[i - 1].id.primaryKey,
              );
              if (prevDagnyId) addEdge(dagnyId, prevDagnyId);
              break;
            }
          }
        }
      }
    }

    return ofEdges;
  }

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
    githubLinksMap: Map<string, TaskGitHubLink[]>,
  ): void {
    for (var i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const dt = dagnyTaskMap.get(node.dagnyTaskId);
      if (!dt) continue;

      var ofTask: Task | undefined = existingIndex.get(dt.taskId);
      const isNew = !ofTask;

      if (isNew) {
        ofTask = new Task(dt.title, parentPosition);
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
        githubLinksMap,
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
          githubLinksMap,
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
    githubLinksMap: Map<string, TaskGitHubLink[]>,
  ): void {
    ofTask.name = dt.title;
    ofTask.note = dt.description || "";

    // Set Dagny link.
    const ghLinks = githubLinksMap.get(dt.taskId) || [];
    lib.setDagnyMarker(ofTask, mapping.dagnyProjectId, dt.taskId, ghLinks);

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
        var ofTag: Tag;
        if (mapping.tagPrefix) {
          if (mapping.forceTagPrefix) {
            ofTag = lib.ensureTagHierarchy(
              mapping.tagPrefix + ":" + dagnyTagStr,
            );
          } else {
            // Use unprefixed if it already exists, otherwise create prefixed
            const unprefixed: Tag | null = flattenedTags.byName(
              dagnyTagStr.split(":")[0].trim(),
            );
            if (unprefixed) {
              ofTag = lib.ensureTagHierarchy(dagnyTagStr);
            } else {
              ofTag = lib.ensureTagHierarchy(
                mapping.tagPrefix + ":" + dagnyTagStr,
              );
            }
          }
        } else {
          ofTag = lib.ensureTagHierarchy(dagnyTagStr);
        }
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
        await alert.show(null);
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

        // Title-based fallback: match unlinked OF tasks by title,
        // only if no other OF task already claims that Dagny task ID.
        const claimedIds = new Set<string>(existingIndex.keys());
        for (const ofTask of tasksToScan) {
          if (lib.getDagnyMarker(ofTask)) continue;
          for (const dt of activeTasks) {
            if (claimedIds.has(dt.taskId)) continue;
            if (ofTask.name === dt.title) {
              existingIndex.set(dt.taskId, ofTask);
              claimedIds.add(dt.taskId);
              break;
            }
          }
        }

        const dagnyTaskMap = new Map<string, DagnyTaskWithId>();
        for (const dt of activeTasks) {
          dagnyTaskMap.set(dt.taskId, dt);
        }

        // Batch-fetch GitHub links for all active tasks.
        const githubLinksMap = new Map<string, TaskGitHubLink[]>();
        for (const dt of activeTasks) {
          try {
            const links: TaskGitHubLink[] = await lib.getTaskGitHubLinks(
              mapping.dagnyProjectId,
              dt.taskId,
            );
            if (links && links.length > 0) {
              githubLinksMap.set(dt.taskId, links);
            }
          } catch (e) {
            // Non-fatal: skip GitHub links for this task.
          }
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
              // Ensure Dagny link is up to date on the project task.
              const ghLinks = githubLinksMap.get(marker.taskId) || [];
              lib.setDagnyMarker(
                proj.task,
                mapping.dagnyProjectId,
                marker.taskId,
                ghLinks,
              );
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
        }

        // Status-based folder detection: tasks whose Dagny status maps
        // to "folder" are treated as OF folders.
        if (projStatusMap) {
          for (const dt of activeTasks) {
            if (containerIds.has(dt.taskId)) continue;
            if (!dt.statusId) continue;
            const entry = projStatusMap.mappings.find(
              (m: StatusMappingEntry) => m.dagnyStatusId === dt.statusId,
            );
            if (entry && entry.ofAction === "folder") {
              containerIds.add(dt.taskId);
              containerFolderMap.set(dt.taskId, dt.title);
            }
          }
        }

        const mode: DependencyMode = mapping.dependencyMode || "conservative";
        const containerSequential =
          target.type === "project" && target.container
            ? target.container.sequential
            : false;

        // Build combined labeled graph: Dagny edges + OF-implied edges.
        const ofEdges = extractOFEdges(existingIndex);
        const labeledDag = buildLabeledDag(
          activeTasks,
          ofEdges,
          containerIds,
        );
        const tree = dagToTree(
          activeTasks,
          mode,
          containerSequential,
          containerIds,
          noFlattenIds,
          labeledDag.dependsOn,
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
            githubLinksMap,
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

          // Map project/root name → parent folder name, and
          // child folder name → parent folder name.
          // A folder container's dependsOn may reference a project
          // container, another folder container, or a regular task
          // that will become an unclaimed root project.
          const projectParentFolder = new Map<string, string>();
          const folderParentFolder = new Map<string, string>();
          for (const dt of dagnyTasks) {
            const folderName = containerFolderMap.get(dt.taskId);
            if (!folderName) continue;
            for (const depId of dt.dependsOn) {
              const projName = containerProjectMap.get(depId);
              if (projName) {
                projectParentFolder.set(projName, folderName);
              } else {
                const childFolderName = containerFolderMap.get(depId);
                if (childFolderName) {
                  folderParentFolder.set(childFolderName, folderName);
                } else {
                  // depId is a regular task that will become a root
                  // project — use its title as the project name.
                  const depTask = dagnyTaskMap.get(depId);
                  if (depTask) {
                    projectParentFolder.set(depTask.title, folderName);
                  }
                }
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

          // Ensure an OF folder exists for a given name, creating it
          // if necessary (e.g. for status-based folder containers).
          function ensureOFFolder(name: string): Folder {
            var existing = findOFFolder(name);
            if (existing) return existing;
            var parentName = folderParentFolder.get(name);
            var position: Folder.ChildInsertionLocation | null = parentName
              ? ensureOFFolder(parentName).ending
              : defaultProjectPosition || null;
            var newFolder = new Folder(name, position);
            ofFolders.push(newFolder);
            return newFolder;
          }

          // Position for creating a project, respecting folder nesting.
          function projectPosition(projName: string): any {
            const parentName = projectParentFolder.get(projName);
            if (parentName) {
              return ensureOFFolder(parentName).ending;
            }
            return defaultProjectPosition;
          }

          // Apply claimed roots to their OF projects.
          for (const [projName, roots] of projectGroups) {
            var ofProj: Project =
              findOFProject(projName) ||
              new Project(projName, projectPosition(projName));
            // Move existing project into its designated folder if needed.
            const parentFolderName = projectParentFolder.get(projName);
            if (parentFolderName) {
              const parentFolder = ensureOFFolder(parentFolderName);
              if (ofProj.parentFolder !== parentFolder) {
                moveSections([ofProj], parentFolder.ending);
              }
            }
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
              githubLinksMap,
            );
          }

          // Create new OF projects for unclaimed roots, or update
          // existing tasks that were already matched by marker/title.
          for (const root of unclaimed) {
            const dt = dagnyTaskMap.get(root.dagnyTaskId);
            if (!dt) continue;

            const rootCategory = taskCategories
              ? taskCategories.get(root.dagnyTaskId) || null
              : null;

            var existingTask = existingIndex.get(dt.taskId);
            if (existingTask) {
              // Already matched (e.g. user moved a project inside
              // another project, converting it to a task) — update
              // in place without creating a new project.
              updateTaskFields(
                existingTask,
                dt,
                mapping,
                projStatusMap,
                memberMap,
                myUserId,
                lib,
                rootCategory,
                githubLinksMap,
              );
              counters.updated++;

              if (root.children.length > 0) {
                existingTask.sequential = root.sequential;
                var flatChildren = flattenTree(
                  root.children,
                  root.sequential,
                );
                applyTree(
                  flatChildren,
                  existingTask.ending,
                  dagnyTaskMap,
                  existingIndex,
                  mapping,
                  projStatusMap,
                  memberMap,
                  myUserId,
                  lib,
                  counters,
                  taskCategories,
                  githubLinksMap,
                );
              }
              continue;
            }

            var ofProj: Project = new Project(
              dt.title,
              projectPosition(dt.title),
            );
            ofProj.sequential = root.sequential;
            existingIndex.set(dt.taskId, ofProj.task);

            updateTaskFields(
              ofProj.task,
              dt,
              mapping,
              projStatusMap,
              memberMap,
              myUserId,
              lib,
              rootCategory,
              githubLinksMap,
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
                githubLinksMap,
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
      await summary.show(null);
    } catch (err: any) {
      const errAlert = new Alert("Pull Error", err.message);
      await errAlert.show(null);
    }
  });

  action.validate = function (selection: any, sender: any): boolean {
    return true;
  };

  return action;
})();
