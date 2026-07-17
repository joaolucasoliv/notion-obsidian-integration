import { isAbsolute, relative, sep } from "node:path";

export const CORTEX_ROOT_FILE_PATH = "The Cortex.md" as const;
export const CORTEX_ROOT_DIRECTORY_PATH = "The Cortex" as const;

const CORTEX_DIRECTORY_PREFIX = `${CORTEX_ROOT_DIRECTORY_PATH}/`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_TITLE_BYTES = 200;
const WINDOWS_RESERVED_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export class CortexPathError extends Error {
  public constructor() {
    super("Invalid Cortex local path");
    this.name = "CortexPathError";
  }
}

export interface CortexPathPage {
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly rootPageId: string;
  readonly title: string;
}

export interface CortexLocalPathProjection {
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly rootPageId: string;
  readonly title: string;
  /** Null only for the immutable root page. */
  readonly parentLocalPath: string | null;
}

export interface CortexTreePathProjection {
  readonly rootPageId: string;
  readonly pages: readonly CortexPathPage[];
  /** Existing user notes that must never be overwritten by a projected Cortex path. */
  readonly occupiedPaths?: readonly string[];
  /** Existing legacy direct-pair paths that must remain disjoint from Cortex. */
  readonly legacyPaths?: readonly string[];
}

function invalidPath(): CortexPathError {
  return new CortexPathError();
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function assertSafeRelativePath(value: unknown): asserts value is string {
  if (typeof value !== "string") throw invalidPath();
  const segments = value.split("/");
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1_024 ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    /[\r\n]/u.test(value) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw invalidPath();
  }
}

function assertSafeTitle(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value, "utf8") > MAX_TITLE_BYTES ||
    value === "." ||
    value === ".." ||
    value.endsWith(".") ||
    value.endsWith(" ") ||
    /[\\/:*?"<>|#^\u0000-\u001f\u007f]/u.test(value) ||
    WINDOWS_RESERVED_NAMES.has(value.toLocaleLowerCase("en-US"))
  ) {
    throw invalidPath();
  }
}

/** The root always maps to a fixed filename, so outer title whitespace cannot affect a local path. */
function assertSafeRootTitle(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value, "utf8") > MAX_TITLE_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidPath();
  }
}

function pathKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

function isBeneath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

/** True only for the two immutable local roots reserved for Cortex content. */
export function isCortexLocalPath(path: string): boolean {
  try {
    assertSafeRelativePath(path);
    return path === CORTEX_ROOT_FILE_PATH || path.startsWith(CORTEX_DIRECTORY_PREFIX);
  } catch {
    return false;
  }
}

/** Returns the paired parent page file for a reserved descendant Markdown path. */
export function cortexParentFilePath(path: string): string {
  assertSafeRelativePath(path);
  if (!path.startsWith(CORTEX_DIRECTORY_PREFIX) || !path.endsWith(".md")) throw invalidPath();
  const segments = path.split("/");
  if (segments.length === 2) return CORTEX_ROOT_FILE_PATH;
  const fileName = segments.pop();
  if (fileName === undefined || fileName.length <= 3) throw invalidPath();
  const parentName = segments.pop();
  if (parentName === undefined || parentName.length === 0) throw invalidPath();
  return `${segments.join("/")}/${parentName}.md`;
}

/** Projects one immutable regular-page identity into the fixed local hierarchy. */
export function projectCortexLocalPath(input: Readonly<CortexLocalPathProjection>): string {
  if (
    typeof input !== "object" ||
    input === null ||
    !isCanonicalUuid(input.pageId) ||
    !isCanonicalUuid(input.rootPageId) ||
    (input.parentPageId !== null && !isCanonicalUuid(input.parentPageId))
  ) {
    throw invalidPath();
  }
  if (input.pageId === input.rootPageId) {
    assertSafeRootTitle(input.title);
    if (input.parentPageId !== null || input.parentLocalPath !== null) throw invalidPath();
    return CORTEX_ROOT_FILE_PATH;
  }

  assertSafeTitle(input.title);
  if (input.parentPageId === null || input.parentLocalPath === null) throw invalidPath();
  assertSafeRelativePath(input.parentLocalPath);
  if (
    input.parentLocalPath !== CORTEX_ROOT_FILE_PATH &&
    (!input.parentLocalPath.startsWith(CORTEX_DIRECTORY_PREFIX) || !input.parentLocalPath.endsWith(".md"))
  ) {
    throw invalidPath();
  }

  const parentBase = input.parentLocalPath === CORTEX_ROOT_FILE_PATH
    ? CORTEX_ROOT_DIRECTORY_PATH
    : input.parentLocalPath.slice(0, -3);
  const projected = `${parentBase}/${input.title}.md`;
  assertSafeRelativePath(projected);
  if (!projected.startsWith(CORTEX_DIRECTORY_PREFIX) || !isBeneath(CORTEX_ROOT_DIRECTORY_PATH, projected)) {
    throw invalidPath();
  }
  return projected;
}

function assertNoCollision(paths: Iterable<string>, occupied: readonly string[] | undefined): void {
  if (occupied === undefined) return;
  if (!Array.isArray(occupied)) throw invalidPath();
  const occupiedKeys = new Set<string>();
  for (const candidate of occupied) {
    assertSafeRelativePath(candidate);
    const key = pathKey(candidate);
    if (occupiedKeys.has(key)) throw invalidPath();
    occupiedKeys.add(key);
  }
  for (const path of paths) {
    if (occupiedKeys.has(pathKey(path))) throw invalidPath();
  }
}

/**
 * Validates the one-to-one page/path relation for a complete known Cortex tree.
 * The caller supplies any normal and legacy paths already allocated in the vault.
 */
export function projectCortexTreePaths(input: Readonly<CortexTreePathProjection>): ReadonlyMap<string, string> {
  if (
    typeof input !== "object" ||
    input === null ||
    !isCanonicalUuid(input.rootPageId) ||
    !Array.isArray(input.pages) ||
    input.pages.length === 0 ||
    input.pages.length > 5_000
  ) {
    throw invalidPath();
  }

  const pages = new Map<string, CortexPathPage>();
  for (const page of input.pages) {
    if (
      typeof page !== "object" ||
      page === null ||
      !isCanonicalUuid(page.pageId) ||
      !isCanonicalUuid(page.rootPageId) ||
      page.rootPageId !== input.rootPageId ||
      (page.parentPageId !== null && !isCanonicalUuid(page.parentPageId)) ||
      pages.has(page.pageId)
    ) {
      throw invalidPath();
    }
    if (page.pageId === input.rootPageId) {
      assertSafeRootTitle(page.title);
    } else {
      assertSafeTitle(page.title);
    }
    pages.set(page.pageId, page);
  }

  const root = pages.get(input.rootPageId);
  if (root === undefined || root.parentPageId !== null) throw invalidPath();

  const paths = new Map<string, string>();
  const resolving = new Set<string>();
  const resolve = (pageId: string): string => {
    const existing = paths.get(pageId);
    if (existing !== undefined) return existing;
    const page = pages.get(pageId);
    if (page === undefined || resolving.has(pageId)) throw invalidPath();
    resolving.add(pageId);
    try {
      const parentPath = page.pageId === input.rootPageId
        ? null
        : page.parentPageId === null
          ? (() => { throw invalidPath(); })()
          : resolve(page.parentPageId);
      const projected = projectCortexLocalPath({ ...page, parentLocalPath: parentPath });
      paths.set(pageId, projected);
      return projected;
    } finally {
      resolving.delete(pageId);
    }
  };

  for (const pageId of pages.keys()) resolve(pageId);
  const seenPaths = new Set<string>();
  for (const path of paths.values()) {
    const key = pathKey(path);
    if (seenPaths.has(key)) throw invalidPath();
    seenPaths.add(key);
  }
  assertNoCollision(paths.values(), input.occupiedPaths);
  assertNoCollision(paths.values(), input.legacyPaths);
  return paths;
}
