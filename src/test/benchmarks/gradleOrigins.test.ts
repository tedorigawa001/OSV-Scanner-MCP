/** Opt-in before/after comparison; wall-clock measurements are never CI pass thresholds. */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import * as current from "../../utils/gradleGraph.js";
import { syntheticGradleGraph, syntheticGradleTrees } from "../fixtures/gradleSyntheticGraph.js";

const baselinePath = process.env.OSV_MCP_GRADLE_BASELINE;
it.skipIf(!baselinePath)("compares origin analysis with the saved pre-change analyzer", async () => {
  const baseline = await import(pathToFileURL(baselinePath!).href) as typeof current;
  const reviewedPath = process.env.OSV_MCP_GRADLE_REVIEWED;
  const reviewed = reviewedPath ? await import(pathToFileURL(reviewedPath).href) as typeof current : null;
  const scenarios = [
    { name: "shared-small", roots: 40, modules: 150 },
    { name: "shared-medium", roots: 100, modules: 600 },
    { name: "shared-large", roots: 200, modules: 1200 },
    { name: "shared-cycle", roots: 200, modules: 1200, cycle: true },
    { name: "single-origin", roots: 1, modules: 1200 },
    { name: "disjoint-trees", roots: 400, modules: 1200, disjoint: true },
    { name: "sparse-sharing", roots: 400, modules: 6000, contexts: 8, documents: 3, sparse: true },
  ];
  const rows = [];
  for (const scenario of scenarios) {
    const documents = scenario.documents ?? 1, contexts = scenario.contexts ?? 3;
    const totalContexts = documents * contexts;
    const fixture = scenario.disjoint || scenario.sparse
      ? syntheticGradleTrees(scenario.roots, scenario.modules, contexts, !!scenario.sparse)
      : syntheticGradleGraph(scenario.roots, scenario.modules, contexts);
    for (const c of fixture.graph.contexts) {
      if (scenario.cycle) c.edges.push({ fromVariant: `v${scenario.modules - 1}`, selectedVariant: `v${scenario.roots}`, constraint: false, requested: { kind: "unknown" } });

    }
    const graph = current.parseGradleGraph(JSON.stringify(fixture.graph)), lock = current.parseGradleLock(fixture.lockText);
    const run = (analyzer: typeof current, limit: number) => {
      const budget = analyzer.createGradleBudget(); budget.traversal = limit;
      const start = performance.now();
      const results = [];
      for (let document = 0; document < documents; document++) for (const c of graph.contexts) results.push(analyzer.analyzeGradleContext(c, lock, budget));
      const ms = performance.now() - start;
      return { ms, used: limit - budget.traversal, complete: results.filter(r => r.lookup && !r.reasons.length).length, results };
    };
    const fingerprint = (results: ReturnType<typeof run>["results"]) => {
      const hash = createHash("sha256");
      for (const result of results) {
        hash.update(JSON.stringify([result.coverageReasons, result.reasons]));
        for (let i = 0; i < scenario.modules; i++) {
          const info = result.lookup!(`g:p${i}`, "1");
          hash.update(JSON.stringify([info.relation, [...(info.introducedBy ?? [])].sort(), info.introducedByComplete, info.declaredInComplete]));
        }
      }
      return hash.digest("hex");
    };
    // Validate all package results outside the timed region, with enough budget for the reference.
    const analyzers = { before: baseline, after: current, ...(scenario.sparse && reviewed ? { reviewed } : {}) };
    const profiles: Record<string, { operations: number; timings: number[] }> = {};
    let expected: string | undefined;
    for (const [name, analyzer] of Object.entries(analyzers)) {
      const full = run(analyzer!, 1_000_000_000), digest = fingerprint(full.results);
      if (expected === undefined) expected = digest;
      else expect(digest).toBe(expected);
      profiles[name] = { operations: full.used, timings: [] };
      full.results.length = 0;
      run(analyzer!, 1_000_000_000);
    }
    const names = Object.keys(analyzers) as (keyof typeof analyzers)[];
    for (let repeat = 0; repeat < 7; repeat++) {
      const offset = repeat % names.length, order = [...names.slice(offset), ...names.slice(0, offset)];
      if (repeat % 2) order.reverse();
      for (const name of order) profiles[name]!.timings.push(run(analyzers[name]!, 1_000_000_000).ms);
    }
    const metrics: Record<string, { median_ms: number; min_ms: number; max_ms: number; operations: number; complete_with_default_budget: number }> = {};
    for (const name of names) {
      const sorted = profiles[name]!.timings.sort((a, b) => a - b), limited = run(analyzers[name]!, 2_000_000);
      metrics[name] = { median_ms: sorted[3]!, min_ms: sorted[0]!, max_ms: sorted[6]!, operations: profiles[name]!.operations, complete_with_default_budget: limited.complete };
    }
    expect(metrics.after!.complete_with_default_budget).toBe(totalContexts);
    if (scenario.name === "shared-large") { expect(metrics.before!.complete_with_default_budget).toBeLessThan(totalContexts); expect(metrics.after!.operations).toBeLessThan(metrics.before!.operations); }
    if (scenario.sparse) {
      expect(metrics.after!.operations).toBeLessThanOrEqual(metrics.before!.operations * 1.1);
      if (metrics.reviewed) expect(metrics.reviewed.complete_with_default_budget).toBeLessThan(totalContexts);
    }
    rows.push({ scenario: scenario.name, roots: scenario.roots, modules: scenario.modules, contexts: totalContexts, contexts_per_document: contexts, documents,
      before: metrics.before, after: metrics.after, ...(metrics.reviewed ? { reviewed: metrics.reviewed } : {}), equivalent: true });
  }
  const report = { node: process.version, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model,
    baseline: baselinePath, ...(reviewedPath ? { reviewed: reviewedPath } : {}), timed: "analyzeGradleContext only; JSON parsing and fingerprint validation excluded", repetitions: 7, rows };
  if (process.env.OSV_MCP_GRADLE_BENCH_OUTPUT) await writeFile(process.env.OSV_MCP_GRADLE_BENCH_OUTPUT, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}, 120_000);
