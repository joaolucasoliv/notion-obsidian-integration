import { createHash } from "node:crypto";
import {
  parseGraphProjection,
  type GraphEdgeV1,
  type GraphNodeV1,
  type GraphProjectionV1,
} from "@grandbox-bridge/shared";
import { classifyDomain, normalizeGraphPath, type GraphDomain, type GraphDomainRule } from "./classify.js";
import { extractGraphLinks, type GraphLink } from "./links.js";

export interface GraphSourceNote {
  path: string;
  basename: string;
  markdown: string;
  tags: string[];
}

export type { GraphDomainRule } from "./classify.js";

interface NormalizedNote {
  readonly path: string;
  readonly basename: string;
  readonly markdown: string;
  readonly tags: string[];
  readonly id: string;
  readonly domain: GraphDomain;
  readonly topLevel: string | null;
  readonly conflict: boolean;
}

interface PairMapping {
  readonly notionUrl: string;
}

const VAULT_ID = "vault:root";
const VAULT_LABEL = "The Grandbox";

function compareLexically(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function noteId(path: string): string {
  return sha256(`note\0${path}`);
}

function clusterId(topLevel: string): string {
  return `cluster:${sha256(`cluster\0${topLevel}`)}`;
}

function edgeId(kind: GraphEdgeV1["kind"], source: string, target: string): string {
  return `edge:${sha256(`edge\0${kind}\0${source}\0${target}`)}`;
}

function isTechnicalPath(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(".") || segment.toLowerCase() === "templates");
}

function isConflictPath(path: string): boolean {
  const segments = path.split("/");
  const filename = segments.at(-1) ?? "";
  return segments.includes("Bridge Conflicts") || filename.toLowerCase().endsWith(".bridge-conflict.md");
}

function isGithubSecondary(tags: readonly string[]): boolean {
  return tags.some(
    (tag) => tag.startsWith("dual-scribe/github/branch") || tag.startsWith("dual-scribe/github/activity"),
  );
}

function normalizeTags(tags: readonly string[]): string[] {
  if (!Array.isArray(tags) || tags.length > 128) throw new Error("Invalid graph tags");
  const normalized = new Set<string>();
  for (const tag of tags) {
    if (
      typeof tag !== "string" ||
      tag.length === 0 ||
      tag.trim() !== tag ||
      Buffer.byteLength(tag, "utf8") > 256 ||
      /[\u0000-\u001f\u007f]/u.test(tag)
    ) {
      throw new Error("Invalid graph tag");
    }
    normalized.add(tag);
  }
  return [...normalized].sort(compareLexically);
}

function normalizeSourceNote(note: GraphSourceNote, domainRules: readonly GraphDomainRule[]): NormalizedNote | null {
  if (note === null || typeof note !== "object") throw new Error("Invalid graph source note");
  const path = normalizeGraphPath(note.path);
  if (isTechnicalPath(path)) return null;
  if (
    typeof note.basename !== "string" ||
    note.basename.length === 0 ||
    note.basename.trim() !== note.basename ||
    Buffer.byteLength(note.basename, "utf8") > 1_024 ||
    /[\u0000-\u001f\u007f]/u.test(note.basename) ||
    typeof note.markdown !== "string"
  ) {
    throw new Error("Invalid graph source note");
  }
  const segments = path.split("/");
  return {
    path,
    basename: note.basename,
    markdown: note.markdown,
    tags: normalizeTags(note.tags),
    id: noteId(path),
    domain: classifyDomain(path, domainRules),
    topLevel: segments.length > 1 ? (segments[0] as string) : null,
    conflict: isConflictPath(path),
  };
}

function normalizedPairs(pairs: ReadonlyMap<string, PairMapping>): Map<string, PairMapping> {
  if (pairs === null || typeof pairs !== "object" || typeof pairs[Symbol.iterator] !== "function") {
    throw new Error("Invalid graph pair mappings");
  }
  const result = new Map<string, PairMapping>();
  for (const entry of pairs) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error("Invalid graph pair mapping");
    const [rawPath, mapping] = entry;
    const path = normalizeGraphPath(rawPath);
    if (mapping === null || typeof mapping !== "object" || typeof mapping.notionUrl !== "string") {
      throw new Error("Invalid graph pair mapping");
    }
    let url: URL;
    try {
      url = new URL(mapping.notionUrl);
    } catch {
      throw new Error("Invalid graph pair mapping");
    }
    if (url.protocol !== "https:") throw new Error("Invalid graph pair mapping");
    const previous = result.get(path);
    if (previous !== undefined && previous.notionUrl !== mapping.notionUrl) {
      throw new Error("Duplicate normalized graph pair mapping");
    }
    result.set(path, { notionUrl: mapping.notionUrl });
  }
  return result;
}

function obsidianUrl(path: string): string {
  return `obsidian://open?vault=${encodeURIComponent(VAULT_LABEL)}&file=${encodeURIComponent(path)}`;
}

function decodedTarget(rawTarget: string): string | null {
  try {
    const decoded = decodeURIComponent(rawTarget);
    if (decoded.includes("\\") || decoded.includes("\0") || /[\r\n]/u.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function resolveRelativePath(baseSegments: readonly string[], target: string): string | null {
  if (target.startsWith("/") || /^[A-Za-z]:/u.test(target)) return null;
  const resolved = [...baseSegments];
  for (const segment of target.split("/")) {
    if (segment.length === 0) return null;
    if (segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    if (/[^\S\r\n]/u.test(segment) && segment.trim().length === 0) return null;
    resolved.push(segment);
  }
  return resolved.length === 0 ? null : resolved.join("/");
}

function markdownStem(path: string): string {
  return path.replace(/\.md$/iu, "");
}

function targetCandidates(sourcePath: string, link: GraphLink): string[] {
  const decoded = decodedTarget(link.target);
  if (decoded === null || decoded.includes("?")) return [];
  if (decoded.length === 0) return [sourcePath];

  const sourceDirectory = sourcePath.split("/").slice(0, -1);
  const base = link.kind === "markdown-link" || decoded.startsWith(".") ? sourceDirectory : [];
  const resolved = resolveRelativePath(base, decoded);
  if (resolved === null) return [];
  if (link.kind === "markdown-link") return [resolved];
  return /\.md$/iu.test(resolved) ? [resolved] : [`${resolved}.md`];
}

function uniqueBasenameTarget(target: string, byBasename: ReadonlyMap<string, readonly NormalizedNote[]>): NormalizedNote | null {
  if (target.length === 0 || target.includes("/") || target.includes("?")) return null;
  const matches = byBasename.get(markdownStem(target));
  return matches?.length === 1 ? (matches[0] as NormalizedNote) : null;
}

function resolveLink(
  source: NormalizedNote,
  link: GraphLink,
  byPath: ReadonlyMap<string, NormalizedNote>,
  byBasename: ReadonlyMap<string, readonly NormalizedNote[]>,
): NormalizedNote | null {
  for (const candidate of targetCandidates(source.path, link)) {
    const exact = byPath.get(candidate);
    if (exact !== undefined) return exact;
  }
  const decoded = decodedTarget(link.target);
  return decoded === null ? null : uniqueBasenameTarget(decoded, byBasename);
}

function addEdge(edges: Map<string, GraphEdgeV1>, kind: GraphEdgeV1["kind"], source: string, target: string): void {
  const id = edgeId(kind, source, target);
  edges.set(id, { id, kind, source, target });
}

export function buildGraphProjection(
  notes: readonly GraphSourceNote[],
  pairs: ReadonlyMap<string, { notionUrl: string }>,
  installationId: string,
  domainRules: readonly GraphDomainRule[] = [],
): GraphProjectionV1 {
  if (!Array.isArray(notes)) throw new Error("Graph notes must be an array");
  const normalizedNotes: NormalizedNote[] = [];
  const seenPaths = new Set<string>();
  for (const source of notes) {
    if (source === null || typeof source !== "object") throw new Error("Invalid graph source note");
    const normalizedPath = normalizeGraphPath(source.path);
    if (seenPaths.has(normalizedPath)) throw new Error("Duplicate normalized path in graph projection");
    seenPaths.add(normalizedPath);
    const note = normalizeSourceNote(source, domainRules);
    if (note === null) continue;
    normalizedNotes.push(note);
  }
  normalizedNotes.sort((left, right) => compareLexically(left.path, right.path));

  const pairByPath = normalizedPairs(pairs);
  const byPath = new Map(normalizedNotes.map((note) => [note.path, note]));
  const byBasenameMutable = new Map<string, NormalizedNote[]>();
  for (const note of normalizedNotes) {
    const basename = markdownStem(note.path.split("/").at(-1) as string);
    const matches = byBasenameMutable.get(basename) ?? [];
    matches.push(note);
    byBasenameMutable.set(basename, matches);
  }
  const byBasename = new Map<string, readonly NormalizedNote[]>(
    [...byBasenameMutable].map(([basename, matches]) => [basename, matches]),
  );

  const nodes: GraphNodeV1[] = [
    {
      id: VAULT_ID,
      label: VAULT_LABEL,
      path: null,
      kind: "vault",
      domain: "other",
      tags: [],
      notionUrl: null,
      obsidianUrl: null,
      collapsed: false,
    },
  ];
  const edges = new Map<string, GraphEdgeV1>();
  const clusters = new Map<string, { readonly id: string; readonly domain: GraphDomain }>();

  for (const note of normalizedNotes) {
    if (note.topLevel !== null && !clusters.has(note.topLevel)) {
      const domain = classifyDomain(`${note.topLevel}/placeholder.md`, domainRules);
      const id = clusterId(note.topLevel);
      clusters.set(note.topLevel, { id, domain });
      nodes.push({
        id,
        label: note.topLevel,
        path: null,
        kind: "cluster",
        domain,
        tags: [],
        notionUrl: null,
        obsidianUrl: null,
        collapsed: domain === "github",
      });
      addEdge(edges, "vault", VAULT_ID, id);
    }
    nodes.push({
      id: note.id,
      label: note.basename,
      path: note.path,
      kind: "note",
      domain: note.domain,
      tags: [...note.tags],
      notionUrl: pairByPath.get(note.path)?.notionUrl ?? null,
      obsidianUrl: obsidianUrl(note.path),
      collapsed: note.domain === "github" && isGithubSecondary(note.tags),
    });
    const cluster = note.topLevel === null ? undefined : clusters.get(note.topLevel);
    if (cluster === undefined) {
      addEdge(edges, "vault", VAULT_ID, note.id);
    } else {
      addEdge(edges, "cluster", cluster.id, note.id);
    }
  }

  for (const source of normalizedNotes) {
    for (const link of extractGraphLinks(source.markdown)) {
      const target = resolveLink(source, link, byPath, byBasename);
      if (target !== null) addEdge(edges, link.kind, source.id, target.id);
    }
  }

  return parseGraphProjection({
    schemaVersion: 1,
    installationId,
    nodes: nodes.sort((left, right) => compareLexically(left.id, right.id)),
    edges: [...edges.values()].sort((left, right) => compareLexically(left.id, right.id)),
    conflicts: normalizedNotes.filter((note) => note.conflict).length,
  });
}
