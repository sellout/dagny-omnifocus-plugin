(() => {
    const action = new PlugIn.Action(async function (selection, sender) {
        const lib = this.plugIn.library("dagnyLib");

        try {
            const mappings = lib.getProjectMappings();
            if (!mappings || mappings.length === 0) {
                const alert = new Alert(
                    "Not Configured",
                    "No project mappings found. Run Configure first."
                );
                await alert.show();
                return;
            }

            await lib.login();

            let totalCreated = 0;
            let totalUpdated = 0;

            // Fetch current user once for assignee logic
            const me = await lib.getMe();
            const myUserId = me.userId;

            for (const mapping of mappings) {
                const projStatusMap = lib.getProjectStatusMap(
                    mapping.dagnyProjectId
                );
                const target = lib.resolveOFTarget(mapping);

                // Build username -> userId map from project members
                const members = await lib.getProjectMembers(mapping.dagnyProjectId);
                const usernameToId = new Map();
                for (const m of members) {
                    usernameToId.set(m.username, m.userId);
                }

                // Fetch existing Dagny tasks to build a reverse index
                const dagnyTasks = await lib.getTasks(mapping.dagnyProjectId);
                const dagnyIndex = new Map();
                for (const dt of dagnyTasks) {
                    dagnyIndex.set(dt.taskId, dt);
                }

                // Collect all OF tasks to push
                const tasksToScan =
                    target.type === "everything"
                        ? flattenedTasks
                        : target.tasks;

                // For folder/everything modes, track OF projects and their
                // child Dagny task IDs so we can create project-level tasks
                const ofProjectChildren = new Map(); // ofProjectName -> [dagnyTaskId]
                const ofProjectSequential = new Map(); // ofProjectName -> boolean

                // Map OF task primaryKey -> Dagny taskId for dependency
                // resolution. Pre-populate from existing synced tasks.
                const ofToDagnyId = new Map();
                for (const ofTask of tasksToScan) {
                    const m = lib.getDagnyMarker(ofTask);
                    if (m && lib.markerMatchesProject(m, mapping)) {
                        ofToDagnyId.set(ofTask.id.primaryKey, m.taskId);
                    }
                }

                // Process a list of sibling tasks. For each task:
                //   - If it already has a marker, update it
                //   - If it's new and has children (group), process children
                //     first so the group can reference their Dagny IDs
                //   - Compute dependencies based on sequential/parallel context
                // predecessor: Dagny ID that should be inherited by
                // children of groups at this level (propagated from
                // an ancestor's sequential context). null if none.
                async function processSiblings(siblings, isSequential, predecessor) {
                    for (var i = 0; i < siblings.length; i++) {
                        var ofTask = siblings[i];
                        var marker = lib.getDagnyMarker(ofTask);

                        // Compute the predecessor for this task's children:
                        // In a sequential context, the predecessor for a
                        // group's children is the previous sibling.
                        // In a parallel context, all children inherit the
                        // same predecessor passed from above.
                        var childPredecessor = null;
                        if (isSequential && i > 0) {
                            childPredecessor = ofToDagnyId.get(
                                siblings[i - 1].id.primaryKey
                            ) || null;
                        } else if (!isSequential) {
                            childPredecessor = predecessor;
                        }

                        if (marker && lib.markerMatchesProject(marker, mapping)) {
                            // Existing synced task: push updates
                            var existingDagnyTask = dagnyIndex.get(marker.taskId);
                            var patch = buildPatchFromOFTask(
                                ofTask, existingDagnyTask, projStatusMap,
                                lib, usernameToId, myUserId
                            );
                            if (patch) {
                                await lib.updateTask(
                                    mapping.dagnyProjectId,
                                    marker.taskId, patch
                                );
                                totalUpdated++;
                            }
                            // Recurse into children so new children get processed
                            if (ofTask.hasChildren) {
                                var groupPred = ofTask.sequential
                                    ? childPredecessor  // first child gets it
                                    : childPredecessor; // all children get it
                                await processSiblings(
                                    ofTask.children, ofTask.sequential, groupPred
                                );
                            }
                            continue;
                        }

                        if (marker) continue; // belongs to a different project

                        // New task: skip if not in this mapping
                        if (!taskBelongsToMapping(ofTask, mapping, target)) {
                            continue;
                        }

                        // If this task has children, process them first
                        if (ofTask.hasChildren) {
                            var groupPred = ofTask.sequential
                                ? childPredecessor  // first child gets it
                                : childPredecessor; // all children get it
                            await processSiblings(
                                ofTask.children, ofTask.sequential, groupPred
                            );
                        }

                        // Build the Dagny task
                        var dagnyTask = buildDagnyTaskFromOF(
                            ofTask, projStatusMap, lib, usernameToId, myUserId
                        );

                        // Compute dependencies
                        dagnyTask.dependsOn = computeDependencies(
                            ofTask, i, siblings, isSequential,
                            predecessor, ofToDagnyId
                        );

                        var newId = await lib.createTask(
                            mapping.dagnyProjectId, dagnyTask
                        );
                        var taskId = typeof newId === "string"
                            ? newId : newId.taskId || newId;
                        lib.setDagnyMarker(
                            ofTask, mapping.dagnyProjectName, taskId
                        );
                        ofToDagnyId.set(ofTask.id.primaryKey, taskId);
                        totalCreated++;

                        // Update reverse dependencies: add this new task
                        // to the dependsOn of its container or successor
                        await updateReverseDeps(
                            ofTask, taskId, i, siblings, isSequential
                        );
                    }
                }

                // After creating a new task, update existing Dagny tasks
                // that should now depend on it:
                //   - Parallel container: add to container's dependsOn
                //   - Last in sequential container: add to container's dependsOn
                //   - Not last in sequential: add to next sibling's dependsOn
                // Only patches tasks that already exist in Dagny (new tasks
                // get correct deps via computeDependencies).
                async function updateReverseDeps(
                    ofTask, newDagnyId, index, siblings, isSequential
                ) {
                    if (isSequential) {
                        var isLast = (index === siblings.length - 1);
                        if (!isLast) {
                            // Add to next sibling's dependsOn
                            var nextSibling = siblings[index + 1];
                            await addToDependsOn(nextSibling, newDagnyId);
                        } else {
                            // Last in sequential: add to container's dependsOn
                            await addToContainerDepsOn(ofTask, newDagnyId);
                        }
                    } else {
                        // Parallel: add to container's dependsOn
                        await addToContainerDepsOn(ofTask, newDagnyId);
                    }
                }

                // Add newDepId to an existing Dagny task's dependsOn
                async function addToDependsOn(ofTask, newDepId) {
                    var marker = lib.getDagnyMarker(ofTask);
                    if (!marker || !lib.markerMatchesProject(marker, mapping)) {
                        return; // not yet in Dagny; will get correct deps when created
                    }
                    var existing = dagnyIndex.get(marker.taskId);
                    var currentDeps = existing && existing.dependsOn
                        ? existing.dependsOn.slice()
                        : [];
                    if (currentDeps.indexOf(newDepId) === -1) {
                        currentDeps.push(newDepId);
                        await lib.updateTask(
                            mapping.dagnyProjectId,
                            marker.taskId,
                            { dependsOn: currentDeps }
                        );
                        // Update local index so subsequent updates are correct
                        if (existing) existing.dependsOn = currentDeps;
                    }
                }

                // Add newDepId to the container (parent task or project) in Dagny
                async function addToContainerDepsOn(ofTask, newDepId) {
                    var parentTask = ofTask.parent;
                    if (parentTask) {
                        // Parent is a task group
                        await addToDependsOn(parentTask, newDepId);
                    }
                    // Project-level containers are handled by processProject/syncProjectTasks
                }

                // Process a project's tasks and track its top-level
                // children for the [OF Project] dependency task.
                async function processProject(proj) {
                    var kids = proj.task.children;
                    await processSiblings(kids, proj.sequential, null);

                    if (target.type === "folder" || target.type === "everything") {
                        var childDagnyIds = [];
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

                // Determine root siblings to process
                if (target.type === "project" && target.container) {
                    await processProject(target.container);
                } else if (target.type === "folder" && target.folder) {
                    for (var proj of target.folder.flattenedProjects) {
                        await processProject(proj);
                    }
                } else {
                    for (var proj of flattenedProjects) {
                        await processProject(proj);
                    }
                    var inboxTasks = inbox ? (inbox.tasks || []) : [];
                    if (inboxTasks.length > 0) {
                        await processSiblings(inboxTasks, false, null);
                    }
                }

                // For folder/everything modes: create/update Dagny tasks
                // representing OF projects with depends_on edges
                if (
                    (target.type === "folder" ||
                        target.type === "everything") &&
                    ofProjectChildren.size > 0
                ) {
                    await syncProjectTasks(
                        mapping,
                        ofProjectChildren,
                        ofProjectSequential,
                        dagnyIndex,
                        projStatusMap,
                        lib
                    );
                }
            }

            const summary = new Alert(
                "Push Complete",
                "Created " +
                    totalCreated +
                    " task(s), updated " +
                    totalUpdated +
                    " task(s) in Dagny."
            );
            await summary.show();
        } catch (err) {
            const errAlert = new Alert("Push Error", err.message);
            await errAlert.show();
        }
    });

    // Compute Dagny dependsOn for a new OF task.
    //
    // predecessor: Dagny ID inherited from an ancestor's sequential
    //   context, propagated through processSiblings. Handles arbitrary
    //   nesting depth.
    //
    // Groups (hasChildren):
    //   - Parallel group: depends on ALL children
    //   - Sequential group: depends on LAST child only
    //   - Groups do NOT depend on their predecessor; it's propagated
    //     to children via processSiblings.
    //
    // Leaf tasks:
    //   - In sequential context: depend on previous sibling
    //   - Inherit predecessor from ancestor if applicable:
    //     * Parallel parent: ALL children get it
    //     * Sequential parent: only FIRST child gets it
    function computeDependencies(ofTask, index, siblings, isSequential, predecessor, ofToDagnyId) {
        var deps = [];

        if (ofTask.hasChildren) {
            // Group: depend on children (already created)
            var children = ofTask.children;
            if (ofTask.sequential && children.length > 0) {
                var lastDagnyId = ofToDagnyId.get(
                    children[children.length - 1].id.primaryKey
                );
                if (lastDagnyId) deps.push(lastDagnyId);
            } else {
                for (var c = 0; c < children.length; c++) {
                    var childDagnyId = ofToDagnyId.get(
                        children[c].id.primaryKey
                    );
                    if (childDagnyId) deps.push(childDagnyId);
                }
            }
            return deps;
        }

        // Leaf task in sequential context: depend on previous sibling
        if (isSequential && index > 0) {
            var prevDagnyId = ofToDagnyId.get(
                siblings[index - 1].id.primaryKey
            );
            if (prevDagnyId) deps.push(prevDagnyId);
        }

        // Inherit predecessor from ancestor (propagated through processSiblings).
        // In a sequential context: only the first child gets it
        // In a parallel context: all children get it
        if (predecessor) {
            var shouldGet = !isSequential || index === 0;
            if (shouldGet && deps.indexOf(predecessor) === -1) {
                deps.push(predecessor);
            }
        }

        return deps;
    }

    // Check if an OF task belongs to the given mapping's container
    function taskBelongsToMapping(ofTask, mapping, target) {
        if (target.type === "project") {
            return (
                ofTask.containingProject &&
                ofTask.containingProject.name === mapping.ofName
            );
        } else if (target.type === "folder") {
            if (!ofTask.containingProject) return false;
            const proj = ofTask.containingProject;
            // Check if the project is inside the mapped folder
            let folder = proj.parentFolder;
            while (folder) {
                if (folder.name === mapping.ofName) return true;
                folder = folder.parent;
            }
            return false;
        } else {
            // "everything" — all tasks belong
            return true;
        }
    }

    // Resolve assigneeId from OF task's "waiting on" tags.
    // Returns a userId to set, null to clear, or undefined to leave unchanged.
    function resolveAssignee(ofTask, existingDagnyTask, lib, usernameToId, myUserId) {
        // Only consider waiting-on tags that match a project member
        const waitingOnTags = ofTask.tags.filter(function (t) {
            return lib.isWaitingOnTag(t) && usernameToId.has(t.name);
        });
        if (waitingOnTags.length > 0) {
            return usernameToId.get(waitingOnTags[0].name);
        }
        // No waiting-on tag: if already assigned to current user, leave unchanged.
        // Otherwise clear.
        if (existingDagnyTask && existingDagnyTask.assigneeId === myUserId) {
            return undefined;
        }
        return null;
    }

    // Build a PATCH body from an OF task's current state
    function buildPatchFromOFTask(ofTask, existingDagnyTask, projStatusMap, lib, usernameToId, myUserId) {
        const patch = {};

        patch.title = ofTask.name;
        patch.description = lib.stripDagnyMarker(ofTask.note);

        // Status
        const dagnyStatusId = lib.dagnyStatusFromOFTask(
            ofTask,
            projStatusMap
        );
        if (dagnyStatusId) {
            patch.statusId = dagnyStatusId;
        }

        // Tags: collect non-status tags that have hierarchies
        patch.tags = collectDagnyTags(ofTask, lib, usernameToId);

        // Estimate
        if (ofTask.estimatedMinutes != null) {
            patch.estimate = ofTask.estimatedMinutes;
        }

        // Value/flagged: flagged sets value to 1 only if neither value
        // nor effectiveValue is already non-zero; unflagged clears value
        if (ofTask.flagged) {
            var curVal = existingDagnyTask ? existingDagnyTask.value : null;
            var curEff = existingDagnyTask ? existingDagnyTask.effectiveValue : null;
            var hasValue = (curVal != null && curVal > 0) || (curEff != null && curEff > 0);
            if (!hasValue) {
                patch.value = 1;
            }
        } else {
            patch.value = null;
        }

        // Assignee from "waiting on" tags
        const assignee = resolveAssignee(ofTask, existingDagnyTask, lib, usernameToId, myUserId);
        if (assignee !== undefined) {
            patch.assigneeId = assignee;
        }

        return patch;
    }

    // Build a full Dagny task body from an OF task for creation
    function buildDagnyTaskFromOF(ofTask, projStatusMap, lib, usernameToId, myUserId) {
        const dagnyTask = {
            title: ofTask.name,
            description: lib.stripDagnyMarker(ofTask.note) || "",
            dependsOn: [],
            tags: collectDagnyTags(ofTask, lib, usernameToId),
            estimate: ofTask.estimatedMinutes || 1,
            value: ofTask.flagged ? 1 : null,
        };

        const dagnyStatusId = lib.dagnyStatusFromOFTask(
            ofTask,
            projStatusMap
        );
        if (dagnyStatusId) {
            dagnyTask.statusId = dagnyStatusId;
        }

        // Assignee from "waiting on" tags (no existing Dagny task for new tasks)
        const assignee = resolveAssignee(ofTask, null, lib, usernameToId, myUserId);
        if (assignee !== undefined && assignee !== null) {
            dagnyTask.assigneeId = assignee;
        }

        return dagnyTask;
    }

    // Collect Dagny tag strings from an OF task's tags
    // Excludes Dagny status tags (those are handled by status mapping)
    // Collect Dagny tag strings from an OF task's tags.
    // Excludes status tags and waiting-on tags that match project members.
    function collectDagnyTags(ofTask, lib, usernameToId) {
        const dagnyTags = [];
        for (const tag of ofTask.tags) {
            if (lib.isStatusTag(tag)) continue;
            // Only exclude waiting-on tags that map to a project member
            // (those are handled as assignees); others sync as regular tags
            if (lib.isWaitingOnTag(tag) && usernameToId.has(tag.name)) continue;
            dagnyTags.push(lib.ofTagToDagnyString(tag));
        }
        return dagnyTags;
    }

    // Create or update Dagny tasks representing OF projects (for
    // folder/everything modes). Each project task depends_on its direct
    // child task IDs, omitting transitive edges.
    async function syncProjectTasks(
        mapping,
        ofProjectChildren,
        ofProjectSequential,
        dagnyIndex,
        projStatusMap,
        lib
    ) {
        // Look for existing project-level Dagny tasks by checking if any
        // Dagny task's title matches an OF project name and has depends_on
        // matching the child tasks. We use a naming convention:
        // "[OF Project] <projectName>"
        for (const [projName, childIds] of ofProjectChildren) {
            const dagnyTitle = "[OF Project] " + projName;
            const isSequential = ofProjectSequential.get(projName) || false;

            // Sequential: project depends only on the last child
            // Parallel: project depends on all children
            const deps = isSequential && childIds.length > 0
                ? [childIds[childIds.length - 1]]
                : childIds;

            // Find existing Dagny task with this title
            let existingProjectTask = null;
            for (const [id, dt] of dagnyIndex) {
                if (dt.title === dagnyTitle) {
                    existingProjectTask = dt;
                    break;
                }
            }

            if (existingProjectTask) {
                // Update depends_on (replaces full list)
                await lib.updateTask(
                    mapping.dagnyProjectId,
                    existingProjectTask.taskId,
                    { dependsOn: deps }
                );
            } else {
                // Create new project-level task
                const defaultStatus = projStatusMap
                    ? projStatusMap.mappings.find(function (m) {
                          return m.ofAction === "active" && m.isDefault;
                      })
                    : null;

                const projectTask = {
                    title: dagnyTitle,
                    description:
                        "Represents OmniFocus project: " + projName,
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

    action.validate = function (selection, sender) {
        return true;
    };

    return action;
})();
