import { describe, expect, it } from "vitest";
import {
  LocalNoteParseError,
  parseLocalNote,
  replaceSyncedTags,
  type ParsedLocalNote,
  upsertBridgeId,
} from "./frontmatter.js";

const BRIDGE_ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const OTHER_BRIDGE_ID = "26cad23b-f8f7-448f-a70e-e84c1861dd8d";

function assertParsedContractIsWritable(note: ParsedLocalNote): void {
  note.path = note.path;
  note.bytes = note.bytes;
  note.frontmatter = note.frontmatter;
  note.body = note.body;
  note.notionSync = note.notionSync;
  note.bridgeId = note.bridgeId;
  note.tags = note.tags;
}

function expectSafeParseFailure(action: () => unknown): void {
  try {
    action();
    throw new Error("expected the local-note parser to reject the fixture");
  } catch (caught) {
    expect(caught).toBeInstanceOf(LocalNoteParseError);
    expect(caught).toMatchObject({ message: "Invalid local note" });
    expect(String(caught)).not.toContain("fixture-secret");
  }
}

describe("parseLocalNote", () => {
  it("returns the exact mutable contract while preserving the original bytes and body", () => {
    const bytes = `---\n# keep this\nnotion_sync: true\nbridge_id: ${BRIDGE_ID}\ntags: [research, active]\ncustom:\n  nested: 7\n---\nBody  \n`;

    const parsed = parseLocalNote("Research/Example.md", bytes);

    expect(parsed.path).toBe("Research/Example.md");
    expect(parsed.bytes).toBe(bytes);
    expect(parsed.body).toBe("Body  \n");
    expect(parsed.notionSync).toBe(true);
    expect(parsed.bridgeId).toBe(BRIDGE_ID);
    expect(parsed.tags).toEqual(["research", "active"]);
    expect(parsed.frontmatter.custom).toEqual({ nested: 7 });
    expect(Object.keys(parsed).sort()).toEqual([
      "body",
      "bridgeId",
      "bytes",
      "frontmatter",
      "notionSync",
      "path",
      "tags",
    ]);
    expect(Object.getPrototypeOf(parsed.frontmatter)).toBeNull();
    expect(Object.isFrozen(parsed.frontmatter)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(false);
    expect(Object.isFrozen(parsed.tags)).toBe(false);

    assertParsedContractIsWritable(parsed);
    parsed.path = "Research/Renamed.md";
    parsed.tags.push("mutable-contract");
    expect(parsed.path).toBe("Research/Renamed.md");
    expect(parsed.tags).toEqual(["research", "active", "mutable-contract"]);
    expect(parsed.bytes).toBe(bytes);
    expect(bytes.endsWith("Body  \n")).toBe(true);
  });

  it("treats a note without a document-start frontmatter delimiter as not opted in", () => {
    const bytes = "Heading\n---\nnotion_sync: true\n---\nBody";
    const parsed = parseLocalNote("Notes/plain.md", bytes);

    expect(Object.keys(parsed.frontmatter)).toEqual([]);
    expect(parsed.body).toBe(bytes);
    expect(parsed.notionSync).toBe(false);
    expect(parsed.bridgeId).toBeNull();
    expect(parsed.tags).toEqual([]);
  });

  it.each([
    "---\nnotion_sync: true\nnotion_sync: false\n---\nfixture-secret",
    "---\nnotion_sync: true\ncustom:\n  repeated: one\n  repeated: two\n---\nfixture-secret",
    "---\n\"notion_sync\": true\nnotion_sync: false\n---\nfixture-secret",
  ])("rejects duplicate YAML keys at every mapping depth", (bytes) => {
    expectSafeParseFailure(() => parseLocalNote("Notes/duplicate.md", bytes));
  });

  it.each([
    ["root plain", "---\n<<: { injected: fixture-secret }\nnotion_sync: true\n---\nBody"],
    ["root quoted", "---\n\"<<\": { injected: fixture-secret }\nnotion_sync: true\n---\nBody"],
    ["root explicit", "---\n? <<\n: { injected: fixture-secret }\nnotion_sync: true\n---\nBody"],
    ["nested plain", "---\nnotion_sync: true\ncustom:\n  <<: { injected: fixture-secret }\n---\nBody"],
    ["nested quoted", "---\nnotion_sync: true\ncustom:\n  \"<<\": { injected: fixture-secret }\n---\nBody"],
    ["nested explicit", "---\nnotion_sync: true\ncustom:\n  ? <<\n  : { injected: fixture-secret }\n---\nBody"],
  ])("rejects the YAML merge mapping key at every depth: %s", (_label, bytes) => {
    expectSafeParseFailure(() => parseLocalNote("Notes/merge-key.md", bytes));
  });

  it("allows merge-looking scalar values that are not mapping keys", () => {
    const parsed = parseLocalNote(
      "Notes/scalar-value.md",
      "---\nnotion_sync: true\ncustom: \"<<\"\ntags: [\"<<\"]\n---\nBody",
    );
    expect(parsed.frontmatter.custom).toBe("<<");
    expect(parsed.tags).toEqual(["<<"]);
  });

  it.each([
    "---\nnotion_sync: true\nfixture-secret",
    "---\nnotion_sync: true\n-- -\nfixture-secret",
    "---\nnotion_sync: [true\n---\nfixture-secret",
    "---\n- notion_sync\n- true\n---\nfixture-secret",
    "---\nnotion_sync: true\n...\nextra: fixture-secret\n---\n",
  ])("rejects malformed or non-mapping frontmatter", (bytes) => {
    expectSafeParseFailure(() => parseLocalNote("Notes/malformed.md", bytes));
  });

  it.each([
    "---\nnotion_sync: &enabled true\ncopy: *enabled\n---\nfixture-secret",
    "---\nnotion_sync: !!str true\n---\nfixture-secret",
    "---\nnotion_sync: !fixture true\n---\nfixture-secret",
    "---\nnotion_sync: true\n__proto__: { polluted: true }\n---\nfixture-secret",
    "---\nnotion_sync: true\ncustom:\n  constructor: fixture-secret\n---\n",
  ])("rejects aliases, explicit tags, and prototype-sensitive keys", (bytes) => {
    expectSafeParseFailure(() => parseLocalNote("Notes/unsupported.md", bytes));
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([
    "---\nnotion_sync: \"true\"\n---\nfixture-secret",
    "---\nnotion_sync: 1\n---\nfixture-secret",
    "---\nnotion_sync: true\nbridge_id: not-a-uuid\n---\nfixture-secret",
    "---\nnotion_sync: true\nbridge_id: null\n---\nfixture-secret",
    "---\nnotion_sync: true\ntags: [valid, 7]\n---\nfixture-secret",
    "---\nnotion_sync: true\ntags: { invalid: value }\n---\nfixture-secret",
    `---\nnotion_sync: true\ntags: [${"x".repeat(257)}]\n---\nfixture-secret`,
  ])("rejects invalid owned-field types and values", (bytes) => {
    expectSafeParseFailure(() => parseLocalNote("Notes/owned.md", bytes));
  });

  it.each([
    "/absolute.md",
    "../escape.md",
    "Notes/../escape.md",
    "./Notes/note.md",
    "Notes//note.md",
    "C:/Users/jo/note.md",
    "C:\\Users\\jo\\note.md",
    "Notes\\note.md",
    "Notes/note.md\0suffix",
  ])("rejects an unsafe or non-normalized note path: %s", (path) => {
    expectSafeParseFailure(() => parseLocalNote(path, "plain body"));
  });
});

describe("upsertBridgeId", () => {
  it("adds only bridge_id and preserves comments, key order, and body bytes", () => {
    const before = `---\n# keep this\nnotion_sync: true\ntags: [research, active]\ncustom: 7\n---\nBody  \n`;
    const after = upsertBridgeId(before, BRIDGE_ID);
    expect(after).toBe(`---\n# keep this\nnotion_sync: true\ntags: [research, active]\ncustom: 7\nbridge_id: ${BRIDGE_ID}\n---\nBody  \n`);
  });

  it("is byte-identical for the same existing ID and fails closed for a conflict", () => {
    const before = `---\nnotion_sync: true\nbridge_id: ${BRIDGE_ID}\n---\nBody`;

    expect(upsertBridgeId(before, BRIDGE_ID)).toBe(before);
    expectSafeParseFailure(() => upsertBridgeId(before, OTHER_BRIDGE_ID));
  });

  it("preserves CRLF and a missing final newline", () => {
    const before = "---\r\n# keep\r\nnotion_sync: true\r\n---\r\nBody  ";
    expect(upsertBridgeId(before, BRIDGE_ID)).toBe(
      `---\r\n# keep\r\nnotion_sync: true\r\nbridge_id: ${BRIDGE_ID}\r\n---\r\nBody  `,
    );
  });

  it.each(["not-a-uuid", "11111111-1111-1111-1111-111111111111", BRIDGE_ID.toUpperCase()])(
    "rejects a non-canonical bridge ID without changing bytes: %s",
    (bridgeId) => {
      const before = "---\nnotion_sync: true\n---\nfixture-secret";
      expectSafeParseFailure(() => upsertBridgeId(before, bridgeId));
      expect(before).toBe("---\nnotion_sync: true\n---\nfixture-secret");
    },
  );

  it("requires an existing valid frontmatter range and never creates notion_sync", () => {
    expectSafeParseFailure(() => upsertBridgeId("Body only", BRIDGE_ID));
    expect(upsertBridgeId("---\ncustom: 7\n---\nBody", BRIDGE_ID)).toBe(
      `---\ncustom: 7\nbridge_id: ${BRIDGE_ID}\n---\nBody`,
    );
  });
});

describe("replaceSyncedTags", () => {
  it("normalizes a flow list to sorted unique tags and preserves all bytes outside its value", () => {
    const before = `---\n# keep\nnotion_sync: true\nbridge_id: ${BRIDGE_ID}\ntags: [zeta, alpha, zeta] # keep tag comment\ncustom: 7\n---\nBody  \n`;
    const after = replaceSyncedTags(before, ["zeta", "alpha", "zeta"]);

    expect(after).toBe(`---\n# keep\nnotion_sync: true\nbridge_id: ${BRIDGE_ID}\ntags: [alpha, zeta] # keep tag comment\ncustom: 7\n---\nBody  \n`);
  });

  it("preserves scalar style for one tag and uses a deterministic empty flow list", () => {
    const scalar = "---\nnotion_sync: true\ntags: old # keep\n---\nBody";
    expect(replaceSyncedTags(scalar, ["new"])).toBe(
      "---\nnotion_sync: true\ntags: new # keep\n---\nBody",
    );
    expect(replaceSyncedTags(scalar, [])).toBe(
      "---\nnotion_sync: true\ntags: [] # keep\n---\nBody",
    );
  });

  it("preserves single- and double-quoted scalar styles when one tag remains", () => {
    const single = "---\nnotion_sync: true\ntags: 'old' # keep single\n---\nBody";
    const double = '---\nnotion_sync: true\ntags: "old" # keep double\n---\nBody';

    expect(replaceSyncedTags(single, ["rock'n'roll"])).toBe(
      "---\nnotion_sync: true\ntags: 'rock''n''roll' # keep single\n---\nBody",
    );
    expect(replaceSyncedTags(double, ['quote"tag'])).toBe(
      '---\nnotion_sync: true\ntags: "quote\\\"tag" # keep double\n---\nBody',
    );
  });

  it("preserves block-list style, indentation, per-tag comments, CRLF, and no final newline", () => {
    const before =
      "---\r\nnotion_sync: true\r\ntags:\r\n  - beta # beta note\r\n  - alpha # alpha note\r\ncustom: 7\r\n---\r\nBody";
    expect(replaceSyncedTags(before, ["beta", "alpha"])).toBe(
      "---\r\nnotion_sync: true\r\ntags:\r\n  - alpha # alpha note\r\n  - beta # beta note\r\ncustom: 7\r\n---\r\nBody",
    );
    expect(replaceSyncedTags(before, [])).toBe(
      "---\r\nnotion_sync: true\r\ntags: []\r\ncustom: 7\r\n---\r\nBody",
    );
  });

  it("inserts only the owned tags line when tags are absent and leaves empty absence byte-identical", () => {
    const before = `---\nnotion_sync: true\nbridge_id: ${BRIDGE_ID}\ncustom: 7\n---\nBody`;
    expect(replaceSyncedTags(before, ["zeta", "alpha", "zeta"])).toBe(
      `---\nnotion_sync: true\nbridge_id: ${BRIDGE_ID}\ncustom: 7\ntags: [alpha, zeta]\n---\nBody`,
    );
    expect(replaceSyncedTags(before, [])).toBe(before);
  });

  it("quotes strings when required without changing unrelated YAML or body bytes", () => {
    const before = `---\nnotion_sync: true\nbridge_id: ${BRIDGE_ID}\ntags: [old]\ncustom: \"fixture-secret\"\n---\nBody  `;
    const after = replaceSyncedTags(before, ["hash#tag", "true"]);

    expect(after).toBe(`---\nnotion_sync: true\nbridge_id: ${BRIDGE_ID}\ntags: [hash#tag, \"true\"]\ncustom: \"fixture-secret\"\n---\nBody  `);
    expect(parseLocalNote("Notes/updated.md", after).tags).toEqual(["hash#tag", "true"]);
  });

  it("renders flow-sensitive tag strings in array context and isolates the byte edit", () => {
    const prefix = `---\n# keep\nnotion_sync: true\nbridge_id: ${BRIDGE_ID}\ntags: `;
    const suffix = ` # keep tag comment\ncustom: \"fixture-secret\"\n---\nBody  `;
    const before = `${prefix}[old]${suffix}`;
    const input = [
      "comma,tag",
      "[brackets]",
      "colon: hash#tag",
      'quote"tag',
      "Olá/世界",
      "true",
      "null",
    ];
    const expectedTags = [...input].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );

    const after = replaceSyncedTags(before, input);

    expect(after.startsWith(prefix)).toBe(true);
    expect(after.endsWith(suffix)).toBe(true);
    expect(parseLocalNote("Notes/flow-sensitive.md", after).tags).toEqual(expectedTags);
  });

  it.each([
    ["", "empty"],
    [" padded", "leading whitespace"],
    ["line\nbreak", "newline"],
    ["x".repeat(257), "overlong"],
  ] as const)("rejects an %s tag without changing the note", (tag, _label) => {
    const before = "---\nnotion_sync: true\ntags: [safe]\n---\nfixture-secret";
    expectSafeParseFailure(() => replaceSyncedTags(before, [tag]));
    expect(before).toBe("---\nnotion_sync: true\ntags: [safe]\n---\nfixture-secret");
  });
});
