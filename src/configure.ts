(() => {
  const action = new PlugIn.Action(async function (
    this: any,
    selection: any,
    sender: any,
  ) {
    const lib = this.plugIn.library("dagnyLib");

    try {
      // ---- Step 1: Connection ----
      // Try existing credentials first; only show login form if needed.
      var loggedIn = false;
      if (lib.hasCredentials()) {
        try {
          await lib.login();
          await lib.getMe();
          loggedIn = true;
        } catch (e) {
          // Credentials invalid or expired — fall through to form
        }
      }

      if (!loggedIn) {
        const connForm = new Form();
        connForm.addField(
          new Form.Field.String("baseUrl", "Server URL", lib.getBaseUrl()),
        );
        connForm.addField(new Form.Field.String("username", "Username", ""));
        connForm.addField(new Form.Field.Password("password", "Password", ""));
        await connForm.show("Dagny Connection", "Connect");

        const baseUrl: string = connForm.values["baseUrl"];
        const username: string = connForm.values["username"];
        const password: string = connForm.values["password"];

        lib.setBaseUrl(baseUrl);

        await lib.login(username, password);
        lib.saveCredentials(username, password);
        const me: UserProfile = await lib.getMe();
        const connAlert = new Alert(
          "Connected",
          "Logged in as " + me.username + " (" + me.email + ")",
        );
        await connAlert.show();
      }

      // ---- Step 2: Project Mapping ----
      const dagnyProjects: DagnyProject[] = (await lib.getProjects()) || [];

      const existingMappings: ProjectMapping[] = lib.getProjectMappings();

      const projIds = dagnyProjects.map((dp: DagnyProject) => dp.id);
      const projNames = dagnyProjects.map((dp: DagnyProject) => dp.name);

      // ---- Infer defaults from OF selection ----
      const selectedProject: Project | null =
        selection.projects.length > 0 ? selection.projects[0] : null;
      const selectedFolder: Folder | null =
        selection.folders.length > 0 ? selection.folders[0] : null;
      const selectedTask: Task | null =
        selection.tasks.length > 0 ? selection.tasks[0] : null;

      var contextOfType: OFTargetType = "project";
      var contextOfName = "";
      if (selectedFolder) {
        contextOfType = "folder";
        contextOfName = selectedFolder.name;
      } else if (selectedProject) {
        contextOfType = "project";
        contextOfName = selectedProject.name;
      } else if (selectedTask && selectedTask.containingProject) {
        contextOfType = "project";
        contextOfName = selectedTask.containingProject.name;
      }

      // If the OF selection already has a mapping, default to that
      // Dagny project; otherwise default to the first project.
      var defaultDagnyId = projIds.length > 0 ? projIds[0] : "__new__";
      if (contextOfName) {
        const matchingMapping = existingMappings.find(
          (m: ProjectMapping) => m.ofName === contextOfName,
        );
        if (matchingMapping) {
          defaultDagnyId = matchingMapping.dagnyProjectId;
        }
      }

      // ---- Step 2: Pick Dagny project ----
      projIds.push("__new__");
      projNames.push("Create New Project\u2026");

      const pickForm = new Form();
      pickForm.addField(
        new Form.Field.Option(
          "project",
          "Dagny Project",
          projIds,
          projNames,
          defaultDagnyId,
        ),
      );
      pickForm.addField(
        new Form.Field.String("newName", "New Project Name", ""),
      );
      await pickForm.show("Configure Mapping", "Next");

      var selectedId: string = pickForm.values["project"];
      var selectedDagny: DagnyProject;

      if (selectedId === "__new__") {
        const newName: string = pickForm.values["newName"];
        if (!newName) {
          const err = new Alert(
            "Missing Name",
            "Enter a name for the new Dagny project.",
          );
          await err.show();
          return;
        }
        selectedDagny = await lib.createProject(newName);
        selectedId = selectedDagny.id;
      } else {
        selectedDagny = dagnyProjects.find(
          (dp: DagnyProject) => dp.id === selectedId,
        )!;
      }

      // Populate from existing mapping if one exists, otherwise from
      // OF selection context.
      const existing = existingMappings.find(
        (m: ProjectMapping) => m.dagnyProjectId === selectedId,
      );

      // ---- Fetch project members for team filtering ----
      const members: ProjectMember[] = await lib.getProjectMembers(selectedId);

      // ---- Step 3: Settings + status mapping ----
      const ofTypeOptions = ["project", "folder", "everything"];
      const ofTypeLabels = [
        "OmniFocus Project",
        "OmniFocus Folder",
        "Everything",
      ];
      const ofActions = ["active", "completed", "dropped"];
      const ofLabels = ["Active", "Completed", "Dropped"];

      const settingsForm = new Form();
      settingsForm.addField(
        new Form.Field.Option(
          "type",
          "Map to",
          ofTypeOptions,
          ofTypeLabels,
          existing ? existing.ofType : contextOfType,
        ),
      );
      settingsForm.addField(
        new Form.Field.String(
          "name",
          "OF Name",
          existing ? existing.ofName || "" : contextOfName,
        ),
      );
      settingsForm.addField(
        new Form.Field.String(
          "default",
          "Default Project (folder mode)",
          existing ? existing.ofDefaultProject || "" : "",
        ),
      );
      settingsForm.addField(
        new Form.Field.Option(
          "depmode",
          "Dependency Mode",
          ["conservative", "optimistic"],
          ["Conservative (add edges)", "Optimistic (drop edges)"],
          existing ? existing.dependencyMode || "conservative" : "conservative",
        ),
      );
      settingsForm.addField(
        new Form.Field.String(
          "estmult",
          "Minutes per estimate unit",
          existing && existing.estimateMultiplier
            ? String(existing.estimateMultiplier)
            : "1",
        ),
      );

      // ---- Team filtering ----
      const teamUserIds = ["__none__"];
      const teamUserLabels = ["None (sync all tasks)"];
      for (const m of members) {
        teamUserIds.push(m.userId);
        teamUserLabels.push(m.username);
      }
      settingsForm.addField(
        new Form.Field.Option(
          "teamUser",
          "Team User",
          teamUserIds,
          teamUserLabels,
          existing && existing.teamUserId ? existing.teamUserId : "__none__",
        ),
      );
      settingsForm.addField(
        new Form.Field.Checkbox(
          "includeUnassigned",
          "Include Unassigned Tasks",
          existing ? existing.includeUnassigned !== false : true,
        ),
      );
      settingsForm.addField(
        new Form.Field.Option(
          "newTaskAssign",
          "New Task Assignment",
          ["user", "unassigned"],
          ["Assign to me", "Leave unassigned"],
          existing && existing.newTaskAssignment
            ? existing.newTaskAssignment
            : "user",
        ),
      );

      const dagnyStatuses: DagnyStatus[] = await lib.getStatuses(selectedId);
      const existingStatusMap: ProjectStatusMapping | undefined =
        lib.getProjectStatusMap(selectedId);

      if (dagnyStatuses && dagnyStatuses.length > 0) {
        for (let j = 0; j < dagnyStatuses.length; j++) {
          const ds = dagnyStatuses[j];
          let existingEntry: StatusMappingEntry | undefined;
          if (existingStatusMap) {
            existingEntry = existingStatusMap.mappings.find(
              (m: StatusMappingEntry) => m.dagnyStatusId === ds.id,
            );
          }

          const defaultAction = ds.isClosed ? "completed" : "active";
          settingsForm.addField(
            new Form.Field.Option(
              "action_" + j,
              ds.name + (ds.isClosed ? " (closed)" : ""),
              ofActions,
              ofLabels,
              existingEntry ? existingEntry.ofAction : defaultAction,
            ),
          );
          settingsForm.addField(
            new Form.Field.Checkbox(
              "default_" + j,
              ds.name + " \u2014 Default for its OF action?",
              existingEntry ? existingEntry.isDefault : false,
            ),
          );
        }
      }

      await settingsForm.show(selectedDagny.name, "Save");

      // ---- Process and save ----
      const ofType: string = settingsForm.values["type"];
      const ofName: string | null = settingsForm.values["name"] || null;
      const ofDefaultProject: string | null =
        settingsForm.values["default"] || null;

      if (ofType === "project" && !ofName) {
        const err = new Alert(
          "Missing Name",
          "Project mapping requires an OmniFocus project name.",
        );
        await err.show();
        return;
      }
      if (ofType === "folder" && !ofName) {
        const err = new Alert(
          "Missing Name",
          "Folder mapping requires an OmniFocus folder name.",
        );
        await err.show();
        return;
      }

      const depMode: DependencyMode =
        settingsForm.values["depmode"] || "conservative";
      const estMult = parseFloat(settingsForm.values["estmult"]) || 1;

      const teamUserRaw: string = settingsForm.values["teamUser"];
      const teamUserId: string | null =
        teamUserRaw && teamUserRaw !== "__none__" ? teamUserRaw : null;
      const teamUsername: string | null = teamUserId
        ? (members.find(
            (m: ProjectMember) => m.userId === teamUserId,
          ) || { username: null }).username
        : null;

      const mapping: ProjectMapping = {
        dagnyProjectId: selectedId,
        dagnyProjectName: selectedDagny.name,
        ofType: ofType as OFTargetType,
        ofName: ofName,
        ofDefaultProject: ofDefaultProject,
        dependencyMode: depMode,
        estimateMultiplier: estMult,
        teamUserId: teamUserId,
        teamUsername: teamUsername,
        includeUnassigned: teamUserId
          ? settingsForm.values["includeUnassigned"]
          : undefined,
        newTaskAssignment: teamUserId
          ? settingsForm.values["newTaskAssign"]
          : undefined,
      };

      const updatedMappings = existingMappings.filter(
        (m: ProjectMapping) => m.dagnyProjectId !== selectedId,
      );
      updatedMappings.push(mapping);
      lib.setProjectMappings(updatedMappings);

      if (dagnyStatuses && dagnyStatuses.length > 0) {
        const statusEntries: StatusMappingEntry[] = [];
        for (let j = 0; j < dagnyStatuses.length; j++) {
          const ds = dagnyStatuses[j];
          const ofAction: OFAction = settingsForm.values["action_" + j];
          const isDefault: boolean = settingsForm.values["default_" + j];
          statusEntries.push({
            dagnyStatusId: ds.id,
            dagnyStatusName: ds.name,
            isClosed: ds.isClosed,
            ofAction: ofAction,
            isDefault: isDefault,
          });
        }

        for (const ofAct of ofActions) {
          const mapped = statusEntries.filter(
            (e: StatusMappingEntry) => e.ofAction === ofAct,
          );
          const hasDefault = mapped.some(
            (e: StatusMappingEntry) => e.isDefault,
          );
          if (!hasDefault && mapped.length > 0) {
            mapped[0].isDefault = true;
          }
        }

        const allStatusMappings: ProjectStatusMapping[] = lib
          .getStatusMappings()
          .filter(
            (sm: ProjectStatusMapping) => sm.dagnyProjectId !== selectedId,
          );
        allStatusMappings.push({
          dagnyProjectId: selectedId,
          mappings: statusEntries,
        });
        lib.setStatusMappings(allStatusMappings);
      }

      const doneAlert = new Alert(
        "Mapping Saved",
        "Saved mapping for " + selectedDagny.name + ". Use Pull/Push to sync.",
      );
      await doneAlert.show();
    } catch (err: any) {
      if (err.causedByUserCancelling) return;
      const errAlert = new Alert("Configuration Error", err.message);
      await errAlert.show();
    }
  });

  action.validate = function (selection: any, sender: any): boolean {
    return true;
  };

  return action;
})();
