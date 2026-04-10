(() => {
  const action = new PlugIn.Action(async function (
    this: any,
    selection: any,
    sender: any,
  ) {
    const lib = this.plugIn.library("dagnyLib");

    try {
      const selectedProject: Project | null =
        selection.projects.length > 0 ? selection.projects[0] : null;
      const selectedFolder: Folder | null =
        selection.folders.length > 0 ? selection.folders[0] : null;

      if (!selectedProject && !selectedFolder) {
        const alert = new Alert(
          "No Selection",
          "Select a project or folder to remove its Dagny mapping.",
        );
        await alert.show(null);
        return;
      }

      const selectedName = selectedProject
        ? selectedProject.name
        : selectedFolder!.name;

      const mappings: ProjectMapping[] = lib.getProjectMappings();

      // Find mappings that reference this OF project or folder
      const matching = mappings.filter(function (m: ProjectMapping) {
        return m.ofName === selectedName;
      });

      if (matching.length === 0) {
        const alert = new Alert(
          "No Mapping",
          "'" + selectedName + "' is not mapped to any Dagny project.",
        );
        await alert.show(null);
        return;
      }

      // Confirm removal
      const confirmAlert = new Alert(
        "Remove Mapping",
        "Remove Dagny mapping for '" +
          selectedName +
          "'?\n\nMapped to: " +
          matching
            .map(function (m: ProjectMapping) {
              return m.dagnyProjectName;
            })
            .join(", ") +
          "\n\nThis does not delete tasks in OmniFocus or Dagny.",
      );
      confirmAlert.addOption("Remove");
      confirmAlert.addOption("Cancel");
      const result = await confirmAlert.show(null);

      // addOption index: 0 = Remove, 1 = Cancel
      if (result !== 0) return;

      // Remove the matching mappings
      const remaining = mappings.filter(function (m: ProjectMapping) {
        return m.ofName !== selectedName;
      });
      lib.setProjectMappings(remaining);

      // Also remove status mappings for the removed projects
      const removedIds = new Set(
        matching.map(function (m: ProjectMapping) {
          return m.dagnyProjectId;
        }),
      );
      const statusMappings: ProjectStatusMapping[] = lib.getStatusMappings();
      const remainingStatuses = statusMappings.filter(function (
        sm: ProjectStatusMapping,
      ) {
        return !removedIds.has(sm.dagnyProjectId);
      });
      lib.setStatusMappings(remainingStatuses);

      const doneAlert = new Alert(
        "Mapping Removed",
        "Removed Dagny mapping for '" + selectedName + "'.",
      );
      await doneAlert.show(null);
    } catch (err: any) {
      const errAlert = new Alert("Error", err.message);
      await errAlert.show(null);
    }
  });

  action.validate = function (selection: any, sender: any): boolean {
    return selection.projects.length > 0 || selection.folders.length > 0;
  };

  return action;
})();
