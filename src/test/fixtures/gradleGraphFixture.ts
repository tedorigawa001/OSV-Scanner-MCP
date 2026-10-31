export function graphFixture() {
  return { schema: "osv-mcp.gradle-graph", schemaVersion: 1,
    producer: { exporterVersion: "1", gradleVersion: "8.11.1" },
    lockfiles: [{ id: "lock", path: "gradle.lockfile", sha256: "a".repeat(64) }],
    projects: [{ id: "main::", buildId: "main", projectPath: ":", directory: ".", ownerBuildFile: "build.gradle" }],
    inputs: { complete: false, files: [] }, contexts: [{ id: "runtime", projectId: "main::", kind: "project", configuration: "runtimeClasspath",
      lockfileId: "lock", lockConfiguration: "runtimeClasspath", complete: true, rootVariant: "root-v",
      components: [{ id: "root", kind: "project", projectId: "main::" },
        { id: "a", kind: "module", group: "g", name: "a", version: "1" },
        { id: "b", kind: "module", group: "g", name: "b", version: "2" }],
      variants: [{ id: "root-v", componentId: "root" }, { id: "a-v", componentId: "a" }, { id: "b-v", componentId: "b" }],
      edges: [{ fromVariant: "root-v", selectedVariant: "a-v", constraint: false, requested: { kind: "module", group: "g", name: "a", selector: "1" } },
        { fromVariant: "a-v", selectedVariant: "b-v", constraint: false, requested: { kind: "module", group: "g", name: "b", selector: "2" } }],
      unresolved: [], unrepresentedDependencies: [], declarationEvidence: [] }] };
}
