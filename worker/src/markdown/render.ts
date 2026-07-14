import type { SemanticNote } from "@grandbox-bridge/shared";
import {
  parseLocalNote,
  replaceSyncedTags,
  type ParsedLocalNote,
} from "./frontmatter.js";
import { normalizeLineEndings } from "./parse.js";

export function renderLocalNote(note: ParsedLocalNote, semantic: SemanticNote): string {
  const original = parseLocalNote(note.path, note.bytes);
  const withTags = replaceSyncedTags(note.bytes, semantic.tags);
  const tagged = parseLocalNote(note.path, withTags);
  const bodyStart = withTags.length - tagged.body.length;
  const lineEnding = withTags.startsWith("---\r\n") ? "\r\n" : "\n";
  const body = normalizeLineEndings(semantic.bodyMarkdown).replaceAll("\n", lineEnding);
  const rendered = `${withTags.slice(0, bodyStart)}${body}`;
  const verified = parseLocalNote(note.path, rendered);

  if (
    verified.notionSync !== original.notionSync ||
    verified.bridgeId !== original.bridgeId ||
    verified.body !== body
  ) {
    throw new Error("Invalid local note render");
  }
  return rendered;
}
