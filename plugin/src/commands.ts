export class NoteCommandError extends Error {
  public constructor() {
    super("Bridge note action unavailable");
    this.name = "NoteCommandError";
  }
}

export interface ChangeNoteOptInInput {
  readonly path: string;
  readonly bytes: string;
  readonly optedIn: boolean;
}

function invalid(): never {
  throw new NoteCommandError();
}

function excludedPath(path: unknown): boolean {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    return true;
  }
  const segments = path.split("/");
  const basename = segments.at(-1)?.toLowerCase() ?? "";
  return (
    segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.startsWith(".") || segment.toLowerCase() === "templates") ||
    segments.includes("Bridge Conflicts") ||
    basename.endsWith(".bridge-conflict.md") ||
    path === "Grandbox Bridge.md"
  );
}

export function isManageableMarkdownPath(path: unknown): path is string {
  return typeof path === "string" && path.toLowerCase().endsWith(".md") && !excludedPath(path);
}

function generatedGithub(bytes: string): boolean {
  return bytes.includes("<!-- dual-scribe-github:") || /(^|[\s[,])dual-scribe\/github\//u.test(bytes);
}

interface FrontmatterRange {
  readonly closeStart: number;
  readonly lineEnding: "\n" | "\r\n";
}

function frontmatterRange(bytes: string): FrontmatterRange | null {
  const opening = bytes.startsWith("---\r\n") ? "\r\n" : bytes.startsWith("---\n") ? "\n" : null;
  if (opening === null) return null;
  const remaining = bytes.slice(3 + opening.length);
  const match = /(?:^|\n)---(?=\r?\n|$)/u.exec(remaining);
  if (match === null || match.index === undefined) invalid();
  const closeStart = 3 + opening.length + match.index + (match[0].startsWith("\n") ? 1 : 0);
  return { closeStart, lineEnding: opening };
}

function changeExistingFrontmatter(bytes: string, range: FrontmatterRange, optedIn: boolean): string {
  const yaml = bytes.slice(0, range.closeStart);
  const lines = yaml.split(/(?<=\n)/u);
  let matches = 0;
  let invalidOwnedField = false;
  const updated = lines.map((line) => {
    if (/^[ \t]*notion_sync[ \t]*:/u.test(line)) {
      const field = /^([ \t]*notion_sync[ \t]*:[ \t]*)(true|false)([ \t]*(?:#.*)?)(\r?\n?)$/u.exec(line);
      if (field === null) {
        invalidOwnedField = true;
        return line;
      }
      matches += 1;
      return `${field[1]}${optedIn ? "true" : "false"}${field[3]}${field[4]}`;
    }
    return line;
  });
  if (invalidOwnedField || matches > 1 || (!optedIn && matches === 0)) invalid();
  if (matches === 0) {
    return `${bytes.slice(0, range.closeStart)}notion_sync: true${range.lineEnding}${bytes.slice(range.closeStart)}`;
  }
  return `${updated.join("")}${bytes.slice(range.closeStart)}`;
}

/** Changes only the owned `notion_sync` line and rejects all unsafe/excluded notes. */
export function changeNoteOptIn(input: ChangeNoteOptInInput): string {
  if (typeof input !== "object" || input === null || typeof input.bytes !== "string" || typeof input.optedIn !== "boolean") invalid();
  if (!isManageableMarkdownPath(input.path) || generatedGithub(input.bytes)) invalid();
  const range = frontmatterRange(input.bytes);
  if (range === null) {
    if (!input.optedIn) invalid();
    return `---\nnotion_sync: true\n---\n${input.bytes}`;
  }
  return changeExistingFrontmatter(input.bytes, range, input.optedIn);
}
