// @vitest-environment happy-dom

import { createPinia, setActivePinia } from "pinia";
import { reactive, shallowRef } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const config = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ id: "pg", name: "PG", db_type: "postgres", host: "localhost", port: 5432, username: "reader", password: "never-persist-this-password", database: "app", ...extra }) as ConnectionConfig;
const column = (name: string) => ({ name, data_type: "text", is_nullable: true, comment: "A column", column_default: "never-persist-this-default", is_primary_key: false });

async function setup(disk = new Map<string, unknown>(), connection = config()) {
  vi.resetModules();
  setActivePinia(createPinia());
  const api = {
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    connectDb: vi.fn().mockResolvedValue(connection.id),
    disconnectDb: vi.fn().mockResolvedValue(undefined),
    completionAssistantSearch: vi.fn().mockRejectedValue(new Error("Assistant unavailable")),
    getColumns: vi.fn().mockResolvedValue([column("id"), column("name")]),
    loadSchemaCache: vi.fn(async (key: string) => structuredClone(disk.get(key) ?? null)),
    saveSchemaCache: vi.fn(async (key: string, value: unknown) => {
      disk.set(key, structuredClone(value));
    }),
    deleteSchemaCachePrefix: vi.fn(async (prefix: string) => {
      for (const key of disk.keys()) if (key.startsWith(prefix)) disk.delete(key);
    }),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    deleteTableVGroupsForConnection: vi.fn().mockResolvedValue(undefined),
  };
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => api);
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const { useSettingsStore } = await import("@/stores/settingsStore");
  useSettingsStore().editorSettings.globalObjectSearchEnabled = true;
  const store = useConnectionStore();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  return { store, api, disk };
}

async function saved(disk: Map<string, unknown>) {
  await vi.waitFor(() => expect([...disk.keys()].some((key) => key.includes(":completion-columns:"))).toBe(true));
}

describe("persistent SQL completion columns", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  });

  it("restores complete columns after restart, including prefix completion, without reconnecting a closed connection", async () => {
    const { store, disk } = await setup();
    const columns = await store.listCompletionColumns("pg", "app", "users", "public");
    await saved(disk);
    const serialized = JSON.stringify([...disk]);
    expect(serialized).not.toContain("never-persist-this-password");
    expect(serialized).not.toContain("never-persist-this-default");

    const restarted = await setup(disk);
    restarted.store.connectedIds.clear();
    restarted.store.userClosedConnectionIds.add("pg");
    expect(await restarted.store.listCompletionColumns("pg", "app", "users", "public")).toEqual(columns);
    expect(await restarted.store.listCompletionColumnsByPrefix("pg", "app", "users", "public", "na")).toEqual([expect.objectContaining({ name: "name", dataType: "text", comment: "A column" })]);
    expect(restarted.store.lookupLocalCompletionColumns("pg", "app", "users", "public")).toEqual(columns);
    expect(restarted.api.getColumns).not.toHaveBeenCalled();
    expect(restarted.api.completionAssistantSearch).not.toHaveBeenCalled();
    expect(restarted.api.connectDb).not.toHaveBeenCalled();
  });

  it("retains a saved snapshot through the real disconnect lifecycle", async () => {
    const { store, api, disk } = await setup();
    await store.listCompletionColumns("pg", "app", "users", "public");
    await saved(disk);
    await store.disconnect("pg");
    api.getColumns.mockClear();
    expect(await store.listCompletionColumns("pg", "app", "users", "public")).toHaveLength(2);
    expect(api.getColumns).not.toHaveBeenCalled();
    expect(api.connectDb).not.toHaveBeenCalled();
    expect(store.isConnectionClosedByUser("pg")).toBe(true);
  });

  it("supplies persisted fields to the actual SQL editor completion metadata and item builder", async () => {
    const { store, disk } = await setup();
    await store.listCompletionColumns("pg", "app", "users", "public");
    await saved(disk);
    const restarted = await setup(disk);
    restarted.store.connectedIds.clear();
    restarted.store.userClosedConnectionIds.add("pg");
    const { useQueryEditorCompletionMetadata } = await import("@/components/editor/useQueryEditorCompletionMetadata");
    const { buildSqlCompletionItems } = await import("@/lib/sql/sqlCompletion");
    const sql = "SELECT u. FROM public.users u";
    const props = reactive({ modelValue: sql, databaseType: "postgres" as const, dialect: "postgres" as const, connectionId: "pg", database: "app", schema: "public" });
    const metadata = useQueryEditorCompletionMetadata({ props, view: shallowRef(null), connectionStore: restarted.store, sqlBehaviorDialect: () => "postgres", remoteLatencyBudgetMs: 40, maxCompletionTables: 100, onDemandMinPrefix: 2, semanticCompletionEnabled: true });
    expect(await metadata.ensureColumnsForTable({ name: "users", schema: "public" })).toBe(true);
    const items = buildSqlCompletionItems(sql, 9, { tables: [], columnsByTable: metadata.cachedColumnsByTable, databaseType: "postgres", currentSchema: "public" });
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(expect.arrayContaining(["id", "name"]));
    expect(await metadata.listCompletionColumnsForEditor("pg", "app", "users", "public", undefined, undefined, "na")).toEqual([expect.objectContaining({ name: "name" })]);
    expect(restarted.api.connectDb).not.toHaveBeenCalled();
    expect(restarted.api.getColumns).not.toHaveBeenCalled();
    expect(restarted.api.completionAssistantSearch).not.toHaveBeenCalled();
  });

  it("does not reconnect or persist an empty success when a closed connection has no snapshot", async () => {
    const { store, api, disk } = await setup();
    store.connectedIds.clear();
    store.userClosedConnectionIds.add("pg");
    expect(await store.listCompletionColumns("pg", "app", "users", "public")).toEqual([]);
    expect(await store.listCompletionColumnsByPrefix("pg", "app", "users", "public", "na")).toEqual([]);
    expect(await store.listCompletionTables("pg", "app", "us")).toEqual([]);
    expect(await store.listCompletionSchemas("pg", "app")).toEqual([]);
    expect(api.connectDb).not.toHaveBeenCalled();
    expect(api.getColumns).not.toHaveBeenCalled();
    expect(disk.size).toBe(0);
  });

  it("refreshes a table snapshot after metadata invalidation and explicit refresh", async () => {
    const { store, api, disk } = await setup();
    await store.listCompletionColumns("pg", "app", "users", "public");
    await saved(disk);
    api.getColumns.mockResolvedValue([column("added_column")]);
    store.invalidateCompletionTableCache("pg", "app", "users", "public");
    expect(await store.listCompletionColumns("pg", "app", "users", "public")).toEqual([expect.objectContaining({ name: "added_column" })]);
    api.getColumns.mockResolvedValue([column("renamed_column")]);
    expect(await store.refreshCompletionColumns("pg", "app", "users", "public")).toEqual([expect.objectContaining({ name: "renamed_column" })]);
    expect(api.getColumns).toHaveBeenCalledTimes(3);
  });

  it("isolates same-named tables by connection binding, database, schema, catalog and quoted identity", async () => {
    const { store, api, disk } = await setup();
    const contexts = [
      ["app", "public", undefined, false],
      ["other", "public", undefined, false],
      ["app", "other", undefined, false],
      ["app", "public", "warehouse", false],
      ["app", "public", undefined, true],
    ] as const;
    for (const [index, [database, schema, catalog, quoted]] of contexts.entries()) {
      api.getColumns.mockResolvedValue([column(`column_${index}`)]);
      expect(await store.listCompletionColumns("pg", database, quoted ? "Users" : "users", schema, { tableQuoted: quoted }, catalog)).toEqual([expect.objectContaining({ name: `column_${index}` })]);
    }
    await vi.waitFor(() => expect(disk.size).toBe(contexts.length));
    const restarted = await setup(disk);
    for (const [index, [database, schema, catalog, quoted]] of contexts.entries()) {
      expect(await restarted.store.listCompletionColumns("pg", database, quoted ? "Users" : "users", schema, { tableQuoted: quoted }, catalog)).toEqual([expect.objectContaining({ name: `column_${index}` })]);
    }
    expect(restarted.api.getColumns).not.toHaveBeenCalled();

    const repointed = await setup(disk, config({ host: "different-host" }));
    repointed.api.getColumns.mockResolvedValue([column("new_endpoint")]);
    expect(await repointed.store.listCompletionColumns("pg", "app", "users", "public", { tableQuoted: false })).toEqual([expect.objectContaining({ name: "new_endpoint" })]);
    expect(repointed.api.getColumns).toHaveBeenCalledOnce();
  });

  it("falls back to complete metadata when the completion assistant truncates a column list", async () => {
    const { store, api, disk } = await setup();
    api.completionAssistantSearch.mockResolvedValue({ candidates: [{ name: "partial", kind: "column", parent_name: "users", schema: "public" }], incomplete: true, fallback_used: false });
    expect(await store.listCompletionColumns("pg", "app", "users", "public")).toHaveLength(2);
    expect(api.getColumns).toHaveBeenCalledOnce();
    await saved(disk);
    expect(JSON.stringify([...disk.values()])).not.toContain('"partial"');
  });

  it("binds JDBC snapshots to the URL endpoint without persisting the URL or embedded credentials", async () => {
    const { store, disk } = await setup(new Map(), config({ db_type: "jdbc", connection_string: "jdbc:postgresql://first-host/app?password=never-persist-url-password" }));
    await store.listCompletionColumns("pg", "app", "users", "public");
    await saved(disk);
    expect(JSON.stringify([...disk])).not.toContain("never-persist-url-password");
    const changed = await setup(disk, config({ db_type: "jdbc", connection_string: "jdbc:postgresql://other-host/app?password=never-persist-url-password" }));
    changed.api.getColumns.mockResolvedValue([column("new_jdbc_endpoint")]);
    expect(await changed.store.listCompletionColumns("pg", "app", "users", "public")).toEqual([expect.objectContaining({ name: "new_jdbc_endpoint" })]);
    expect(changed.api.getColumns).toHaveBeenCalledOnce();
  });

  it("does not treat prefix-only results as a complete persisted table", async () => {
    const { store, api, disk } = await setup();
    api.completionAssistantSearch.mockResolvedValueOnce({ candidates: [{ name: "name", kind: "column", parent_name: "users", schema: "public" }], incomplete: false, fallback_used: false });
    await store.listCompletionColumnsByPrefix("pg", "app", "users", "public", "na");
    expect(disk.size).toBe(0);
    expect(await store.listCompletionColumns("pg", "app", "users", "public")).toHaveLength(2);
    await saved(disk);
  });

  it("persists a complete assistant result without requesting table rows or full structure", async () => {
    const { store, api, disk } = await setup();
    api.completionAssistantSearch.mockResolvedValue({ candidates: [{ name: "id", kind: "column", parent_name: "users", schema: "public", data_type: "integer", comment: "Identifier" }], incomplete: false, fallback_used: false });
    expect(await store.listCompletionColumns("pg", "app", "users", "public")).toEqual([expect.objectContaining({ name: "id", comment: "Identifier" })]);
    expect(api.getColumns).not.toHaveBeenCalled();
    await saved(disk);
  });

  it("does not persist an old field response after table invalidation", async () => {
    const { store, api, disk } = await setup();
    let release!: (value: ReturnType<typeof column>[]) => void;
    api.getColumns.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const old = store.listCompletionColumns("pg", "app", "users", "public");
    await vi.waitFor(() => expect(api.getColumns).toHaveBeenCalledOnce());
    store.invalidateCompletionTableCache("pg", "app", "users", "public");
    api.getColumns.mockResolvedValue([column("fresh_column")]);
    await store.listCompletionColumns("pg", "app", "users", "public");
    release([column("stale_column")]);
    await old;
    await saved(disk);
    const restarted = await setup(disk);
    expect(await restarted.store.listCompletionColumns("pg", "app", "users", "public")).toEqual([expect.objectContaining({ name: "fresh_column" })]);
    expect(restarted.api.getColumns).not.toHaveBeenCalled();
  });

  it("uses object-index names in closed SQL completion with database and schema isolation", async () => {
    const { store, api } = await setup();
    const { buildSidebarObjectIndex } = await import("@/lib/sidebar/sidebarObjectIndex");
    store.sidebarObjectIndexes = {
      pg: await buildSidebarObjectIndex(config(), {
        listDatabases: vi.fn().mockResolvedValue([{ name: "app" }]),
        listSchemas: vi.fn().mockResolvedValue(["public", "analytics"]),
        listObjects: vi.fn().mockResolvedValue([
          { name: "users", object_type: "TABLE" },
          { name: "refresh_users", object_type: "FUNCTION" },
        ]),
      } as any),
    };
    store.connectedIds.clear();
    store.userClosedConnectionIds.add("pg");

    expect(await store.listCompletionTables("pg", "app", "user", 20, "public")).toEqual([expect.objectContaining({ name: "users", schema: "public" })]);
    expect(await store.listCompletionTables("pg", "other", "user", 20, "public")).toEqual([]);
    expect(await store.listCompletionObjects("pg", "app", "refresh", 20, "analytics")).toEqual([expect.objectContaining({ name: "refresh_users", schema: "analytics", type: "function" })]);
    expect(await store.listCompletionSchemas("pg", "app")).toEqual(expect.arrayContaining(["public", "analytics"]));
    expect(await store.listCompletionDatabases("pg")).toEqual(["app"]);
    expect(api.connectDb).not.toHaveBeenCalled();
    expect(api.completionAssistantSearch).not.toHaveBeenCalled();
  });

  it("expires persisted metadata after 24 hours and tolerates unavailable disk storage", async () => {
    const { store, disk } = await setup();
    await store.listCompletionColumns("pg", "app", "users", "public");
    await saved(disk);
    for (const value of disk.values()) (value as { cachedAt: string }).cachedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const restarted = await setup(disk);
    restarted.api.saveSchemaCache.mockRejectedValue(new Error("Disk unavailable"));
    expect(await restarted.store.listCompletionColumns("pg", "app", "users", "public")).toHaveLength(2);
    expect(restarted.api.getColumns).toHaveBeenCalledOnce();
  });

  it("keeps one-time connections and Oracle current-schema session metadata out of persistence", async () => {
    for (const connection of [config({ one_time: true }), config({ db_type: "oracle", username: "" })]) {
      const { store, disk } = await setup(new Map(), connection);
      expect(await store.listCompletionColumns("pg", "app", "users", connection.one_time ? "public" : undefined, { clientSessionId: "editor-a", version: 1 })).toHaveLength(2);
      await Promise.resolve();
      expect(disk.size).toBe(0);
    }
  });
});
