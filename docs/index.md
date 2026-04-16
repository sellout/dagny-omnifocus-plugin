---
title: Dagny Sync
nav_order: 1
---

# Dagny Sync

Dagny Sync is an [OmniFocus](https://www.omnigroup.com/omnifocus/)
plugin that provides bidirectional syncing with
[Dagny](https://dagny.co/), a collaborative project management tool.

OmniFocus is a personal task manager for macOS and iOS. Dagny is a
team-oriented project management system with rich dependency tracking.
Dagny Sync bridges the two, letting you work in OmniFocus while staying
connected to your team's Dagny projects.

## What does it do?

- **Pull** tasks from Dagny into OmniFocus, converting Dagny's dependency
  graph into OmniFocus's parent/child hierarchy.
- **Push** changes from OmniFocus back to Dagny, translating hierarchy
  and status updates into Dagny's model.
- **Filter by team member** so you only see the tasks relevant to you, plus
  the blockers and blocked tasks that give you context.
- **Map statuses and tags** between the two systems, with configurable
  prefixes and defaults.

## Actions

The plugin adds four actions to OmniFocus's Automation menu:

- **Configure Dagny Sync** -- connect to Dagny and set up project mappings.
- **Pull from Dagny** -- fetch tasks from Dagny and update OmniFocus.
- **Push to Dagny** -- send OmniFocus changes back to Dagny.
- **Remove Dagny Mapping** -- disconnect a Dagny project from OmniFocus.

None of the actions delete tasks on either side. Removing a synced task
from one side will restore it on the next sync. Use "completed" or
"dropped" in OmniFocus (or any closed status in Dagny) to hide tasks you
no longer need.

## Documentation

- [Configuration](configuration.md) -- connecting to Dagny, project
  mappings, dependency modes, team filtering, tags, and status mapping.
- [Pulling from Dagny](pull.md) -- how tasks are fetched, filtered,
  converted from a dependency DAG to an OmniFocus tree, and applied.
- [Pushing to Dagny](push.md) -- how OmniFocus changes are scanned,
  dependencies are computed from hierarchy, and updates are sent.
