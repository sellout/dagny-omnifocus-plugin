(() => {
  const action = new PlugIn.Action(async function (
    this: any,
    selection: any,
    sender: any,
  ) {
    const lib = this.plugIn.library("dagnyLib");

    try {
      // ---- Step 1: Connection ----
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

      // ---- Step 2: Project Mapping ----
      const dagnyProjects: DagnyProject[] = await lib.getProjects();
      if (!dagnyProjects || dagnyProjects.length === 0) {
        const noProj = new Alert(
          "No Projects",
          "No Dagny projects found. Create one in Dagny first.",
        );
        await noProj.show();
        return;
      }

      const existingMappings: ProjectMapping[] = lib.getProjectMappings();

      const projForm = new Form();
      const ofTypeOptions = ["skip", "project", "folder", "everything"];
      const ofTypeLabels = [
        "Skip",
        "OmniFocus Project",
        "OmniFocus Folder",
        "Everything",
      ];

      for (let i = 0; i < dagnyProjects.length; i++) {
        const dp = dagnyProjects[i];
        const existing = existingMappings.find(
          (m: ProjectMapping) => m.dagnyProjectId === dp.id,
        );

        projForm.addField(
          new Form.Field.Option(
            "type_" + i,
            dp.name + " \u2014 Map to",
            ofTypeOptions,
            ofTypeLabels,
            existing ? existing.ofType : "skip",
          ),
        );
        projForm.addField(
          new Form.Field.String(
            "name_" + i,
            dp.name + " \u2014 OF Name",
            existing ? existing.ofName || "" : "",
          ),
        );
        projForm.addField(
          new Form.Field.String(
            "default_" + i,
            dp.name + " \u2014 Default Project (folder mode)",
            existing ? existing.ofDefaultProject || "" : "",
          ),
        );
      }

      await projForm.show("Project Mapping", "Next");

      const newMappings: ProjectMapping[] = [];
      for (let i = 0; i < dagnyProjects.length; i++) {
        const dp = dagnyProjects[i];
        const ofType: string = projForm.values["type_" + i];
        if (ofType === "skip") continue;

        const ofName: string | null = projForm.values["name_" + i] || null;
        const ofDefaultProject: string | null =
          projForm.values["default_" + i] || null;

        if (ofType === "project" && !ofName) {
          const err = new Alert(
            "Missing Name",
            "Project mapping for '" +
              dp.name +
              "' requires an OmniFocus project name.",
          );
          await err.show();
          return;
        }
        if (ofType === "folder" && !ofName) {
          const err = new Alert(
            "Missing Name",
            "Folder mapping for '" +
              dp.name +
              "' requires an OmniFocus folder name.",
          );
          await err.show();
          return;
        }

        newMappings.push({
          dagnyProjectId: dp.id,
          dagnyProjectName: dp.name,
          ofType: ofType as OFTargetType,
          ofName: ofName,
          ofDefaultProject: ofDefaultProject,
        });
      }
      lib.setProjectMappings(newMappings);

      // ---- Step 3: Status Mapping (per project) ----
      const allStatusMappings: ProjectStatusMapping[] = [];

      for (const mapping of newMappings) {
        const dagnyStatuses: DagnyStatus[] = await lib.getStatuses(
          mapping.dagnyProjectId,
        );
        if (!dagnyStatuses || dagnyStatuses.length === 0) continue;

        const existingStatusMap: ProjectStatusMapping | undefined =
          lib.getProjectStatusMap(mapping.dagnyProjectId);

        const statusForm = new Form();
        const ofActions = ["active", "completed", "dropped"];
        const ofLabels = ["Active", "Completed", "Dropped"];

        for (let j = 0; j < dagnyStatuses.length; j++) {
          const ds = dagnyStatuses[j];
          let existingEntry: StatusMappingEntry | undefined;
          if (existingStatusMap) {
            existingEntry = existingStatusMap.mappings.find(
              (m: StatusMappingEntry) => m.dagnyStatusId === ds.id,
            );
          }

          const defaultAction = ds.isClosed ? "completed" : "active";
          statusForm.addField(
            new Form.Field.Option(
              "action_" + j,
              ds.name + (ds.isClosed ? " (closed)" : ""),
              ofActions,
              ofLabels,
              existingEntry ? existingEntry.ofAction : defaultAction,
            ),
          );
          statusForm.addField(
            new Form.Field.Checkbox(
              "default_" + j,
              ds.name + " \u2014 Default for its OF action?",
              existingEntry ? existingEntry.isDefault : false,
            ),
          );
        }

        await statusForm.show(
          "Status Mapping: " + mapping.dagnyProjectName,
          "Save",
        );

        const statusEntries: StatusMappingEntry[] = [];
        for (let j = 0; j < dagnyStatuses.length; j++) {
          const ds = dagnyStatuses[j];
          const ofAction: OFAction = statusForm.values["action_" + j];
          const isDefault: boolean = statusForm.values["default_" + j];
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

        allStatusMappings.push({
          dagnyProjectId: mapping.dagnyProjectId,
          mappings: statusEntries,
        });
      }
      lib.setStatusMappings(allStatusMappings);

      const doneAlert = new Alert(
        "Configuration Saved",
        "Mapped " + newMappings.length + " project(s). Use Pull/Push to sync.",
      );
      await doneAlert.show();
    } catch (err: any) {
      const errAlert = new Alert("Configuration Error", err.message);
      await errAlert.show();
    }
  });

  action.validate = function (selection: any, sender: any): boolean {
    return true;
  };

  return action;
})();
