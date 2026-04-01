(() => {
    const action = new PlugIn.Action(async function (selection, sender) {
        const lib = this.plugIn.library("dagnyLib");

        try {
            // ---- Step 1: Connection ----
            const connForm = new Form();
            connForm.addField(
                new Form.Field.String("baseUrl", "Server URL", lib.getBaseUrl())
            );
            connForm.addField(
                new Form.Field.String("username", "Username", "")
            );
            connForm.addField(
                new Form.Field.Password("password", "Password", "")
            );
            await connForm.show("Dagny Connection", "Connect");

            const baseUrl = connForm.values["baseUrl"];
            const username = connForm.values["username"];
            const password = connForm.values["password"];

            lib.setBaseUrl(baseUrl);

            // Test login with form values directly, then save on success
            await lib.login(username, password);
            lib.saveCredentials(username, password);
            const me = await lib.getMe();
            const connAlert = new Alert(
                "Connected",
                "Logged in as " + me.username + " (" + me.email + ")"
            );
            await connAlert.show();

            // ---- Step 2: Project Mapping ----
            const dagnyProjects = await lib.getProjects();
            if (!dagnyProjects || dagnyProjects.length === 0) {
                const noProj = new Alert(
                    "No Projects",
                    "No Dagny projects found. Create one in Dagny first."
                );
                await noProj.show();
                return;
            }

            const existingMappings = lib.getProjectMappings();

            const projForm = new Form();
            const ofTypeOptions = ["skip", "project", "folder", "everything"];
            const ofTypeLabels = ["Skip", "OmniFocus Project", "OmniFocus Folder", "Everything"];

            for (let i = 0; i < dagnyProjects.length; i++) {
                const dp = dagnyProjects[i];
                // Find existing mapping for pre-fill
                const existing = existingMappings.find(function (m) {
                    return m.dagnyProjectId === dp.id;
                });

                projForm.addField(
                    new Form.Field.Option(
                        "type_" + i,
                        dp.name + " — Map to",
                        ofTypeOptions,
                        ofTypeLabels,
                        existing ? existing.ofType : "skip"
                    )
                );
                projForm.addField(
                    new Form.Field.String(
                        "name_" + i,
                        dp.name + " — OF Name",
                        existing ? existing.ofName || "" : ""
                    )
                );
                projForm.addField(
                    new Form.Field.String(
                        "default_" + i,
                        dp.name + " — Default Project (folder mode)",
                        existing ? existing.ofDefaultProject || "" : ""
                    )
                );
            }

            await projForm.show("Project Mapping", "Next");

            const newMappings = [];
            for (let i = 0; i < dagnyProjects.length; i++) {
                const dp = dagnyProjects[i];
                const ofType = projForm.values["type_" + i];
                if (ofType === "skip") continue;

                const ofName = projForm.values["name_" + i] || null;
                const ofDefaultProject =
                    projForm.values["default_" + i] || null;

                if (ofType === "project" && !ofName) {
                    const err = new Alert(
                        "Missing Name",
                        "Project mapping for '" + dp.name + "' requires an OmniFocus project name."
                    );
                    await err.show();
                    return;
                }
                if (ofType === "folder" && !ofName) {
                    const err = new Alert(
                        "Missing Name",
                        "Folder mapping for '" + dp.name + "' requires an OmniFocus folder name."
                    );
                    await err.show();
                    return;
                }

                newMappings.push({
                    dagnyProjectId: dp.id,
                    dagnyProjectName: dp.name,
                    ofType: ofType,
                    ofName: ofName,
                    ofDefaultProject: ofDefaultProject,
                });
            }
            lib.setProjectMappings(newMappings);

            // ---- Step 3: Status Mapping (per project) ----
            const allStatusMappings = [];

            for (const mapping of newMappings) {
                const dagnyStatuses = await lib.getStatuses(
                    mapping.dagnyProjectId
                );
                if (!dagnyStatuses || dagnyStatuses.length === 0) continue;

                const existingStatusMap = lib.getProjectStatusMap(
                    mapping.dagnyProjectId
                );

                const statusForm = new Form();
                const ofActions = ["active", "completed", "dropped"];
                const ofLabels = ["Active", "Completed", "Dropped"];

                for (let j = 0; j < dagnyStatuses.length; j++) {
                    const ds = dagnyStatuses[j];
                    // Find existing for pre-fill
                    let existingEntry = null;
                    if (existingStatusMap) {
                        existingEntry = existingStatusMap.mappings.find(
                            function (m) {
                                return m.dagnyStatusId === ds.id;
                            }
                        );
                    }

                    const defaultAction = ds.isClosed ? "completed" : "active";
                    statusForm.addField(
                        new Form.Field.Option(
                            "action_" + j,
                            ds.name + (ds.isClosed ? " (closed)" : ""),
                            ofActions,
                            ofLabels,
                            existingEntry
                                ? existingEntry.ofAction
                                : defaultAction
                        )
                    );
                    statusForm.addField(
                        new Form.Field.Checkbox(
                            "default_" + j,
                            ds.name + " — Default for its OF action?",
                            existingEntry ? existingEntry.isDefault : false
                        )
                    );
                }

                await statusForm.show(
                    "Status Mapping: " + mapping.dagnyProjectName,
                    "Save"
                );

                // Determine defaults: if no explicit default is set, use the
                // first status for each OF action as the default
                const statusEntries = [];
                const seenDefaults = {};
                for (let j = 0; j < dagnyStatuses.length; j++) {
                    const ds = dagnyStatuses[j];
                    const ofAction = statusForm.values["action_" + j];
                    const isDefault = statusForm.values["default_" + j];
                    statusEntries.push({
                        dagnyStatusId: ds.id,
                        dagnyStatusName: ds.name,
                        isClosed: ds.isClosed,
                        ofAction: ofAction,
                        isDefault: isDefault,
                    });
                }

                // If no default was checked for an OF action, make the first
                // status mapped to that action the default
                for (const ofAct of ofActions) {
                    const mapped = statusEntries.filter(function (e) {
                        return e.ofAction === ofAct;
                    });
                    const hasDefault = mapped.some(function (e) {
                        return e.isDefault;
                    });
                    if (!hasDefault && mapped.length > 0) {
                        mapped[0].isDefault = true;
                    }
                }

                allStatusMappings.push({
                    dagnyProjectId: mapping.dagnyProjectId,
                    mappings: statusEntries,
                });
            }
            lib.setStatusMappings(allStatusMappings);

            const doneAlert = new Alert(
                "Configuration Saved",
                "Mapped " +
                    newMappings.length +
                    " project(s). Use Pull/Push to sync."
            );
            await doneAlert.show();
        } catch (err) {
            const errAlert = new Alert("Configuration Error", err.message);
            await errAlert.show();
        }
    });

    action.validate = function (selection, sender) {
        return true;
    };

    return action;
})();
