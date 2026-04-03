# Dagny Sync – OmniFocus plugin

[![built with garnix](https://img.shields.io/endpoint?url=https%3A%2F%2Fgarnix.io%2Fapi%2Fbadges%2Fsellout%2Fdagny-omnifocus-plugin)](https://garnix.io/repo/sellout/dagny-omnifocus-plugin)
[![Nix CI](https://nix-ci.com/badge/gh:sellout:dagny-omnifocus-plugin)](https://nix-ci.com/gh:sellout:dagny-omnifocus-plugin)
[![Project Manager](https://img.shields.io/badge/%20-Project%20Manager-%235277C3?logo=nixos&labelColor=%23cccccc)](https://sellout.github.io/project-manager/)

Dagny / OmniFocus integration

Bidirectional syncing between Dagny and OmniFocus.

## scripts

OmniFocus plugins can be accessed via the “Automation” menu, either in the menu bar or various context menus.

The scripts available as part of Dagny Sync are

- **Configure Dagny Sync** – set up mappings between Dagny and OmniFocus
- **Dagny Pull** – pull information from Dagny back to OmniFocus
- **Dagny Push** – push data from OmniFocus to Dagny
- **Remove Dagny Project** – remove the connection between a Dagny project and OmniFocus

**NB**: None of the scripts remove tasks on either end. In fact, if you remove a synced task on one side of the connection, it’ll be restored at the next time data is synced to that side. You can use “completed” or “dropped” on the OmniFocus side or any “closed” status on the Dagny side to “hide” a task. If you do want to remove it, you must remove it from both sides explicitly (and I don’t know if that’s supported by Dagny yet).

## mapping

| OmniFocus                      | Dagny       | comment                                                                                                                                  |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| project, folder, or everything | project     | in a multi-project context, OF projects are mapped to Dagny tasks                                                                        |
| action, group, or project      | task        |                                                                                                                                          |
| flagged                        | value       | non-0 value maps to flagged                                                                                                              |
| tags                           | tags        | OF supports hierarchical tags, they’re mapped to Dagny by making them into a `:`-delimited string                                        |
| `waiting on` tag               | assignee    | no tag if unassigned or assigned to current user                                                                                         |
| status & `Dagny status` tag    | status      | all statuses correspond to `active`, completed`, or `dropped`in OF, but some additionally have a`Dagny status` tag so we can preserve it |
| note                           | description |                                                                                                                                          |

Dependencies are the most complicated thing to sync.

OmniFocus → Dagny can be done completely, because OF can only fork and join, not even a braid. However, because of its limitations, OF often has false dependencies. To manage this, we only connect Dagny edges to an OF action when the action is newly pushed to Dagny.

One disconnect is that OmniFocus is really a single-user system, while Dagny supports more team-oriented operation. In order to preserve blocking information, all tasks are synced, with tasks assigned to other people in Dagny being given an `waiting on:<assignee>` tag in OmniFocus. This will prevent your blocked tasks from showing up as “Available”. If the assignees report to you, you may be done – you can periodically follow up on the actions in `waiting on`. Alternatively, You can set the status for `waiting on` (or any of its sub-tags) to “On Hold”, which means those blocking tasks won’t show up under “Available”[^1] either.

[^1]: Those actions _will_ be visible if you show “Remaining” or “Everything”.

## development

We recommend the following steps to make working in this repository as easy as possible.

### Nix users

#### `direnv allow`

This command ensures that any work you do within this repository happens within a consistent reproducible environment. That environment provides various debugging tools, etc. When you leave this directory, you will leave that environment behind, so it doesn’t impact anything else on your system.

#### `project-manager switch`

This is sort-of a catch-all for keeping your environment up-to-date. It regenerates files, wires up the project’s Git configuration, ensures the shells have the right packages, configured the right way, enables checks & formatters, etc.

### non-Nix users

## building & development

Especially if you are unfamiliar with the default ecosystem, there is a flake-based Nix build. If you are unfamiliar with Nix, [Nix adjacent](...) can help you get things working in the shortest time and least effort possible.

### if you have `nix` installed

`nix build` will build and test the project fully.

`nix develop` will put you into an environment where the traditional build tooling works. If you also have `direnv` installed, then you should automatically be in that environment when you're in a directory in this project.

## versioning

In the absolute, almost every change is a breaking change. This section describes how we mitigate that to offer minor updates and revisions.

## comparisons

Other projects similar to this one, and how they differ.
