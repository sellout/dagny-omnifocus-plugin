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

                for (const ofTask of tasksToScan) {
                    const marker = lib.getDagnyMarker(ofTask);

                    if (
                        marker &&
                        lib.markerMatchesProject(marker, mapping)
                    ) {
                        // Existing synced task: push updates
                        const existingDagnyTask = dagnyIndex.get(marker.taskId);
                        const patch = buildPatchFromOFTask(
                            ofTask,
                            existingDagnyTask,
                            projStatusMap,
                            lib,
                            usernameToId,
                            myUserId
                        );
                        if (patch) {
                            await lib.updateTask(
                                mapping.dagnyProjectId,
                                marker.taskId,
                                patch
                            );
                            totalUpdated++;
                        }

                        // Track parent project for dependency edges
                        if (
                            (target.type === "folder" ||
                                target.type === "everything") &&
                            ofTask.containingProject
                        ) {
                            const projName = ofTask.containingProject.name;
                            if (!ofProjectChildren.has(projName)) {
                                ofProjectChildren.set(projName, []);
                            }
                            ofProjectChildren
                                .get(projName)
                                .push(marker.taskId);
                        }
                    } else if (!marker) {
                        // New OF task: create in Dagny
                        // Only push if it belongs to a container mapped to
                        // this Dagny project
                        if (!taskBelongsToMapping(ofTask, mapping, target)) {
                            continue;
                        }

                        const dagnyTask = buildDagnyTaskFromOF(
                            ofTask,
                            projStatusMap,
                            lib,
                            usernameToId,
                            myUserId
                        );
                        const newId = await lib.createTask(
                            mapping.dagnyProjectId,
                            dagnyTask
                        );
                        // newId is the UUID returned from the API
                        const taskId =
                            typeof newId === "string"
                                ? newId
                                : newId.taskId || newId;
                        lib.setDagnyMarker(
                            ofTask,
                            mapping.dagnyProjectName,
                            taskId
                        );
                        totalCreated++;

                        // Track parent project
                        if (
                            (target.type === "folder" ||
                                target.type === "everything") &&
                            ofTask.containingProject
                        ) {
                            const projName = ofTask.containingProject.name;
                            if (!ofProjectChildren.has(projName)) {
                                ofProjectChildren.set(projName, []);
                            }
                            ofProjectChildren.get(projName).push(taskId);
                        }
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
                    { dependsOn: childIds }
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
                    dependsOn: childIds,
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
