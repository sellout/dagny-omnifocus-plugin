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
                const dagnyTasks = await lib.getTasks(mapping.dagnyProjectId);
                const dagnyStatuses = await lib.getStatuses(
                    mapping.dagnyProjectId
                );
                const projStatusMap = lib.getProjectStatusMap(
                    mapping.dagnyProjectId
                );

                // Build userId -> username map from project members
                const members = await lib.getProjectMembers(mapping.dagnyProjectId);
                const memberMap = new Map();
                for (const m of members) {
                    memberMap.set(m.userId, m.username);
                }

                const target = lib.resolveOFTarget(mapping);

                // Build index: dagnyTaskId -> ofTask
                const index = new Map();
                const tasksToScan =
                    target.type === "everything"
                        ? flattenedTasks
                        : target.tasks;

                for (const ofTask of tasksToScan) {
                    const marker = lib.getDagnyMarker(ofTask);
                    if (
                        marker &&
                        lib.markerMatchesProject(marker, mapping)
                    ) {
                        index.set(marker.taskId, ofTask);
                    }
                }

                for (const dt of dagnyTasks) {
                    // Skip project-level placeholder tasks created by push
                    // to represent OF projects — not real tasks.
                    if (dt.title.startsWith("[OF Project] ")) continue;

                    let ofTask = index.get(dt.taskId);
                    const isNew = !ofTask;

                    if (isNew) {
                        const insertLoc =
                            lib.insertionLocationForTarget(target);
                        ofTask = new Task(dt.title, insertLoc);
                        lib.setDagnyMarker(
                            ofTask,
                            mapping.dagnyProjectName,
                            dt.taskId
                        );
                        totalCreated++;
                    } else {
                        totalUpdated++;
                    }

                    // Update fields
                    ofTask.name = dt.title;

                    // Update note: preserve marker, replace description
                    const description = dt.description || "";
                    const marker =
                        "[dagny:" +
                        mapping.dagnyProjectName +
                        ":" +
                        dt.taskId +
                        "]";
                    if (description) {
                        ofTask.note = description + "\n" + marker;
                    } else {
                        ofTask.note = marker;
                    }

                    // Estimate: Dagny uses 1/2/3/5/8 scale, no specific unit.
                    // Store as estimatedMinutes.
                    if (dt.estimate != null) {
                        ofTask.estimatedMinutes = dt.estimate;
                    }

                    // Flag if Dagny task has a value set
                    // Flag if task has a non-zero effective value
                    var ev = dt.effectiveValue != null ? dt.effectiveValue : dt.value;
                    ofTask.flagged = (ev != null && ev > 0);

                    // Apply status mapping
                    if (dt.statusId) {
                        lib.applyStatusToOFTask(
                            ofTask,
                            dt.statusId,
                            projStatusMap
                        );
                    }

                    // Sync tags from Dagny (add only, never remove)
                    if (dt.tags && dt.tags.length > 0) {
                        for (const dagnyTagStr of dt.tags) {
                            // Skip status and waiting-on tags -- managed separately
                            if (dagnyTagStr.startsWith("Dagny status:") ||
                                dagnyTagStr.startsWith("waiting on:")) {
                                continue;
                            }
                            const ofTag =
                                lib.ensureTagHierarchy(dagnyTagStr);
                            if (!ofTask.tags.includes(ofTag)) {
                                ofTask.addTag(ofTag);
                            }
                        }
                    }

                    // Assignee -> "waiting on" tag
                    // Remove any existing waiting-on tags first
                    const existingWaitingOn = ofTask.tags.filter(function (t) {
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
            }

            const summary = new Alert(
                "Pull Complete",
                "Created " +
                    totalCreated +
                    " task(s), updated " +
                    totalUpdated +
                    " task(s)."
            );
            await summary.show();
        } catch (err) {
            const errAlert = new Alert("Pull Error", err.message);
            await errAlert.show();
        }
    });

    action.validate = function (selection, sender) {
        return true;
    };

    return action;
})();
