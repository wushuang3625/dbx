import { shallowRef } from "vue";
import type { ConnectionConfig, DatabaseType, ObjectInfo, TreeNode } from "@/types/database";
import type * as backend from "@/lib/backend/api";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { scrubConnectionForPlaintextExport } from "@/lib/connection/connectionConfigTransfer";
import { connectionIsDorisFamilyCatalogCapable, isSchemaAware, normalizeSidebarObjectKind, shouldShowDorisCatalogTree, sidebarObjectKindsForDatabase, usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import { supportsSqlFileExecution } from "@/lib/database/databaseFeatureSupport";
import { connectionObjectTreeNodeSchema, connectionObjectTreeQuerySchema, connectionShouldDiscoverJdbcSchemas, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { connectionUsesVisibleSchemaFilter, filterDatabaseNamesForConnection, filterSchemaNamesForConnection } from "@/lib/database/visibleDatabases";
import { buildGroupedObjectTreeNodes, buildSimpleObjectTreeNodes } from "@/lib/table/tableTree";
import { createSidebarLabelMatcher } from "@/lib/sidebar/sidebarSearch";

type IndexApi = Pick<typeof backend, "listDatabases" | "listSchemas" | "listObjects" | "listDorisCatalogs" | "listDorisCatalogDatabases" | "loadSchemaCache" | "saveSchemaCache" | "deleteSchemaCachePrefix">;
interface IndexedScope {
  path: TreeNode[];
  database: string;
  schema?: string;
  nodeSchema?: string;
  catalog?: string;
  objects: ObjectInfo[];
}
export interface SidebarObjectIndex {
  version: 1;
  connectionId: string;
  binding: string;
  databaseType?: DatabaseType;
  indexedAt: number;
  complete: boolean;
  scopes: IndexedScope[];
}
export type SidebarObjectIndexStatus = "building" | "ready" | "incomplete" | "failed";
const PAGE_SIZE = 1000;
const indexedKinds = new Set(["TABLE", "VIEW", "MATERIALIZED_VIEW", "FUNCTION", "FUNCTION_INTERNAL", "FUNCTION_UDF", "PROCEDURE"]);
const cacheKey = (id: string) => `sidebar-object-index-v1:${encodeURIComponent(id)}:`;
// The binding excludes secrets; it prevents a cache for another endpoint or
// visibility configuration from being reused after importing connection edits.
const bindingFor = (config: ConnectionConfig) => connectionConfigFingerprint(scrubConnectionForPlaintextExport(config));
export const supportsSidebarObjectIndex = (config: ConnectionConfig) => !config.one_time && supportsSqlFileExecution(effectiveDatabaseTypeForConnection(config));
const scopeKey = (scope: IndexedScope) => JSON.stringify([scope.catalog, scope.database, scope.schema]);
const safeObject = (object: ObjectInfo): ObjectInfo => ({ name: object.name, object_type: object.object_type, schema: object.schema, signature: object.signature, comment: object.comment, valid: object.valid, parent_schema: object.parent_schema, parent_name: object.parent_name });

/** A metadata-only index. Discovery never loads table rows, columns or DDL. */
export async function buildSidebarObjectIndex(config: ConnectionConfig, api: IndexApi, previous?: SidebarObjectIndex, isCurrent = () => true): Promise<SidebarObjectIndex> {
  const id = config.id;
  const dbType = effectiveDatabaseTypeForConnection(config);
  const kinds = sidebarObjectKindsForDatabase(dbType).filter((kind) => indexedKinds.has(kind));
  const root: TreeNode = { id, label: config.name, type: "connection", connectionId: id, isExpanded: false };
  const scopes: IndexedScope[] = [];
  let complete = true;
  const node = (name: string, type: "database" | "schema", database: string, schema?: string, parentId = id, catalog?: string): TreeNode => ({ id: `${parentId}:${name}`, label: name, type, connectionId: id, database, schema, catalog, isExpanded: false });
  const checkCurrent = () => {
    if (!isCurrent()) throw new Error("Object index build superseded");
  };
  const readScope = async (path: TreeNode[], database: string, schema?: string, catalog?: string) => {
    checkCurrent();
    const scope: IndexedScope = { path, database, schema, nodeSchema: connectionObjectTreeNodeSchema(config, database, schema), catalog, objects: [] };
    try {
      const seenPages = new Set<string>();
      for (let offset = 0; ; offset += PAGE_SIZE) {
        checkCurrent();
        const page = await api.listObjects(id, database, connectionObjectTreeQuerySchema(config, database, schema), kinds, undefined, PAGE_SIZE, offset, catalog);
        checkCurrent();
        // Some drivers do not implement offsets. Do not loop forever or mark a
        // repeated first page as a complete inventory.
        const pageKey = JSON.stringify(page.map((object) => [object.object_type, object.schema, object.name, object.signature]));
        if (page.length && seenPages.has(pageKey)) throw new Error("Object pagination did not advance");
        seenPages.add(pageKey);
        scope.objects.push(...page.filter((object) => indexedKinds.has(normalizeSidebarObjectKind(object.object_type))).map(safeObject));
        if (page.length < PAGE_SIZE) break;
      }
      scopes.push(scope);
    } catch {
      checkCurrent();
      complete = false;
      const old = previous?.scopes.find((entry) => scopeKey(entry) === scopeKey(scope));
      scopes.push(old ? { ...scope, objects: old.objects } : scope);
    }
  };
  const readDatabase = async (database: string, path: TreeNode[], catalog?: string) => {
    try {
      if (!catalog && ((usesTreeSchemaMode(dbType) && !connectionUsesDatabaseObjectTreeMode(config)) || connectionShouldDiscoverJdbcSchemas(config) || dbType === "duckdb")) {
        const schemas = filterSchemaNamesForConnection(await api.listSchemas(id, database), config, database);
        checkCurrent();
        for (const schema of schemas) {
          const parent = node(schema, "schema", database, schema, path[path.length - 1].id);
          await readScope([...path, parent], database, schema);
        }
      } else await readScope(path, database, undefined, catalog);
    } catch {
      checkCurrent();
      complete = false;
      // Schema discovery failed: keep that database's last successful scopes.
      scopes.push(...(previous?.scopes.filter((scope) => scope.database === database && scope.catalog === catalog) ?? []));
    }
  };
  if (connectionUsesVisibleSchemaFilter(config)) {
    const schemas = filterSchemaNamesForConnection(await api.listSchemas(id, config.database || ""), config, config.database || "");
    for (const schema of schemas) await readScope([root, node(schema, "schema", schema, schema, `${id}:${schema}`)], schema, schema);
  } else {
    const catalogs = connectionIsDorisFamilyCatalogCapable(config) ? await api.listDorisCatalogs(id) : [];
    if (shouldShowDorisCatalogTree(catalogs)) {
      for (const catalog of catalogs) {
        checkCurrent();
        const parent: TreeNode = { id: `${id}:doris-catalog:${encodeURIComponent(catalog.name)}`, label: catalog.name, type: "doris-catalog", connectionId: id, catalog: catalog.name, catalogType: catalog.catalog_type, isExpanded: false };
        try {
          const databases = filterDatabaseNamesForConnection(
            (await api.listDorisCatalogDatabases(id, catalog.name)).map((db) => db.name),
            config,
          );
          for (const database of databases) await readDatabase(database, [root, parent, { ...node(encodeURIComponent(database), "database", database, undefined, parent.id, catalog.name), label: database }], catalog.name);
        } catch {
          checkCurrent();
          complete = false;
          scopes.push(...(previous?.scopes.filter((scope) => scope.catalog === catalog.name) ?? []));
        }
      }
    } else {
      const databases = filterDatabaseNamesForConnection(
        (await api.listDatabases(id)).map((db) => db.name),
        config,
      );
      for (const database of databases) {
        // DuckDB's main schemas live directly below the connection root.
        await readDatabase(database, dbType === "duckdb" && database === "main" ? [root] : [root, node(database, "database", database)]);
      }
    }
  }
  checkCurrent();
  return { version: 1, connectionId: id, binding: bindingFor(config), databaseType: dbType, indexedAt: Date.now(), complete, scopes };
}

/** Serializes writes per connection and prevents stale builds resurrecting deleted caches. */
export function createSidebarObjectIndexes(options: { api: IndexApi; getConfig: (id: string) => ConnectionConfig | undefined; isEnabled?: () => boolean; ensureConnected: (id: string) => Promise<void> }) {
  const indexes = shallowRef<Record<string, SidebarObjectIndex>>({});
  const statuses = shallowRef<Record<string, SidebarObjectIndexStatus>>({});
  const generations = new Map<string, number>();
  const writes = new Map<string, Promise<unknown>>();
  const running = new Map<string, Promise<void>>();
  // Bound work across saved connections, including concurrent individual saves.
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = async () => {
    if (active >= 2) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  const setStatus = (id: string, status: SidebarObjectIndexStatus) => {
    statuses.value = { ...statuses.value, [id]: status };
  };
  const write = (id: string, action: () => Promise<unknown>) => {
    const promise = (writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    writes.set(id, promise);
    return promise;
  };
  async function hydrate(id: string) {
    if (options.isEnabled?.() === false) return;
    const config = options.getConfig(id);
    if (!config || !supportsSidebarObjectIndex(config) || indexes.value[id] || running.has(id)) return;
    const generation = generations.get(id);
    try {
      const cached = await options.api.loadSchemaCache<SidebarObjectIndex>(cacheKey(id));
      if (options.isEnabled?.() === false || generations.get(id) !== generation || !options.getConfig(id) || bindingFor(options.getConfig(id)!) !== bindingFor(config)) return;
      if (cached?.version !== 1 || cached.connectionId !== id || cached.binding !== bindingFor(config) || !Array.isArray(cached.scopes)) return;
      indexes.value = { ...indexes.value, [id]: cached };
      setStatus(id, cached.complete ? "ready" : "incomplete");
    } catch {
      if (generations.get(id) === generation && options.getConfig(id)) setStatus(id, "failed");
    }
  }
  function invalidate(id: string) {
    generations.set(id, (generations.get(id) ?? 0) + 1);
    running.delete(id);
    const next = { ...indexes.value };
    delete next[id];
    indexes.value = next;
    const nextStatuses = { ...statuses.value };
    delete nextStatuses[id];
    statuses.value = nextStatuses;
    return write(id, () => options.api.deleteSchemaCachePrefix(cacheKey(id))).catch(() => undefined);
  }
  function pause() {
    for (const id of running.keys()) {
      generations.set(id, (generations.get(id) ?? 0) + 1);
    }
    running.clear();
    statuses.value = Object.fromEntries(Object.entries(indexes.value).map(([id, index]) => [id, index.complete ? "ready" : "incomplete"]));
  }
  function refresh(id: string): Promise<void> {
    if (options.isEnabled?.() === false) return Promise.resolve();
    const existing = running.get(id);
    if (existing) return existing;
    const config = options.getConfig(id);
    if (!config || !supportsSidebarObjectIndex(config)) return Promise.resolve();
    const generation = (generations.get(id) ?? 0) + 1;
    generations.set(id, generation);
    const binding = bindingFor(config);
    const current = () => options.isEnabled?.() !== false && generations.get(id) === generation && !!options.getConfig(id) && bindingFor(options.getConfig(id)!) === binding;
    setStatus(id, "building");
    const task = (async () => {
      await acquire();
      try {
        if (!current()) return;
        if (!indexes.value[id]) {
          const cached = await options.api.loadSchemaCache<SidebarObjectIndex>(cacheKey(id));
          if (!current()) return;
          if (cached?.version === 1 && cached.connectionId === id && cached.binding === binding && Array.isArray(cached.scopes)) indexes.value = { ...indexes.value, [id]: cached };
        }
        await options.ensureConnected(id);
        if (!current()) return;
        const previous = indexes.value[id]?.binding === binding ? indexes.value[id] : undefined;
        const index = await buildSidebarObjectIndex(config, options.api, previous, current);
        if (!current()) return;
        await write(id, async () => {
          if (current()) await options.api.saveSchemaCache(cacheKey(id), index);
        });
        if (!current()) return;
        indexes.value = { ...indexes.value, [id]: index };
        setStatus(id, index.complete ? "ready" : "incomplete");
      } catch {
        if (current()) setStatus(id, "failed");
      } finally {
        release();
        if (current()) running.delete(id);
      }
    })();
    running.set(id, task);
    return task;
  }
  return { indexes, statuses, hydrate, invalidate, refresh, pause };
}

/** Project cached hits into the display tree; live selection/expansion is untouched. */
export function mergeSidebarObjectIndexHits(nodes: readonly TreeNode[], indexes: readonly SidebarObjectIndex[], query: string, grouped: boolean, regexMode = false): TreeNode[] {
  if (!query) return [...nodes];
  const match = createSidebarLabelMatcher(query, { regexMode });
  const byConnection = new Map(indexes.map((index) => [index.connectionId, index]));
  const objectKey = (node: TreeNode, databaseType?: DatabaseType): string | undefined => {
    if (node.type !== "table" && node.type !== "view" && node.type !== "materialized_view") return undefined;
    // MySQL listObjects reports the database as schema, while listTables has
    // no schema field. Match the object without replacing its live node ID/state.
    const schema = databaseType && !isSchemaAware(databaseType) && node.schema === node.database ? "" : node.schema || "";
    return JSON.stringify([node.connectionId, node.catalog || "", node.database, schema, node.type, node.tableName || node.objectName || node.label]);
  };
  const merge = (live: readonly TreeNode[], added: readonly TreeNode[], databaseType?: DatabaseType): TreeNode[] => {
    const result = [...live];
    const positions = new Map(result.map((node, i) => [node.id, i]));
    const objectPositions = new Map<string, number>();
    result.forEach((node, i) => {
      const key = objectKey(node, databaseType);
      if (key !== undefined) objectPositions.set(key, i);
    });
    for (const node of added) {
      const key = objectKey(node, databaseType);
      const position = positions.get(node.id) ?? (key === undefined ? undefined : objectPositions.get(key));
      if (position === undefined) {
        positions.set(node.id, result.length);
        if (key !== undefined) objectPositions.set(key, result.length);
        result.push(node);
      } else {
        const current = result[position];
        result[position] = { ...current, children: merge(current.children ?? [], node.children ?? [], databaseType) };
      }
    }
    return result;
  };
  return nodes.map((node) => {
    if (node.type !== "connection") return node.children ? { ...node, children: mergeSidebarObjectIndexHits(node.children, indexes, query, grouped, regexMode) } : node;
    const index = byConnection.get(node.connectionId || node.id);
    if (!index) return node;
    let children = node.children ?? [];
    for (const scope of index.scopes) {
      const preserve = match(node.label) || scope.path.slice(1).some((parent) => match(parent.label));
      const objects = preserve ? scope.objects : scope.objects.filter((object) => match(object.name) || (object.signature && match(`${object.name}(${object.signature})`)) || (object.comment && match(object.comment)));
      if (!objects.length) continue;
      const parent = scope.path[scope.path.length - 1];
      const args = { nodeId: parent.id, connectionId: index.connectionId, database: scope.database, schema: scope.nodeSchema, databaseType: index.databaseType, objects };
      let branch = grouped ? buildGroupedObjectTreeNodes(args) : buildSimpleObjectTreeNodes(args);
      if (scope.catalog) branch = branch.map((object) => ({ ...object, catalog: scope.catalog, children: object.children?.map((child) => ({ ...child, catalog: scope.catalog })) }));
      for (const ancestor of scope.path.slice(1).reverse()) branch = [{ ...ancestor, children: branch }];
      children = merge(children, branch, index.databaseType);
    }
    return { ...node, children };
  });
}
