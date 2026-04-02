// OmniFocus Omni Automation ambient type declarations.
// These are provided by the OmniFocus runtime — no imports needed.

declare class Version {
  constructor(versionString: string);
}

// ---- Database Objects ----

interface DatabaseObject {
  id: { primaryKey: string };
}

declare class Task implements DatabaseObject {
  constructor(name: string, position?: any);
  id: { primaryKey: string };
  name: string;
  note: string;
  flagged: boolean;
  dueDate: Date | null;
  deferDate: Date | null;
  completed: boolean;
  completionDate: Date | null;
  taskStatus: Task.Status;
  tags: Tag[];
  children: Task[];
  hasChildren: boolean;
  sequential: boolean;
  estimatedMinutes: number | null;
  containingProject: Project | null;
  parent: Task | null;
  assignedContainer: Project | Task | null;
  before: any;
  after: any;
  beginning: any;
  ending: any;
  flattenedTasks: Task[];
  markComplete(date?: Date): void;
  markIncomplete(): void;
  drop(allOccurrences: boolean): void;
  addTag(tag: Tag): void;
  addTags(tags: Tag[]): void;
  removeTag(tag: Tag): void;
  removeTags(tags: Tag[]): void;
}

declare namespace Task {
  enum Status {
    Available = "Available",
    Blocked = "Blocked",
    Completed = "Completed",
    Dropped = "Dropped",
    DueSoon = "DueSoon",
    Next = "Next",
    Overdue = "Overdue",
  }
}

declare class Project implements DatabaseObject {
  constructor(name: string, position?: any);
  id: { primaryKey: string };
  name: string;
  status: Project.Status;
  task: Task;
  sequential: boolean;
  containsSingletonActions: boolean;
  flattenedTasks: Task[];
  parentFolder: Folder | null;
  before: any;
  after: any;
  beginning: any;
  ending: any;
  markComplete(date?: Date): void;
  markIncomplete(): void;
}

declare namespace Project {
  enum Status {
    Active = "Active",
    Done = "Done",
    Dropped = "Dropped",
    OnHold = "OnHold",
  }
}

declare class Folder implements DatabaseObject {
  constructor(name: string, position?: any);
  id: { primaryKey: string };
  name: string;
  children: (Folder | Project)[];
  folders: Folder[];
  projects: Project[];
  flattenedProjects: Project[];
  flattenedFolders: Folder[];
  parent: Folder | null;
  before: any;
  after: any;
  beginning: any;
  ending: any;
}

declare class Tag implements DatabaseObject {
  constructor(name: string, position?: any);
  id: { primaryKey: string };
  name: string;
  status: Tag.Status;
  children: Tag[];
  parent: Tag | null;
  tasks: Task[];
  ending: any;
}

declare namespace Tag {
  enum Status {
    Active = "Active",
    OnHold = "OnHold",
    Dropped = "Dropped",
  }
}

// ---- Collections with byName ----

interface NamedCollection<T> extends Array<T> {
  byName(name: string): T | null;
}

// ---- Plugin Infrastructure ----

declare namespace PlugIn {
  class Library {
    constructor(version: Version);
    [key: string]: any;
  }
  class Action {
    constructor(perform: (selection: any, sender: any) => void | Promise<void>);
    validate: (selection: any, sender: any) => boolean;
    [key: string]: any;
  }
}

declare class PlugIn {
  static find(identifier: string): PlugIn | null;
  library(identifier: string): any;
  action(identifier: string): PlugIn.Action | null;
}

// ---- HTTP ----

declare namespace URL {
  class FetchRequest {
    constructor();
    static fromString(urlString: string): FetchRequest;
    url: any;
    method: string;
    headers: Record<string, string>;
    bodyString: string | null;
    cache: string;
    fetch(): Promise<FetchResponse>;
  }
  class FetchResponse {
    statusCode: number;
    bodyString: string | null;
    headers: Record<string, string>;
    mimeType: string | null;
    url: any;
  }
  function fromString(urlString: string): any;
}

// ---- Storage ----

declare class Credentials {
  constructor();
  read(service: string): { user: string; password: string } | null;
  write(service: string, username: string, password: string): void;
  remove(service: string): void;
}

declare class Preferences {
  constructor(identifier?: string);
  read(key: string): any;
  readString(key: string): string | null;
  readNumber(key: string): number | null;
  readBoolean(key: string): boolean;
  write(key: string, value: any): void;
  remove(key: string): void;
}

// ---- UI ----

declare class Form {
  constructor();
  addField(field: any, index?: number): void;
  removeField(field: any): void;
  show(title: string, confirmTitle: string): Promise<Form>;
  validate: ((form: Form) => boolean) | null;
  values: Record<string, any>;
}

declare namespace Form {
  namespace Field {
    class String {
      constructor(
        key: string,
        displayName: string,
        value?: string,
        formatter?: any,
      );
    }
    class Password {
      constructor(key: string, displayName: string, value?: string);
    }
    class Checkbox {
      constructor(key: string, displayName: string, value?: boolean);
    }
    class Option {
      constructor(
        key: string,
        displayName: string,
        options: string[],
        names: string[],
        selected: string,
        nullOptionTitle?: string,
      );
    }
  }
}

declare class Alert {
  constructor(title: string, message: string);
  show(): Promise<number>;
}

// ---- Globals ----

declare const flattenedTasks: NamedCollection<Task>;
declare const flattenedProjects: NamedCollection<Project>;
declare const flattenedFolders: NamedCollection<Folder>;
declare const flattenedTags: NamedCollection<Tag>;
declare const tags: { beginning: any; ending: any };
declare const inbox: { ending: any; tasks: Task[]; children: Task[] };

declare const console: {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
};
