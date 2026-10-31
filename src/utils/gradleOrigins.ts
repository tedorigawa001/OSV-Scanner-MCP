/** Origin reachability, shared across roots using a condensed variant graph. */
interface Origin { variant: string; key: string; name: string }

export function collectGradleOrigins(
  nodes: ReadonlySet<string>, adjacency: ReadonlyMap<string, readonly string[]>, roots: readonly Origin[],
  keyOf: (variant: string) => string | null, sharedTargets: boolean, tick: () => void,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  // Start with useful individual walks. A single shared edge is not evidence that SCC
  // setup pays off for the entire graph. Only switch after observing both substantial
  // cross-origin revisits and duplicate edge work within those walks.
  const adaptive = roots.length > 4 && sharedTargets;
  individual: {
    const across = adaptive ? new Set<string>() : null;
    let revisits = 0, duplicates = 0;
    for (const origin of roots) {
      const visited = new Set<string>(), pending = [origin.variant];
      for (let i = 0; i < pending.length; i++) {
        tick(); const v = pending[i]!;
        if (visited.has(v)) {
          duplicates++;
          if (adaptive && revisits > nodes.size && duplicates > nodes.size) break individual;
          continue;
        }
        visited.add(v);
        if (across) {
          if (across.has(v)) revisits++;
          else across.add(v);
          if (revisits > nodes.size && duplicates > nodes.size) break individual;
        }
        const key = keyOf(v);
        if (key && key !== origin.key) { const by = result.get(key) ?? new Set<string>(); by.add(origin.name); result.set(key, by); }
        for (const child of adjacency.get(v) ?? []) pending.push(child);
      }
    }
    return result;
  }

  // Discard the probe's partial origins before shared propagation. Its work remains
  // charged to the same scan budget; an exhausted budget never publishes this subset.
  result.clear();
  const ids = [...nodes], index = new Map(ids.map((id, i) => [id, i]));
  const forward: number[][] = ids.map(() => []), reverse: number[][] = ids.map(() => []);
  for (let v = 0; v < ids.length; v++) {
    tick();
    for (const child of adjacency.get(ids[v]!) ?? []) {
      tick(); const w = index.get(child)!; forward[v]!.push(w); reverse[w]!.push(v);
    }
  }
  // Iterative Kosaraju avoids recursion limits on long chains and large cycles.
  const visited = new Uint8Array(ids.length), next = new Uint32Array(ids.length), order: number[] = [];
  for (let start = 0; start < ids.length; start++) {
    if (visited[start]) continue;
    const stack = [start]; visited[start] = 1;
    while (stack.length) {
      const v = stack[stack.length - 1]!;
      if (next[v]! < forward[v]!.length) {
        tick(); const w = forward[v]![next[v]!]!; next[v] = next[v]! + 1;
        if (!visited[w]) { visited[w] = 1; stack.push(w); }
      } else { tick(); stack.pop(); order.push(v); }
    }
  }
  const component = new Int32Array(ids.length).fill(-1);
  let count = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    const start = order[i]!; if (component[start] !== -1) continue;
    const stack = [start]; component[start] = count;
    while (stack.length) {
      tick(); const v = stack.pop()!;
      for (const w of reverse[v]!) { tick(); if (component[w] === -1) { component[w] = count; stack.push(w); } }
    }
    count++;
  }
  const edges: Set<number>[] = Array.from({ length: count }, () => new Set());
  const incoming = new Uint32Array(count);
  for (let v = 0; v < ids.length; v++) {
    tick(); const from = component[v]!;
    for (const w of forward[v]!) {
      tick(); const to = component[w]!;
      if (from !== to && !edges[from]!.has(to)) { edges[from]!.add(to); incoming[to] = incoming[to]! + 1; }
    }
  }
  // Sparse 32-origin words avoid allocating V*R bits for graphs with many isolated roots.
  const chunks: (Map<number, number> | undefined)[] = Array(count);
  const origins: { key: string; name: string }[] = [], originIndex = new Map<string, number>();
  for (const root of roots) {
    tick(); let origin = originIndex.get(root.key);
    if (origin === undefined) { origin = origins.length; originIndex.set(root.key, origin); origins.push(root); }
    const c = component[index.get(root.variant)!]!, words = chunks[c] ??= new Map<number, number>();
    const word = origin >>> 5;
    words.set(word, ((words.get(word) ?? 0) | (1 << (origin & 31))) >>> 0);
  }
  const pending: number[] = [];
  for (let c = 0; c < count; c++) if (incoming[c] === 0) pending.push(c);
  for (let i = 0; i < pending.length; i++) {
    tick(); const c = pending[i]!;
    for (const child of edges[c]!) {
      tick();
      for (const [word, bits] of chunks[c] ?? []) {
        tick(); const target = chunks[child] ??= new Map<number, number>();
        target.set(word, ((target.get(word) ?? 0) | bits) >>> 0);
      }
      incoming[child] = incoming[child]! - 1;
      if (incoming[child] === 0) pending.push(child);
    }
  }
  if (pending.length !== count) throw new Error("invalid_condensation");
  const decoded: Set<string>[] = Array.from({ length: count }, () => new Set());
  for (let v = 0; v < ids.length; v++) {
    tick(); const key = keyOf(ids[v]!), c = component[v]!;
    if (!key || decoded[c]!.has(key)) continue;
    decoded[c]!.add(key);
    for (const [word, value] of chunks[c] ?? []) {
      tick(); let bits = value;
      while (bits) {
        tick(); const bit = 31 - Math.clz32(bits & -bits), origin = origins[word * 32 + bit]!;
        if (origin.key !== key) { const by = result.get(key) ?? new Set<string>(); by.add(origin.name); result.set(key, by); }
        bits = (bits & (bits - 1)) >>> 0;
      }
    }
  }
  return result;
}
