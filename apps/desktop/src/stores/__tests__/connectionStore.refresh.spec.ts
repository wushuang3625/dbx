import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isObjectCacheInvalidationError } from "@/lib/metadata/objectCacheInvalidationError";
import type { ConnectionConfig, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function postgresConnection(): ConnectionConfig {
  return {
    id: "pg-1",
    name: "Postgres",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
  } as ConnectionConfig;
}

function schemaNode(children: TreeNode[]): TreeNode {
  return {
    id: "pg-1:app:public",
    label: "public",
    type: "schema",
    connectionId: "pg-1",
    database: "app",
    schema: "public",
    isExpanded: true,
    children,
  };
}

function objectGroup(type: "group-views" | "group-procedures", key: string, child: TreeNode): TreeNode {
  return {
    id: `pg-1:app:public:${key}`,
    label: type === "group-views" ? "tree.views" : "tree.procedures",
    type,
    connectionId: "pg-1",
    database: "app",
    schema: "public",
    isExpanded: true,
    objectCount: 7,
    children: [child],
  };
}

function column(name: string) {
  return {
    name,
    data_type: "VARCHAR",
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    extra: null,
    comment: null,
    numeric_precision: null,
    numeric_scale: null,
    character_maximum_length: 255,
  };
}

function installApiMocks(options?: { getColumns?: ReturnType<typeof vi.fn>; listTables?: ReturnType<typeof vi.fn>; listObjects?: ReturnType<typeof vi.fn>; listTriggers?: ReturnType<typeof vi.fn> }) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    getColumns: options?.getColumns ?? vi.fn().mockResolvedValue([]),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    listObjects: options?.listObjects ?? vi.fn().mockResolvedValue([]),
    listTables: options?.listTables ?? vi.fn().mockResolvedValue([]),
    listTriggers: options?.listTriggers ?? vi.fn().mockResolvedValue([]),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
}

async function createStore(root: TreeNode) {
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  const store = useConnectionStore();
  useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";
  const connection = postgresConnection();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  store.treeNodes = [{ id: connection.id, label: connection.name, type: "connection", connectionId: connection.id, isExpanded: true, children: [root] }];
  return store;
}

describe("connectionStore tree refresh state", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("preserves an object group count while rebuilding grouped placeholders", async () => {
    installApiMocks();
    const oldView: TreeNode = { id: "pg-1:app:public:old_view", label: "old_view", type: "view", connectionId: "pg-1", database: "app", schema: "public" };
    const root = schemaNode([objectGroup("group-views", "__views", oldView)]);
    root.children![0]!.isExpanded = false;
    const store = await createStore(root);

    await store.loadTreeNodeChildren(root, { force: true });

    expect(root.children?.find((child) => child.type === "group-views")?.objectCount).toBe(7);
  });

  it("rolls back tree data and loaded markers when an expanded child refresh fails", async () => {
    const listTables = vi.fn().mockResolvedValue([{ name: "fresh_view", table_type: "VIEW", comment: null }]);
    const listObjects = vi.fn().mockRejectedValue(new Error("metadata denied"));
    installApiMocks({ listTables, listObjects });

    const oldView: TreeNode = { id: "pg-1:app:public:old_view", label: "old_view", type: "view", connectionId: "pg-1", database: "app", schema: "public" };
    const oldProcedure: TreeNode = { id: "pg-1:app:public:old_procedure", label: "old_procedure", type: "procedure", connectionId: "pg-1", database: "app", schema: "public" };
    const root = schemaNode([objectGroup("group-views", "__views", oldView), objectGroup("group-procedures", "__procedures", oldProcedure)]);
    const hiddenChildren: TreeNode[] = [{ id: "pg-1:app:public:hidden", label: "hidden", type: "view", connectionId: "pg-1", database: "app", schema: "public" }];
    root.hiddenChildren = hiddenChildren;
    root.objectCount = 42;
    const store = await createStore(root);

    await store.loadTreeNodeChildren(root, { force: true });
    const previousChildren = root.children;
    const viewsGroupId = root.children!.find((child) => child.type === "group-views")!.id;
    const proceduresGroupId = root.children!.find((child) => child.type === "group-procedures")!.id;
    expect(store.isTreeNodeChildrenLoaded(root.id)).toBe(true);
    expect(store.isTreeNodeChildrenLoaded(viewsGroupId)).toBe(false);

    await expect(store.refreshTreeNode(root)).rejects.toThrow("metadata denied");

    expect(listTables).toHaveBeenCalledOnce();
    expect(listObjects).toHaveBeenCalledOnce();
    expect(root.children).toBe(previousChildren);
    expect(root.hiddenChildren).toBe(hiddenChildren);
    expect(root.objectCount).toBe(42);
    expect(root.children?.find((child) => child.type === "group-views")?.children?.map((child) => child.label)).toEqual(["old_view"]);
    expect(root.children?.find((child) => child.type === "group-procedures")?.children?.map((child) => child.label)).toEqual(["old_procedure"]);
    expect(store.isTreeNodeChildrenLoaded(root.id)).toBe(true);
    expect(store.isTreeNodeChildrenLoaded(viewsGroupId)).toBe(false);
    expect(store.isTreeNodeChildrenLoaded(proceduresGroupId)).toBe(false);
  });

  it("reloads completion columns after refreshing their schema tree", async () => {
    const getColumns = vi
      .fn()
      .mockResolvedValueOnce([column("id")])
      .mockResolvedValueOnce([column("id"), column("new_column")]);
    const listTables = vi.fn().mockResolvedValue([{ name: "users", table_type: "BASE TABLE", comment: null }]);
    installApiMocks({ getColumns, listTables });
    const root = schemaNode([]);
    const store = await createStore(root);

    await expect(store.listCompletionColumns("pg-1", "app", "users", "public")).resolves.toEqual([expect.objectContaining({ name: "id" })]);

    await store.refreshTreeNode(root);

    await expect(store.listCompletionColumns("pg-1", "app", "users", "public")).resolves.toEqual([expect.objectContaining({ name: "id" }), expect.objectContaining({ name: "new_column" })]);
    expect(getColumns).toHaveBeenCalledTimes(2);
    expect(store.completionCacheRevision("pg-1", "app")).toBeGreaterThan(0);
  });

  it("refreshes a table-level trigger group using listTriggers without wiping triggers", async () => {
    const listTriggers = vi.fn().mockResolvedValue([{ name: "trg_orders_audit", timing: "AFTER", event: "UPDATE", enabled: false }]);
    const listObjects = vi.fn().mockResolvedValue([]);
    installApiMocks({ listTriggers, listObjects });

    const triggerGroup: TreeNode = {
      id: "pg-1:app:public:orders:__triggers",
      label: "tree.triggers",
      type: "group-triggers",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "orders",
      isExpanded: true,
      children: [],
    };
    const table: TreeNode = {
      id: "pg-1:app:public:orders",
      label: "orders",
      type: "table",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "orders",
      isExpanded: true,
      children: [triggerGroup],
    };
    const root = schemaNode([table]);
    const store = await createStore(root);

    await store.refreshTreeNode(triggerGroup);

    expect(listTriggers).toHaveBeenCalledWith("pg-1", "app", "public", "orders", undefined);
    expect(listObjects).not.toHaveBeenCalled();
    expect(triggerGroup.objectCount).toBe(1);
    expect(triggerGroup.children).toHaveLength(1);
    expect(triggerGroup.children![0]).toMatchObject({
      id: "pg-1:app:public:orders:__triggers:trg_orders_audit",
      type: "trigger",
      tableName: "orders",
      meta: { name: "trg_orders_audit", enabled: false },
    });
  });

  it("refreshes the parent table trigger group when refreshing a child trigger node", async () => {
    const listTriggers = vi.fn().mockResolvedValue([{ name: "trg_orders_audit", timing: "AFTER", event: "UPDATE", enabled: true }]);
    installApiMocks({ listTriggers });

    const triggerChild: TreeNode = {
      id: "pg-1:app:public:orders:__triggers:trg_orders_audit",
      label: "trg_orders_audit (AFTER UPDATE)",
      type: "trigger",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "orders",
      meta: { name: "trg_orders_audit", enabled: false },
    };
    const triggerGroup: TreeNode = {
      id: "pg-1:app:public:orders:__triggers",
      label: "tree.triggers",
      type: "group-triggers",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "orders",
      isExpanded: true,
      children: [triggerChild],
    };
    const table: TreeNode = {
      id: "pg-1:app:public:orders",
      label: "orders",
      type: "table",
      connectionId: "pg-1",
      database: "app",
      schema: "public",
      tableName: "orders",
      isExpanded: true,
      children: [triggerGroup],
    };
    const root = schemaNode([table]);
    const store = await createStore(root);

    await store.refreshTreeNode(triggerChild);

    expect(listTriggers).toHaveBeenCalledWith("pg-1", "app", "public", "orders", undefined);
    expect(triggerGroup.children![0].meta).toMatchObject({
      name: "trg_orders_audit",
      enabled: true,
    });
  });
});

describe("connection node refresh awaits object cache invalidation", () => {
  function installConnectionApiMocks(options?: {
    deleteSchemaCachePrefix?: ReturnType<typeof vi.fn>;
    getColumns?: ReturnType<typeof vi.fn>;
    getTableDisplayDdl?: ReturnType<typeof vi.fn>;
    listDatabases?: ReturnType<typeof vi.fn>;
    listSchemaInfos?: ReturnType<typeof vi.fn>;
    listObjects?: ReturnType<typeof vi.fn>;
    saveSchemaCache?: ReturnType<typeof vi.fn>;
  }) {
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: options?.deleteSchemaCachePrefix ?? vi.fn().mockResolvedValue(undefined),
      getColumns: options?.getColumns ?? vi.fn().mockResolvedValue([]),
      getTableDisplayDdl: options?.getTableDisplayDdl ?? vi.fn().mockResolvedValue("CREATE TABLE users (id int)"),
      listDatabases: options?.listDatabases ?? vi.fn().mockResolvedValue([{ name: "app", comment: null }]),
      listInstalledAgents: vi.fn().mockResolvedValue([]),
      listObjects: options?.listObjects ?? vi.fn().mockResolvedValue([]),
      listSchemas: vi.fn().mockResolvedValue(["public"]),
      listSchemaInfos: options?.listSchemaInfos ?? vi.fn().mockResolvedValue([{ name: "public", comment: null }]),
      listTables: vi.fn().mockResolvedValue([]),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSchemaCache: options?.saveSchemaCache ?? vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));
  }

  /** A database node under the connection node: refresh reloads it via listSchemaInfos. */
  function databaseNode(): TreeNode {
    return { id: "pg-1:app", label: "app", type: "database", connectionId: "pg-1", database: "app", isExpanded: true, children: [] };
  }

  async function createStoreWithConnection(connectionId = "pg-1", globalObjectSearchEnabled = true) {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const store = useConnectionStore();
    useSettingsStore().editorSettings.sidebarObjectDisplay = "grouped";
    useSettingsStore().isEditorSettingsLoaded = true;
    useSettingsStore().editorSettings.globalObjectSearchEnabled = globalObjectSearchEnabled;
    const connection: ConnectionConfig = {
      ...postgresConnection(),
      id: connectionId,
    };
    store.connections = [connection];
    store.connectedIds.add(connection.id);
    const connectionNode: TreeNode = {
      id: connection.id,
      label: connection.name,
      type: "connection",
      connectionId: connection.id,
      isExpanded: true,
      children: [],
    };
    store.treeNodes = [connectionNode];
    return { store, connectionNode };
  }

  function objectCacheDeletePrefixes(mock: ReturnType<typeof vi.fn>): string[] {
    return mock.mock.calls.filter(([prefix]) => (prefix as string).startsWith("object-")).map(([prefix]) => prefix as string);
  }

  /** A prefix-deletion mock whose object-cache deletions share one deferred gate. */
  function gatedObjectCacheDeletes() {
    const deleteSchemaCachePrefix = vi.fn((prefix: string) => {
      if (!prefix.startsWith("object-")) return Promise.resolve();
      return gate.then(() => undefined);
    });
    let resolveGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    return { deleteSchemaCachePrefix, releaseObjectCacheDeletes: () => resolveGate() };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("does not build object indexes from connection, toolbar, or explicit index refresh while disabled", async () => {
    const listObjects = vi.fn().mockResolvedValue([]);
    installConnectionApiMocks({ listObjects });
    const { store, connectionNode } = await createStoreWithConnection("pg-1", false);
    await store.refreshConnectionTreeNode(connectionNode);
    await store.refreshAllTree();
    await store.refreshSidebarObjectIndex();
    expect(listObjects).not.toHaveBeenCalled();
    expect(store.sidebarObjectIndexes).toEqual({});
    expect(store.sidebarObjectIndexStatuses).toEqual({});
  });

  it("restores an enabled preference without connecting or discovering objects at startup", async () => {
    const listObjects = vi.fn().mockResolvedValue([]);
    const listDatabases = vi.fn().mockResolvedValue([{ name: "app" }]);
    installConnectionApiMocks({ listObjects, listDatabases });
    await createStoreWithConnection("pg-1", false);
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settings = useSettingsStore();
    settings.isEditorSettingsLoaded = false;
    settings.editorSettings.globalObjectSearchEnabled = true;
    settings.isEditorSettingsLoaded = true;
    const api = await import("@/lib/backend/api");
    await vi.waitFor(() => expect(api.loadSchemaCache).toHaveBeenCalledWith("sidebar-object-index-v1:pg-1:"));
    expect(listObjects).not.toHaveBeenCalled();
    expect(listDatabases).not.toHaveBeenCalled();
  });

  it("starts indexing when enabled and keeps the cached index when disabled again", async () => {
    const listObjects = vi.fn().mockResolvedValue([{ name: "orders", object_type: "TABLE" }]);
    installConnectionApiMocks({ listObjects });
    const { store, connectionNode } = await createStoreWithConnection("pg-1", false);
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settings = useSettingsStore();
    settings.editorSettings.globalObjectSearchEnabled = true;
    await store.refreshSidebarObjectIndex();
    expect(store.sidebarObjectIndexStatuses["pg-1"]).toBe("ready");
    expect(store.globalObjectSearchEnabled).toBe(true);
    const cached = store.sidebarObjectIndexes["pg-1"];
    settings.editorSettings.globalObjectSearchEnabled = false;
    listObjects.mockClear();
    await store.refreshConnectionTreeNode(connectionNode);
    expect(store.globalObjectSearchEnabled).toBe(false);
    expect(listObjects).not.toHaveBeenCalled();
    expect(store.sidebarObjectIndexes["pg-1"]).toBe(cached);
  });

  it.each(["connection", "all"] as const)("rebuilds and persists the object index during %s refresh", async (scope) => {
    const listObjects = vi.fn().mockResolvedValue([{ name: "old_table", object_type: "TABLE" }]);
    const saveSchemaCache = vi.fn().mockResolvedValue(undefined);
    installConnectionApiMocks({ listObjects, saveSchemaCache });
    const { store, connectionNode } = await createStoreWithConnection();
    const { useSettingsStore } = await import("@/stores/settingsStore");
    const settings = useSettingsStore();
    await store.refreshSidebarObjectIndex("pg-1");
    settings.editorSettings.sidebarGlobalSearchLocal = false;
    store.activeConnectionId = "other";
    const other = { ...postgresConnection(), id: "other" };
    store.connections.push(other);
    store.connectedIds.add(other.id);
    // The toolbar refresh must also rebuild indexes for collapsed connections.
    store.treeNodes.push({ id: other.id, connectionId: other.id, label: "Other", type: "connection", isExpanded: false, children: [] });
    listObjects.mockClear();
    saveSchemaCache.mockClear();

    let finishIndex!: (objects: Array<{ name: string; object_type: string }>) => void;
    listObjects.mockReturnValue(new Promise((resolve) => (finishIndex = resolve)));
    let settled = false;
    const refresh = (scope === "connection" ? store.refreshConnectionTreeNode(connectionNode) : store.refreshAllTree()).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(store.sidebarObjectIndexStatuses["pg-1"]).toBe("building"));
    expect(settled).toBe(false);
    finishIndex([{ name: "new_table", object_type: "TABLE" }]);
    await refresh;

    const refreshedIds = scope === "connection" ? ["pg-1"] : ["other", "pg-1"];
    expect(listObjects.mock.calls.map(([id]) => id).sort()).toEqual(refreshedIds);
    for (const id of refreshedIds) {
      expect(store.sidebarObjectIndexes[id]?.scopes.flatMap((entry) => entry.objects.map((object) => object.name))).toEqual(["new_table"]);
      expect(store.sidebarObjectIndexStatuses[id]).toBe("ready");
      expect(saveSchemaCache).toHaveBeenCalledWith(`sidebar-object-index-v1:${id}:`, expect.objectContaining({ connectionId: id, complete: true }));
    }
    expect(settings.editorSettings.sidebarGlobalSearchLocal).toBe(false);
    expect(store.activeConnectionId).toBe("other");
  });

  it.each(["connection", "all"] as const)("keeps the previous object index and marks failed scopes incomplete during %s refresh", async (scope) => {
    const listObjects = vi.fn().mockResolvedValue([{ name: "old_table", object_type: "TABLE" }]);
    installConnectionApiMocks({ listObjects });
    const { store, connectionNode } = await createStoreWithConnection();
    await store.refreshSidebarObjectIndex("pg-1");
    listObjects.mockRejectedValue(new Error("metadata denied"));

    await (scope === "connection" ? store.refreshConnectionTreeNode(connectionNode) : store.refreshAllTree());

    expect(store.sidebarObjectIndexStatuses["pg-1"]).toBe("incomplete");
    expect(store.sidebarObjectIndexes["pg-1"]?.scopes[0]?.objects.map((object) => object.name)).toEqual(["old_table"]);
  });

  it("builds indexes without expanded nodes and skips temporary and unsupported connections", async () => {
    const listObjects = vi.fn().mockResolvedValue([{ name: "new_table", object_type: "TABLE" }]);
    installConnectionApiMocks({ listObjects });
    const { store, connectionNode } = await createStoreWithConnection();
    connectionNode.isExpanded = false;
    store.connections.push({ ...postgresConnection(), id: "temporary", one_time: true }, { ...postgresConnection(), id: "redis", db_type: "redis" });

    await store.refreshAllTree();

    expect(listObjects.mock.calls.map(([id]) => id)).toEqual(["pg-1"]);
    expect(Object.keys(store.sidebarObjectIndexes)).toEqual(["pg-1"]);
    expect(store.treeNodes[0]?.isExpanded).toBe(false);
  });

  it("blocks the tree reload until both object cache deletions settle", async () => {
    const { deleteSchemaCachePrefix, releaseObjectCacheDeletes } = gatedObjectCacheDeletes();
    const listDatabases = vi.fn().mockResolvedValue([{ name: "app", comment: null }]);
    installConnectionApiMocks({ deleteSchemaCachePrefix, listDatabases });
    const { store, connectionNode } = await createStoreWithConnection();

    let settled = false;
    const refresh = store.refreshConnectionTreeNode(connectionNode).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).length).toBe(2));
    expect(settled).toBe(false);
    expect(listDatabases).not.toHaveBeenCalled();

    releaseObjectCacheDeletes();
    await refresh;
    // One tree reload plus one object-index inventory.
    expect(listDatabases).toHaveBeenCalledTimes(2);
    expect(listDatabases).toHaveBeenCalledWith("pg-1");
  });

  it("issues exactly one object-cache deletion per namespace on a connection refresh", async () => {
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    installConnectionApiMocks({ deleteSchemaCachePrefix });
    const { store, connectionNode } = await createStoreWithConnection();

    await store.refreshConnectionTreeNode(connectionNode);

    expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).sort()).toEqual(["object-ddl:v1:pg-1:", "object-meta:v1:pg-1:"]);
  });

  it("lets concurrent connection refreshes share the pending deletions", async () => {
    const { deleteSchemaCachePrefix, releaseObjectCacheDeletes } = gatedObjectCacheDeletes();
    installConnectionApiMocks({ deleteSchemaCachePrefix });
    const { store, connectionNode } = await createStoreWithConnection();

    const first = store.refreshConnectionTreeNode(connectionNode);
    const second = store.refreshConnectionTreeNode(connectionNode);
    await vi.waitFor(() => expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).length).toBe(2));

    releaseObjectCacheDeletes();
    await Promise.all([first, second]);
    expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix)).toHaveLength(2);
  });

  it("rejects with the object cache error and skips the tree reload when deletion fails", async () => {
    const deleteSchemaCachePrefix = vi.fn((prefix: string) => (prefix.startsWith("object-") ? Promise.reject(new Error("sqlite locked")) : Promise.resolve()));
    const listDatabases = vi.fn().mockResolvedValue([{ name: "app", comment: null }]);
    installConnectionApiMocks({ deleteSchemaCachePrefix, listDatabases });
    const { store, connectionNode } = await createStoreWithConnection();
    const previousChildren = connectionNode.children;

    const failure = await store.refreshConnectionTreeNode(connectionNode).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isObjectCacheInvalidationError(failure)).toBe(true);
    expect((failure as Error).message).toBe("sqlite locked");
    expect(listDatabases).not.toHaveBeenCalled();
    expect(connectionNode.children).toBe(previousChildren);
  });

  it("retries the deletion and completes the tree reload on a subsequent refresh", async () => {
    let objectDeletionFailures = 2;
    const deleteSchemaCachePrefix = vi.fn((prefix: string) => {
      if (!prefix.startsWith("object-")) return Promise.resolve();
      return objectDeletionFailures-- > 0 ? Promise.reject(new Error("locked")) : Promise.resolve();
    });
    const listDatabases = vi.fn().mockResolvedValue([{ name: "app", comment: null }]);
    installConnectionApiMocks({ deleteSchemaCachePrefix, listDatabases });
    const { store, connectionNode } = await createStoreWithConnection();

    await expect(store.refreshConnectionTreeNode(connectionNode)).rejects.toThrow("locked");
    expect(listDatabases).not.toHaveBeenCalled();

    await expect(store.refreshConnectionTreeNode(connectionNode)).resolves.toBeUndefined();
    expect(listDatabases).toHaveBeenCalledTimes(2);
  });

  it("encodes connection ids in the invalidated object cache prefixes", async () => {
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    installConnectionApiMocks({ deleteSchemaCachePrefix });
    const { store, connectionNode } = await createStoreWithConnection("pg:1");

    await store.refreshConnectionTreeNode(connectionNode);

    expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).sort()).toEqual(["object-ddl:v1:pg%3A1:", "object-meta:v1:pg%3A1:"]);
  });

  it("keeps non-connection node refresh best-effort when the object deletion fails", async () => {
    const deleteSchemaCachePrefix = vi.fn((prefix: string) => (prefix.startsWith("object-") ? Promise.reject(new Error("locked")) : Promise.resolve()));
    const listSchemaInfos = vi.fn().mockResolvedValue([{ name: "public", comment: null }]);
    installConnectionApiMocks({ deleteSchemaCachePrefix, listSchemaInfos });
    const { store } = await createStoreWithConnection();
    const database = databaseNode();
    store.treeNodes[0]!.children = [database];

    await expect(store.refreshTreeNode(database)).resolves.toBeUndefined();
    // The tree still reloads even though the object-cache deletion failed.
    expect(listSchemaInfos).toHaveBeenCalledTimes(1);
    expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).sort()).toEqual(["object-ddl:v1:pg-1:app:", "object-meta:v1:pg-1:app:"]);
  });

  it("does not fetch object DDL or column metadata during a connection refresh", async () => {
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    const getTableDisplayDdl = vi.fn();
    const getColumns = vi.fn();
    installConnectionApiMocks({ deleteSchemaCachePrefix, getTableDisplayDdl, getColumns });
    const { store, connectionNode } = await createStoreWithConnection();

    await store.refreshConnectionTreeNode(connectionNode);

    expect(getTableDisplayDdl).not.toHaveBeenCalled();
    expect(getColumns).not.toHaveBeenCalled();
  });

  it("routes non-connection nodes to the regular refresh path", async () => {
    const deleteSchemaCachePrefix = vi.fn().mockResolvedValue(undefined);
    installConnectionApiMocks({ deleteSchemaCachePrefix });
    const { store } = await createStoreWithConnection();
    const database = databaseNode();
    store.treeNodes[0]!.children = [database];

    await expect(store.refreshConnectionTreeNode(database)).resolves.toBeUndefined();
    expect(objectCacheDeletePrefixes(deleteSchemaCachePrefix).sort()).toEqual(["object-ddl:v1:pg-1:app:", "object-meta:v1:pg-1:app:"]);
  });
});
