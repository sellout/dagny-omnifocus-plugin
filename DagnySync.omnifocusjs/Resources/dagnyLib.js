(() => {
    const credentials = new Credentials();
    const preferences = new Preferences();

    const SERVICE_NAME = "dagny-sync";
    const PREF_BASE_URL = "dagnyBaseUrl";
    const PREF_PROJECT_MAPPINGS = "projectMappings";
    const PREF_STATUS_MAPPINGS = "statusMappings";
    // Marker format: [dagny:ProjectName:taskUUID]
    // Also matches the old format [dagny:projectUUID:taskUUID] for migration.
    const DAGNY_MARKER_REGEX = /\[dagny:([^\]]+):([a-f0-9-]{36})\]/;

    const lib = new PlugIn.Library(new Version("0.1"));

    // ---- Configuration helpers ----

    lib.getBaseUrl = function () {
        return preferences.readString(PREF_BASE_URL) || "https://dagny.co/api";
    };

    lib.setBaseUrl = function (url) {
        preferences.write(PREF_BASE_URL, url);
    };

    // Each entry: {
    //   dagnyProjectId, dagnyProjectName,
    //   ofType: "project" | "folder" | "everything",
    //   ofName: string | null,          // OF project/folder name; null for "everything"
    //   ofDefaultProject: string | null  // for folder mode: project name for new tasks
    // }
    lib.getProjectMappings = function () {
        const raw = preferences.readString(PREF_PROJECT_MAPPINGS);
        return raw ? JSON.parse(raw) : [];
    };

    lib.setProjectMappings = function (mappings) {
        preferences.write(PREF_PROJECT_MAPPINGS, JSON.stringify(mappings));
    };

    // Each entry: {
    //   dagnyProjectId,
    //   mappings: [{
    //     dagnyStatusId, dagnyStatusName, isClosed,
    //     ofAction: "active" | "completed" | "dropped",
    //     isDefault: boolean  // if true, no status tag is added for this OF action
    //   }]
    // }
    lib.getStatusMappings = function () {
        const raw = preferences.readString(PREF_STATUS_MAPPINGS);
        return raw ? JSON.parse(raw) : [];
    };

    lib.setStatusMappings = function (mappings) {
        preferences.write(PREF_STATUS_MAPPINGS, JSON.stringify(mappings));
    };

    // ---- HTTP client with session management ----

    // Session state — stored in module-level vars since library object
    // properties may not persist across async calls in Omni Automation.
    var sessionCookie = null;
    var xsrfToken = null;

    // Pass username/password directly, or omit to read from Keychain.
    lib.login = async function (username, password) {
        if (!username || !password) {
            const cred = credentials.read(SERVICE_NAME);
            if (!cred) {
                throw new Error("No Dagny credentials configured. Run Configure first.");
            }
            username = cred.user;
            password = cred.password;
        }
        const baseUrl = lib.getBaseUrl();
        const req = new URL.FetchRequest();
        req.url = URL.fromString(baseUrl + "/login");
        req.method = "POST";
        req.headers = { "Content-Type": "application/json;charset=utf-8" };
        req.bodyString = JSON.stringify({
            username: username,
            password: password,
        });
        const resp = await req.fetch();
        if (resp.statusCode !== 204 && resp.statusCode !== 200) {
            throw new Error("Dagny login failed: HTTP " + resp.statusCode);
        }
        // Parse both cookies from Set-Cookie header
        const cookieKey = Object.keys(resp.headers).find(
            function (k) { return k.toLowerCase() === "set-cookie"; }
        );
        if (cookieKey) {
            const raw = String(resp.headers[cookieKey]);
            // Extract JWT-Cookie and XSRF-TOKEN from the combined header
            const jwtMatch = raw.match(/JWT-Cookie=([^;]+)/);
            const xsrfMatch = raw.match(/XSRF-TOKEN=([^;]+)/);
            if (jwtMatch && xsrfMatch) {
                sessionCookie = "JWT-Cookie=" + jwtMatch[1] + "; XSRF-TOKEN=" + xsrfMatch[1];
                xsrfToken = xsrfMatch[1];
            } else if (jwtMatch) {
                sessionCookie = "JWT-Cookie=" + jwtMatch[1];
            }
        }
    };

    lib.buildRequest = function (method, path, body) {
        const baseUrl = lib.getBaseUrl();
        const req = new URL.FetchRequest();
        req.url = URL.fromString(baseUrl + path);
        req.method = method;
        const hdrs = { "Content-Type": "application/json;charset=utf-8" };
        if (sessionCookie) {
            hdrs["Cookie"] = sessionCookie;
        }
        if (xsrfToken) {
            hdrs["X-XSRF-TOKEN"] = xsrfToken;
        }
        req.headers = hdrs;
        if (body) {
            req.bodyString = JSON.stringify(body);
        }
        return req;
    };

    lib.fetch = async function (method, path, body) {
        if (!sessionCookie) {
            await lib.login();
        }
        let resp = await lib.buildRequest(method, path, body).fetch();
        if (resp.statusCode === 401) {
            await lib.login();
            resp = await lib.buildRequest(method, path, body).fetch();
        }
        return lib.parseResponse(resp);
    };

    lib.parseResponse = function (resp) {
        if (resp.statusCode >= 200 && resp.statusCode < 300) {
            if (resp.bodyString && resp.bodyString.length > 0) {
                return JSON.parse(resp.bodyString);
            }
            return null;
        }
        throw new Error(
            "Dagny API error: HTTP " +
                resp.statusCode +
                " " +
                (resp.bodyString || "")
        );
    };

    // ---- Dagny API wrappers ----

    lib.getProjects = function () {
        return lib.fetch("GET", "/projects");
    };

    lib.getStatuses = function (projectId) {
        return lib.fetch("GET", "/statuses/" + projectId);
    };

    lib.getTasks = function (projectId, params) {
        let qs = "";
        if (params) {
            const parts = [];
            if (params.status_ids) {
                params.status_ids.forEach(function (id) {
                    parts.push("status_id=" + encodeURIComponent(id));
                });
            }
            if (params.tags) {
                params.tags.forEach(function (t) {
                    parts.push("tag=" + encodeURIComponent(t));
                });
            }
            if (parts.length) {
                qs = "?" + parts.join("&");
            }
        }
        return lib.fetch("GET", "/tasks/" + projectId + qs);
    };

    lib.createTask = function (projectId, task) {
        return lib.fetch("POST", "/tasks/" + projectId, task);
    };

    lib.updateTask = function (projectId, taskId, patch) {
        return lib.fetch(
            "PATCH",
            "/tasks/" + projectId + "/" + taskId,
            patch
        );
    };

    lib.getProjectMembers = function (projectId) {
        return lib.fetch("GET", "/projects/" + projectId + "/members");
    };

    lib.getMe = function () {
        return lib.fetch("GET", "/users/me");
    };

    // ---- Sync identity helpers ----

    lib.DAGNY_MARKER_REGEX = DAGNY_MARKER_REGEX;

    // Returns { projectKey, taskId } where projectKey is a project name
    // (new format) or project UUID (old format).
    lib.getDagnyMarker = function (ofTask) {
        if (!ofTask.note) return null;
        const match = ofTask.note.match(DAGNY_MARKER_REGEX);
        if (match) return { projectKey: match[1], taskId: match[2] };
        return null;
    };

    // Check if a marker matches a project mapping (by name or legacy UUID).
    lib.markerMatchesProject = function (marker, mapping) {
        return (
            marker.projectKey === mapping.dagnyProjectName ||
            marker.projectKey === mapping.dagnyProjectId
        );
    };

    lib.setDagnyMarker = function (ofTask, dagnyProjectName, dagnyTaskId) {
        const marker =
            "[dagny:" + dagnyProjectName + ":" + dagnyTaskId + "]";
        if (!ofTask.note) {
            ofTask.note = marker;
        } else if (!ofTask.note.match(DAGNY_MARKER_REGEX)) {
            ofTask.note = ofTask.note + "\n" + marker;
        } else {
            ofTask.note = ofTask.note.replace(DAGNY_MARKER_REGEX, marker);
        }
    };

    lib.stripDagnyMarker = function (note) {
        if (!note) return "";
        return note.replace(DAGNY_MARKER_REGEX, "").trim();
    };

    // ---- Tag helpers ----

    // Walk or create the tag hierarchy from a colon-separated name.
    // e.g. "foo:bar:baz" -> tag baz under bar under foo
    lib.ensureTagHierarchy = function (colonSeparatedName) {
        const parts = colonSeparatedName.split(":");
        let parent = null;
        let current = null;
        for (let i = 0; i < parts.length; i++) {
            const name = parts[i].trim();
            if (i === 0) {
                current = flattenedTags.byName(name);
                if (!current) {
                    current = new Tag(name, tags.ending);
                }
            } else {
                const child = current.children.find(function (t) {
                    return t.name === name;
                });
                if (child) {
                    current = child;
                } else {
                    current = new Tag(name, current.ending);
                }
            }
        }
        return current;
    };

    // Create or find "Dagny status:<statusName>" as a top-level tag
    lib.ensureStatusTag = function (statusName) {
        const tagName = "Dagny status:" + statusName;
        return lib.ensureTagHierarchy(tagName);
    };

    // Convert an OF tag back to a colon-separated Dagny string
    // by walking the parent chain.
    lib.ofTagToDagnyString = function (tag) {
        const parts = [];
        let t = tag;
        while (t) {
            parts.unshift(t.name);
            t = t.parent;
        }
        return parts.join(":");
    };

    // Check if a tag is a Dagny status tag (lives under "Dagny status")
    lib.isStatusTag = function (tag) {
        return tag.parent && tag.parent.name === "Dagny status";
    };

    // Check if a tag is a "waiting on" tag (lives under "waiting on")
    lib.isWaitingOnTag = function (tag) {
        return tag.parent && tag.parent.name === "waiting on";
    };

    // Get the username from a "waiting on:<username>" tag
    lib.getWaitingOnUsername = function (tag) {
        if (lib.isWaitingOnTag(tag)) {
            return tag.name;
        }
        return null;
    };

    // Create or find "waiting on:<username>" tag
    lib.ensureWaitingOnTag = function (username) {
        return lib.ensureTagHierarchy("waiting on:" + username);
    };

    // ---- OF target resolution ----

    lib.resolveOFTarget = function (mapping) {
        if (mapping.ofType === "project") {
            const proj = flattenedProjects.byName(mapping.ofName);
            if (!proj) {
                throw new Error(
                    "OmniFocus project not found: " + mapping.ofName
                );
            }
            return { tasks: proj.flattenedTasks, container: proj, type: "project" };
        } else if (mapping.ofType === "folder") {
            const folder = flattenedFolders.byName(mapping.ofName);
            if (!folder) {
                throw new Error(
                    "OmniFocus folder not found: " + mapping.ofName
                );
            }
            const allTasks = [];
            folder.flattenedProjects.forEach(function (p) {
                p.flattenedTasks.forEach(function (t) {
                    allTasks.push(t);
                });
            });
            // Resolve default project for creating new tasks
            let defaultProj = null;
            if (mapping.ofDefaultProject) {
                defaultProj = folder.flattenedProjects.find(function (p) {
                    return p.name === mapping.ofDefaultProject;
                });
            }
            if (!defaultProj && folder.flattenedProjects.length > 0) {
                defaultProj = folder.flattenedProjects[0];
            }
            return {
                tasks: allTasks,
                container: defaultProj,
                folder: folder,
                type: "folder",
            };
        } else {
            // "everything"
            return { tasks: flattenedTasks, container: null, type: "everything" };
        }
    };

    // Get the insertion location for new tasks in a given target
    lib.insertionLocationForTarget = function (target) {
        if (target.type === "project" && target.container) {
            return target.container.ending;
        } else if (target.type === "folder" && target.container) {
            return target.container.ending;
        } else {
            // "everything" -> inbox
            return inbox.ending;
        }
    };

    // ---- Status mapping helpers ----

    // Find the status mapping config for a given Dagny project
    lib.getProjectStatusMap = function (dagnyProjectId) {
        const all = lib.getStatusMappings();
        return all.find(function (sm) {
            return sm.dagnyProjectId === dagnyProjectId;
        });
    };

    // Apply Dagny status to an OF task during pull
    lib.applyStatusToOFTask = function (ofTask, dagnyStatusId, projStatusMap) {
        if (!projStatusMap || !projStatusMap.mappings) return;

        const entry = projStatusMap.mappings.find(function (m) {
            return m.dagnyStatusId === dagnyStatusId;
        });
        if (!entry) return;

        // Remove existing Dagny status tags
        const existingStatusTags = ofTask.tags.filter(function (t) {
            return lib.isStatusTag(t);
        });
        if (existingStatusTags.length > 0) {
            ofTask.removeTags(existingStatusTags);
        }

        // Apply the OF action
        if (entry.ofAction === "completed") {
            if (!ofTask.completed) {
                ofTask.markComplete();
            }
        } else if (entry.ofAction === "dropped") {
            if (ofTask.taskStatus !== Task.Status.Dropped) {
                ofTask.drop(false);
            }
        } else {
            // "active"
            if (ofTask.completed) {
                ofTask.markIncomplete();
            }
        }

        // Add status tag unless this is the default for its OF action
        if (!entry.isDefault) {
            const statusTag = lib.ensureStatusTag(entry.dagnyStatusName);
            ofTask.addTag(statusTag);
        }
    };

    // Determine Dagny statusId from an OF task during push (reverse mapping)
    lib.dagnyStatusFromOFTask = function (ofTask, projStatusMap) {
        if (!projStatusMap || !projStatusMap.mappings) return null;

        // 1. Check if completed
        if (ofTask.completed) {
            const completed = projStatusMap.mappings.find(function (m) {
                return m.ofAction === "completed" && m.isDefault;
            });
            if (completed) return completed.dagnyStatusId;
            // Fallback: any completed mapping
            const anyCompleted = projStatusMap.mappings.find(function (m) {
                return m.ofAction === "completed";
            });
            if (anyCompleted) return anyCompleted.dagnyStatusId;
        }

        // 2. Check if dropped
        if (ofTask.taskStatus === Task.Status.Dropped) {
            const dropped = projStatusMap.mappings.find(function (m) {
                return m.ofAction === "dropped" && m.isDefault;
            });
            if (dropped) return dropped.dagnyStatusId;
            const anyDropped = projStatusMap.mappings.find(function (m) {
                return m.ofAction === "dropped";
            });
            if (anyDropped) return anyDropped.dagnyStatusId;
        }

        // 3. Check for a Dagny status tag
        const statusTags = ofTask.tags.filter(function (t) {
            return lib.isStatusTag(t);
        });
        if (statusTags.length > 0) {
            const statusName = statusTags[0].name;
            const byTag = projStatusMap.mappings.find(function (m) {
                return m.dagnyStatusName === statusName;
            });
            if (byTag) return byTag.dagnyStatusId;
        }

        // 4. Fallback: default active status
        const defaultActive = projStatusMap.mappings.find(function (m) {
            return m.ofAction === "active" && m.isDefault;
        });
        if (defaultActive) return defaultActive.dagnyStatusId;

        // Last resort: first active mapping
        const anyActive = projStatusMap.mappings.find(function (m) {
            return m.ofAction === "active";
        });
        return anyActive ? anyActive.dagnyStatusId : null;
    };

    // ---- Credential management ----

    lib.saveCredentials = function (username, password) {
        credentials.write(SERVICE_NAME, username, password);
    };

    lib.hasCredentials = function () {
        return credentials.read(SERVICE_NAME) !== null;
    };

    lib.clearCredentials = function () {
        credentials.remove(SERVICE_NAME);
    };

    return lib;
})();
