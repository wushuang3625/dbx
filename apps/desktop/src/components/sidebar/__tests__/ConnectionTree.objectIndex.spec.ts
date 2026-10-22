// @vitest-environment happy-dom
import { createApp, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { buildSidebarObjectIndex } from "@/lib/sidebar/sidebarObjectIndex";
import { buildGroupedObjectTreeNodes, mergeTableInfosIntoObjects } from "@/lib/table/tableTree";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";

vi.hoisted(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  });
});

vi.mock("@/lib/backend/api", async (original) => ({
  ...(await original<typeof import("@/lib/backend/api")>()),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  listDatabases: vi.fn().mockResolvedValue([{ name: "app" }]),
  listObjects: vi.fn().mockResolvedValue([{ name: "convert_order", object_type: "FUNCTION", signature: "integer" }]),
}));
// The runtime host owns dialogs and object actions, not search projection.
vi.mock("../SidebarTreeRuntimeHost.vue", () => ({ default: { render: () => null } }));

let app: App | undefined;
let ConnectionTree: (typeof import("../ConnectionTree.vue"))["default"];
beforeAll(async () => {
  ConnectionTree = (await import("../ConnectionTree.vue")).default;
}, 30_000);
afterEach(() => {
  app?.unmount();
  app = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("connection tree persistent search", () => {
  it("renders one search row when live MySQL tables and cached objects use different schema IDs", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useConnectionStore();
    const settings = useSettingsStore();
    settings.editorSettings.globalObjectSearchEnabled = true;
    settings.editorSettings.sidebarGlobalSearchLocal = true;
    settings.editorSettings.sidebarObjectDisplay = "grouped";
    const connection = { id: "mysql", name: "MySQL", db_type: "mysql", host: "localhost", port: 3306, username: "reader", password: "", database: "app" } as ConnectionConfig;
    store.connections = [connection];
    store.connectedIds = new Set([connection.id]);
    store.activeConnectionId = connection.id;
    const groups = buildGroupedObjectTreeNodes({ nodeId: "mysql:app", connectionId: "mysql", database: "app", objects: mergeTableInfosIntoObjects([], [{ name: "data_monitor_v3", table_type: "TABLE" }]) });
    groups[0].isExpanded = true;
    store.treeNodes = [{ id: "mysql", connectionId: "mysql", label: "MySQL", type: "connection", isExpanded: true, children: [{ id: "mysql:app", connectionId: "mysql", database: "app", label: "app", type: "database", isExpanded: true, children: groups }] }];
    vi.mocked(api.listObjects).mockResolvedValueOnce([
      { name: "data_monitor_v3", object_type: "TABLE", schema: "app" },
      { name: "data_monitor_v3_detail", object_type: "TABLE", schema: "app" },
    ]);
    store.sidebarObjectIndexes = { mysql: await buildSidebarObjectIndex(connection, api) };
    const container = document.createElement("div");
    document.body.appendChild(container);
    app = createApp(ConnectionTree);
    app.use(pinia).use(i18n).mount(container);
    const input = container.querySelector<HTMLInputElement>('input[autocorrect="off"]')!;
    input.value = "data_monitor_v3";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      expect(container.textContent).toContain("data_monitor_v3_detail");
      expect(container.textContent?.match(/data_monitor_v3(?!_detail)/g)).toHaveLength(1);
    });
    expect(store.treeNodes[0].children?.[0].children?.[0].children).toHaveLength(1);
  });

  it("renders disconnected function hits alongside the active connection and dispatches manual refresh", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    i18n.global.locale.value = "en";
    const store = useConnectionStore();
    const settings = useSettingsStore();
    settings.editorSettings.globalObjectSearchEnabled = true;
    settings.editorSettings.sidebarGlobalSearchLocal = true;
    const connections = ["active", "offline"].map((id) => ({ id, name: id, db_type: "mysql", host: "localhost", port: 3306, username: "reader", password: "", database: "app" }) as ConnectionConfig);
    store.connections = connections;
    store.connectedIds = new Set(["active"]);
    store.activeConnectionId = "active";
    store.treeNodes = connections.map((connection) => ({ id: connection.id, connectionId: connection.id, label: connection.name, type: "connection", isExpanded: false, children: [] }));
    store.sidebarObjectIndexes = Object.fromEntries(await Promise.all(connections.map(async (connection) => [connection.id, await buildSidebarObjectIndex(connection, api)])));
    const refresh = vi.spyOn(store, "refreshSidebarObjectIndex").mockResolvedValue([]);
    vi.clearAllMocks();
    const container = document.createElement("div");
    document.body.appendChild(container);
    app = createApp(ConnectionTree);
    app.use(pinia).use(i18n).mount(container);
    const input = container.querySelector<HTMLInputElement>('input[autocorrect="off"]');
    expect(input).not.toBeNull();
    input!.value = "convert_order";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      expect(container.textContent?.match(/convert_order\(integer\)/g)).toHaveLength(2);
      expect(container.textContent).toContain("offline");
    });
    expect(api.listDatabases).not.toHaveBeenCalled();
    expect(api.listObjects).not.toHaveBeenCalled();
    expect(store.activeConnectionId).toBe("active");
    expect(store.treeNodes.every((node) => !node.isExpanded && !node.children?.length)).toBe(true);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Refresh object indexes for all connections"]');
    expect(button).not.toBeNull();
    button!.click();
    expect(refresh).toHaveBeenCalledTimes(1);
    store.sidebarObjectIndexStatuses = { offline: "incomplete" };
    await nextTick();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("incomplete");
    store.sidebarObjectIndexStatuses = { offline: "building" };
    await nextTick();
    expect(button!.disabled).toBe(true);
    settings.editorSettings.globalObjectSearchEnabled = false;
    await nextTick();
    expect(container.textContent).not.toContain("convert_order(integer)");
    expect(container.querySelector('button[aria-label="Refresh object indexes for all connections"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
