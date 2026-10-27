import { describe, expect, it } from "vitest";
import { parseDepsJson, parsePackagesLock, parseProjectAssets } from "../../utils/nugetFiles.js";
import { createNugetGraphBudget, nugetGraphKey, nugetGraphOrigins, type NugetGraph } from "../../utils/nugetDependencyGraph.js";

const lockGraphs = (dependencies: object) => {
  const parsed = parsePackagesLock(JSON.stringify({ version: 1, dependencies }));
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.graphs!;
};
const entry = (type: string, resolved = "1.0.0", dependencies = {}) => ({ type, resolved, dependencies });
const origins = (graphs: NugetGraph[]) => nugetGraphOrigins(graphs, createNugetGraphBudget())!;

describe("NuGet dependency origins", () => {
  it("parses large deps.json project dependency lists without exceeding argument limits", () => {
    const dependencies = Object.fromEntries(Array.from({ length: 150_000 }, (_, i) => [`Package${i}`, "1.0.0"]));
    const parsed = parseDepsJson(JSON.stringify({
      libraries: { "App/1.0.0": { type: "project" }, "Package0/1.0.0": { type: "package" } },
      targets: { net8: { "App/1.0.0": { dependencies }, "Package0/1.0.0": {} } },
    }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.packages).toContainEqual({ name: "Package0", version: "1.0.0", relation: "direct" });
    expect(parsed.graphs![0]!.find(node => node.name === "Package0")?.direct).toBe(true);
  });
  it("does not merge invalid locked versions into valid versions in another target", () => {
    const result = origins(lockGraphs({
      net8: { Parent: entry("Direct", "1.0.0", { Leaf: "*" }), Leaf: entry("Transitive", "1.0.0.0-") },
      net9: { Leaf: entry("Transitive", "1.0.0") },
    }));
    expect(nugetGraphKey("Leaf", "1.0.0.0-")).not.toBe(nugetGraphKey("Leaf", "1.0.0"));
    expect(result.has(nugetGraphKey("Leaf", "1.0.0"))).toBe(false);
  });
  it("finds multiple roots and nested origins with case-insensitive IDs", () => {
    const result = origins(lockGraphs({ net8: { A: entry("Direct", "1.0.0", { b: "[1,)" }), B: entry("Transitive", "2.0.0", { C: "[3,)" }), C: entry("Transitive", "3.0.0"), D: entry("Direct", "1.0.0", { C: "[3,)" }) } }));
    expect(result.get(nugetGraphKey("c", "3.0.0"))).toEqual(new Set(["A", "D"]));
    expect(result.get(nugetGraphKey("B", "2.0.0"))).toEqual(new Set(["A"]));
  });
  it("does not combine edges from separate TFMs or RID targets", () => {
    const result = origins(lockGraphs({
      net48: { A: entry("Direct", "1", { B: "*" }), B: entry("Transitive", "1") },
      net8: { B: entry("Transitive", "1", { C: "*" }), C: entry("Transitive", "1") },
    }));
    expect(result.has(nugetGraphKey("C", "1"))).toBe(false);
  });
  it("keeps different locked versions separate while normalizing equivalent versions", () => {
    const result = origins(lockGraphs({ net48: { A: entry("Direct", "1", { X: "*" }), X: entry("Transitive", "1.0.0.0") },
      net8: { B: entry("Direct", "1", { X: "*" }), X: entry("Transitive", "2.0.0") } }));
    expect(result.get(nugetGraphKey("X", "1"))).toEqual(new Set(["A"]));
    expect(result.get(nugetGraphKey("X", "2"))).toEqual(new Set(["B"]));
  });
  it("terminates cycles and does not introduce a root through itself", () => {
    const result = origins(lockGraphs({ net8: { A: entry("Direct", "1", { B: "*" }), B: entry("Transitive", "1", { A: "*" }) } }));
    expect(result.has(nugetGraphKey("A", "1"))).toBe(false);
    expect(result.get(nugetGraphKey("B", "1"))).toEqual(new Set(["A"]));
  });
  it("does not guess a case-ambiguous locked name", () => {
    const result = origins(lockGraphs({ net8: { A: entry("Direct", "1", { B: "*" }), B: entry("Transitive", "1"), b: entry("Transitive", "2") } }));
    expect(result.size).toBe(0);
  });
  it("deduplicates origin casing across target frameworks", () => {
    const result = origins(lockGraphs({ net48: { Parent: entry("Direct", "1", { X: "*" }), X: entry("Transitive", "1") },
      net8: { parent: entry("Direct", "1", { x: "*" }), x: entry("Transitive", "1") } }));
    expect(result.get(nugetGraphKey("X", "1"))?.size).toBe(1);
  });
  it("uses assets targets and framework roots, including targetAlias and RID", () => {
    const p = parseProjectAssets(JSON.stringify({ libraries: { "A/1.0.0": { type: "package" }, "B/2.0.0": { type: "package" } },
      project: { frameworks: { custom: { targetAlias: "net8.0", dependencies: { A: {} } } } },
      targets: { "net8.0/linux-x64": { "A/1.0.0": { type: "package", dependencies: { b: "2.0.0" } }, "B/2.0.0": { type: "package" } } } }));
    expect(p.ok && origins(p.graphs!).get(nugetGraphKey("B", "2"))).toEqual(new Set(["A"]));
  });
  it("does not assign roots to unmatched or ambiguous assets frameworks", () => {
    const p = parseProjectAssets(JSON.stringify({ libraries: {}, project: { frameworks: { net48: { dependencies: { A: {} } } } },
      targets: { net8: { "A/1": { type: "package", dependencies: { B: "1" } }, "B/1": { type: "package" } } } }));
    expect(p.ok && origins(p.graphs!).size).toBe(0);
  });
  it("uses exact deps.json versions and never traverses a mismatch", () => {
    const p = parseDepsJson(JSON.stringify({ libraries: { "app/1": { type: "project" }, "A/1": { type: "package" }, "B/2": { type: "package" }, "C/1": { type: "package" } },
      targets: { net8: { "app/1": { dependencies: { A: "1" } }, "A/1": { dependencies: { B: "1", C: "1.0.0.0" } }, "B/2": {}, "C/1": {} } } }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const result = origins(p.graphs!);
    expect(result.has(nugetGraphKey("B", "2"))).toBe(false);
    expect(result.get(nugetGraphKey("C", "1"))).toEqual(new Set(["A"]));
  });
  it("shares a bounded traversal budget across graphs", () => {
    const graphs = lockGraphs({ net8: { A: entry("Direct", "1", { B: "*" }), B: entry("Transitive", "1") } });
    const budget = { remaining: 2 };
    expect(nugetGraphOrigins(graphs, budget)).toBeNull();
    expect(nugetGraphOrigins(graphs, budget)).toBeNull();
  });
  it("does not treat a local Project entry as a guessed direct origin", () => {
    const result = origins(lockGraphs({ net8: { Local: entry("Project", "", { B: "*" }), B: entry("Transitive", "1") } }));
    expect(result.size).toBe(0);
  });
  it("does not turn invalid package IDs or unresolved versions into introducers", () => {
    const result = origins(lockGraphs({ net8: { "../bad": entry("Direct", "1", { B: "*" }), A: entry("Direct", "$(Version)", { B: "*" }), B: entry("Transitive", "1") } }));
    expect(result.size).toBe(0);
  });
});
