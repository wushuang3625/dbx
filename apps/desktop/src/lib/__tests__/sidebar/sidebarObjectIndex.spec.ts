import { describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, ObjectInfo, TreeNode } from "@/types/database";
import { buildSidebarObjectIndex, createSidebarObjectIndexes, mergeSidebarObjectIndexHits, supportsSidebarObjectIndex } from "@/lib/sidebar/sidebarObjectIndex";
import { filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import { buildGroupedObjectTreeNodes, buildTableTreeNodes, mergeTableInfosIntoObjects } from "@/lib/table/tableTree";

type IndexApi = Parameters<typeof createSidebarObjectIndexes>[0]["api"];
const config = (id = "first", extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ id, name: `Connection ${id}`, db_type: "mysql", host: "localhost", port: 3306, username: "reader", password: "not-persisted", database: "app", ...extra }) as ConnectionConfig;
const object = (name: string, object_type = "TABLE", extra: Partial<ObjectInfo> = {}): ObjectInfo => ({ name, object_type, ...extra });
function fixtures(isEnabled = () => true) {
  const disk = new Map<string, unknown>();
  const api = {
    listDatabases: vi.fn(async () => [{ name: "app" }]),
    listSchemas: vi.fn(async () => ["public"]),
    listObjects: vi.fn<IndexApi["listObjects"]>(async () => [object("orders")]),
    listDorisCatalogs: vi.fn(async () => []),
    listDorisCatalogDatabases: vi.fn(async () => [{ name: "app" }]),
    loadSchemaCache: vi.fn(async (key: string) => disk.get(key) ?? null) as IndexApi["loadSchemaCache"],
    saveSchemaCache: vi.fn(async (key: string, value: unknown) => {
      disk.set(key, structuredClone(value));
    }),
    deleteSchemaCachePrefix: vi.fn(async (prefix: string) => {
      for (const key of disk.keys()) if (key.startsWith(prefix)) disk.delete(key);
    }),
  };
  const configs = new Map([["first", config()]]);
  const ensureConnected = vi.fn(async (_id: string) => undefined);
  const create = () => createSidebarObjectIndexes({ api, isEnabled, getConfig: (id) => configs.get(id), ensureConnected });
  return { api, disk, configs, ensureConnected, create };
}
const root = (id: string, children: TreeNode[] = []): TreeNode => ({ id, connectionId: id, label: `Connection ${id}`, type: "connection", children, isExpanded: false });
const flatten = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("durable sidebar object indexes", () => {
  it("skips hydration and refresh while disabled and resumes after cancelled work", async () => {
    let enabled = false;
    const { create, api, ensureConnected } = fixtures(() => enabled);
    const manager = create();
    await manager.hydrate("first");
    await manager.refresh("first");
    expect(api.loadSchemaCache).not.toHaveBeenCalled();
    expect(ensureConnected).not.toHaveBeenCalled();
    enabled = true;
    await manager.refresh("first");
    const previous = manager.indexes.value.first;
    const pending = deferred<ObjectInfo[]>();
    api.listObjects.mockReturnValueOnce(pending.promise);
    const refresh = manager.refresh("first");
    await vi.waitFor(() => expect(api.listObjects).toHaveBeenCalledTimes(2));
    enabled = false;
    manager.pause();
    pending.resolve([object("stale")]);
    await refresh;
    expect(manager.indexes.value.first).toBe(previous);
    expect(manager.statuses.value.first).toBe("ready");
    enabled = true;
    api.listObjects.mockResolvedValue([object("fresh")]);
    await manager.refresh("first");
    expect(manager.indexes.value.first.scopes[0].objects.map((item) => item.name)).toEqual(["fresh"]);
  });
  it.each([true, false])("merges indexed MySQL tables with live listTables nodes while retaining live state (grouped=%s)", async (grouped) => {
    const { api } = fixtures();
    api.listObjects.mockResolvedValue([object("data_monitor_v3", "TABLE", { schema: "app" }), object("data_monitor_v3_detail", "TABLE", { schema: "app" })]);
    const index = await buildSidebarObjectIndex(config(), api);
    const tables = [{ name: "data_monitor_v3", table_type: "TABLE" }];
    const args = { nodeId: "first:app", connectionId: "first", database: "app" };
    const children = grouped ? buildGroupedObjectTreeNodes({ ...args, objects: mergeTableInfosIntoObjects([], tables) }) : buildTableTreeNodes({ ...args, tables });
    const liveTable = flatten(children).find((node) => node.type === "table")!;
    liveTable.isExpanded = true;
    liveTable.children = [{ id: `${liveTable.id}:columns`, type: "column", label: "id", isExpanded: false }];
    const tree = [root("first", [{ ...args, id: args.nodeId, type: "database", label: "app", isExpanded: true, children } as TreeNode])];
    const original = structuredClone(tree);

    for (const regexMode of [false, true]) {
      const query = regexMode ? "^data_monitor_v3" : "data_monitor_v3";
      const projected = mergeSidebarObjectIndexHits(tree, [index], query, grouped, regexMode);
      const hits = flatten(filterSidebarTree(projected, query, new Set(), undefined, { regexMode })).filter((node) => node.type === "table");
      expect(hits.map((node) => node.label)).toEqual(["data_monitor_v3", "data_monitor_v3_detail"]);
      expect(hits[0]).toEqual(liveTable);
      expect(flatten(mergeSidebarObjectIndexHits(projected, [index], query, grouped, regexMode)).filter((node) => node.type === "table")).toHaveLength(2);
    }
    expect(tree).toEqual(original);
    expect(mergeSidebarObjectIndexHits(tree, [index], "", grouped)).toEqual(tree);
  });

  it("reads every database and every page, preserving views, routines and overloads without data payloads", async () => {
    const { api } = fixtures();
    api.listDatabases.mockResolvedValue([{ name: "app" }, { name: "warehouse" }, { name: "mysql" }]);
    api.listObjects.mockImplementation(async (_id, database, _schema, _types, _filter, limit, offset) => {
      expect(limit).toBe(1000);
      if (database === "warehouse") return [object("report", "VIEW")];
      return offset === 0
        ? Array.from({ length: 1000 }, (_, i) => object(`t${i}`))
        : [object("convert", "FUNCTION", { signature: "int", comment: "conversion" }), object("convert", "FUNCTION", { signature: "text" }), { ...object("run", "PROCEDURE"), rows: ["sensitive"], ddl: "secret" } as ObjectInfo];
    });
    const index = await buildSidebarObjectIndex(config(), api);
    expect(index.complete).toBe(true);
    expect(index.scopes.map((scope) => scope.database)).toEqual(["app", "warehouse"]);
    expect(index.scopes[0].objects).toHaveLength(1003);
    expect(index.scopes[1].objects[0].object_type).toBe("VIEW");
    expect(api.listObjects).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(index)).not.toMatch(/not-persisted|sensitive|secret|username/);
    expect(api.listObjects.mock.calls[0][3]).toEqual(["TABLE", "VIEW", "PROCEDURE", "FUNCTION"]);
  });

  it("enumerates PostgreSQL schemas while respecting configured database/schema visibility", async () => {
    const { api } = fixtures();
    api.listDatabases.mockResolvedValue([{ name: "app" }, { name: "hidden" }]);
    api.listSchemas.mockResolvedValue(["public", "reports", "pg_catalog"]);
    const index = await buildSidebarObjectIndex(config("first", { db_type: "postgres", visible_databases: ["app"], visible_schemas: { app: ["reports"] } }), api);
    expect(index.scopes.map((scope) => [scope.database, scope.schema])).toEqual([["app", "reports"]]);
    expect(api.listSchemas).toHaveBeenCalledTimes(1);
    expect(api.listObjects.mock.calls[0].slice(0, 3)).toEqual(["first", "app", "reports"]);
  });

  it("uses Oracle root schemas and the existing node identity", async () => {
    const { api } = fixtures();
    api.listSchemas.mockResolvedValue(["READER", "SYS"]);
    const index = await buildSidebarObjectIndex(config("first", { db_type: "oracle" }), api);
    expect(api.listDatabases).not.toHaveBeenCalled();
    expect(index.scopes).toHaveLength(1);
    expect(index.scopes[0].path.at(-1)?.id).toBe("first:READER:READER");
    expect(api.listObjects.mock.calls[0].slice(0, 3)).toEqual(["first", "READER", "READER"]);
  });

  it("retains failed scopes, replaces successful scopes, and removes deleted objects on refresh", async () => {
    const { api } = fixtures();
    api.listDatabases.mockResolvedValue([{ name: "app" }, { name: "other" }]);
    const previous = await buildSidebarObjectIndex(config(), api);
    api.listObjects.mockImplementation(async (_id, database) => {
      if (database === "other") throw new Error("access denied");
      return [object("new_table")];
    });
    const next = await buildSidebarObjectIndex(config(), api, previous);
    expect(next.complete).toBe(false);
    expect(next.scopes.map((scope) => scope.objects.map((entry) => entry.name))).toEqual([["new_table"], ["orders"]]);
  });

  it("detects drivers that repeat pages instead of looping or claiming completeness", async () => {
    const { api } = fixtures();
    api.listObjects.mockResolvedValue(Array.from({ length: 1000 }, (_, i) => object(`t${i}`)));
    const index = await buildSidebarObjectIndex(config(), api);
    expect(index.complete).toBe(false);
    expect(index.scopes[0].objects).toHaveLength(1000);
    expect(api.listObjects).toHaveBeenCalledTimes(2);
  });

  it("hydrates old indexes across restarts without expiration, connecting or discovery requests", async () => {
    const { api, ensureConnected, disk, create } = fixtures();
    const first = create();
    await first.refresh("first");
    for (const value of disk.values()) (value as { indexedAt: number }).indexedAt = 1;
    vi.clearAllMocks();
    const restarted = create();
    await restarted.hydrate("first");
    expect(restarted.indexes.value.first.indexedAt).toBe(1);
    expect(restarted.statuses.value.first).toBe("ready");
    expect(ensureConnected).not.toHaveBeenCalled();
    expect(api.listDatabases).not.toHaveBeenCalled();
    expect(api.listObjects).not.toHaveBeenCalled();
  });

  it("keeps a good persistent index when connection/discovery/storage refresh fails", async () => {
    const { api, ensureConnected, disk, create } = fixtures();
    const service = create();
    await service.refresh("first");
    const previous = service.indexes.value.first;
    ensureConnected.mockRejectedValueOnce(new Error("offline"));
    await service.refresh("first");
    expect(service.indexes.value.first).toBe(previous);
    expect(service.statuses.value.first).toBe("failed");
    expect([...disk.values()][0]).toEqual(previous);
    api.listDatabases.mockRejectedValueOnce(new Error("not authorized"));
    await service.refresh("first");
    expect(service.indexes.value.first).toBe(previous);
    api.saveSchemaCache.mockRejectedValueOnce(new Error("disk full"));
    await service.refresh("first");
    expect(service.indexes.value.first).toBe(previous);
  });

  it("rejects persisted indexes bound to a different endpoint or visibility configuration", async () => {
    const { configs, create } = fixtures();
    await create().refresh("first");
    configs.set("first", config("first", { host: "another-host" }));
    const restarted = create();
    await restarted.hydrate("first");
    expect(restarted.indexes.value.first).toBeUndefined();
  });

  it("does not resurrect a deleted index when an old build completes", async () => {
    const { api, configs, create, disk } = fixtures();
    const pending = deferred<ObjectInfo[]>();
    api.listObjects.mockReturnValue(pending.promise);
    const service = create();
    const task = service.refresh("first");
    await vi.waitFor(() => expect(api.listObjects).toHaveBeenCalled());
    configs.delete("first");
    await service.invalidate("first");
    pending.resolve([object("late")]);
    await task;
    expect(service.indexes.value.first).toBeUndefined();
    expect(service.statuses.value.first).toBeUndefined();
    expect(disk.size).toBe(0);
    expect(api.saveSchemaCache).not.toHaveBeenCalled();
  });

  it("serializes deletion after an already-started disk write", async () => {
    const { api, create, disk } = fixtures();
    const saved = deferred<void>();
    api.saveSchemaCache.mockImplementation(async (key, value) => {
      await saved.promise;
      disk.set(key, value);
    });
    const service = create();
    const task = service.refresh("first");
    await vi.waitFor(() => expect(api.saveSchemaCache).toHaveBeenCalled());
    const deletion = service.invalidate("first");
    saved.resolve();
    await Promise.all([task, deletion]);
    expect(disk.size).toBe(0);
    expect(service.indexes.value.first).toBeUndefined();
  });

  it("coalesces repeated builds and bounds cross-connection background work", async () => {
    const { ensureConnected, configs, create } = fixtures();
    const connection = deferred<void>();
    ensureConnected.mockReturnValue(connection.promise);
    configs.set("second", config("second"));
    configs.set("third", config("third"));
    const service = create();
    const first = service.refresh("first");
    expect(service.refresh("first")).toBe(first);
    const second = service.refresh("second");
    const third = service.refresh("third");
    await vi.waitFor(() => expect(ensureConnected).toHaveBeenCalledTimes(2));
    connection.resolve();
    await Promise.all([first, second, third]);
    expect(ensureConnected).toHaveBeenCalledTimes(3);
    expect(Object.values(service.statuses.value)).toEqual(["ready", "ready", "ready"]);
  });

  it("searches inactive/disconnected connections inside groups, including functions and regex hits, without mutating the tree", async () => {
    const { api } = fixtures();
    api.listObjects.mockResolvedValue([object("convert", "FUNCTION", { signature: "int" }), object("convert", "FUNCTION", { signature: "text" }), object("orders_view", "VIEW")]);
    const indexes = await Promise.all([buildSidebarObjectIndex(config(), api), buildSidebarObjectIndex(config("second"), api)]);
    const tree: TreeNode[] = [{ id: "group", type: "connection-group", label: "Group", isExpanded: false, children: [root("first"), root("second")] }];
    for (const grouped of [true, false]) {
      const projected = mergeSidebarObjectIndexHits(tree, indexes, "convert", grouped);
      const filtered = filterSidebarTree(projected, "convert", new Set());
      expect(flatten(filtered).filter((node) => node.type === "function")).toHaveLength(4);
      expect(
        new Set(
          flatten(filtered)
            .filter((node) => node.type === "function")
            .map((node) => node.id),
        ).size,
      ).toBe(4);
    }
    const regex = filterSidebarTree(mergeSidebarObjectIndexHits(tree, indexes, "^orders_", true, true), "^orders_", new Set(), undefined, { regexMode: true });
    expect(flatten(regex).filter((node) => node.type === "view")).toHaveLength(2);
    expect(flatten(tree)).toHaveLength(3);
    expect(tree[0].isExpanded).toBe(false);
  });

  it("skips unsupported services and ephemeral connections", async () => {
    const { configs, ensureConnected, create } = fixtures();
    for (const connection of [config("redis", { db_type: "redis" }), config("once", { one_time: true })]) {
      configs.set(connection.id, connection);
      expect(supportsSidebarObjectIndex(connection)).toBe(false);
      await create().refresh(connection.id);
    }
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps Firebird internal and UDF functions searchable (grouped=%s)", async (grouped) => {
    const { api } = fixtures();
    api.listObjects.mockResolvedValue([object("custom_internal", "FUNCTION_INTERNAL"), object("custom_udf", "FUNCTION_UDF")]);
    const index = await buildSidebarObjectIndex(config("first", { db_type: "firebird" }), api);
    const results = filterSidebarTree(mergeSidebarObjectIndexHits([root("first")], [index], "custom", grouped), "custom", new Set());
    expect(flatten(results).filter((node) => node.type === "function")).toHaveLength(2);
  });
});
