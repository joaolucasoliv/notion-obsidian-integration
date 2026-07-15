import { describe, expect, it } from "vitest";
import type { GraphDocumentV1, GraphEnvelopeV1, GraphProjectionV1 } from "../contracts/graph";
import { base64url, fromBase64url } from "./base64url";
import { canonicalJson } from "./canonical-json";
import {
  MAX_GRAPH_DECOMPRESSED_BYTES,
  canonicalGraphHash,
  decryptGraph,
  encryptGraph,
} from "./graph-envelope";

const INSTALLATION_ID = "5c343dbe-23b1-4e13-af1e-ffed61ecb290";
const OTHER_INSTALLATION_ID = "0bd79300-8068-4f26-9490-c1a923574d1d";
const CREATED_AT = "2026-07-14T12:00:00.000Z";
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const WRONG_KEY = Uint8Array.from({ length: 32 }, (_, index) => 32 - index);
const NONCE = Uint8Array.from({ length: 12 }, (_, index) => index + 9);

function graphFixture(): GraphProjectionV1 {
  return {
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    nodes: [
      {
        id: "cluster-research",
        label: "Research",
        path: null,
        kind: "cluster",
        domain: "research",
        tags: ["cluster", "research"],
        notionUrl: null,
        obsidianUrl: null,
        collapsed: false,
      },
      {
        id: "note-alpha",
        label: "Alpha note",
        path: "Research/Alpha.md",
        kind: "note",
        domain: "research",
        tags: ["alpha", "research"],
        notionUrl: "https://www.notion.so/fixture-alpha",
        obsidianUrl: "obsidian://open?vault=Fixture&file=Research%2FAlpha.md",
        collapsed: false,
      },
      {
        id: "vault",
        label: "Fixture vault",
        path: null,
        kind: "vault",
        domain: "other",
        tags: [],
        notionUrl: null,
        obsidianUrl: null,
        collapsed: false,
      },
    ],
    edges: [
      { id: "edge-cluster-note", source: "cluster-research", target: "note-alpha", kind: "cluster" },
      { id: "edge-vault-cluster", source: "vault", target: "cluster-research", kind: "vault" },
    ],
    conflicts: 0,
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      chunks.push(value);
      length += value.byteLength;
    }
  }

  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function encryptRawDocument(
  document: unknown,
  metadata: Pick<GraphEnvelopeV1, "installationId" | "keyId" | "sequence" | "createdAt"> = {
    installationId: INSTALLATION_ID,
    keyId: "key-2",
    sequence: 7,
    createdAt: CREATED_AT,
  },
): Promise<GraphEnvelopeV1> {
  const gzip = new CompressionStream("gzip");
  const bytes = new TextEncoder().encode(canonicalJson(document));
  const compressed = await collect(new Blob([bytes]).stream().pipeThrough(gzip));
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", KEY, "AES-GCM", false, ["encrypt"]);
  const additionalData = new TextEncoder().encode(canonicalJson({ version: 1, algorithm: "A256GCM", ...metadata }));
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: NONCE, additionalData, tagLength: 128 },
    cryptoKey,
    compressed,
  );

  return {
    version: 1,
    algorithm: "A256GCM",
    ...metadata,
    nonce: base64url(NONCE),
    ciphertext: base64url(new Uint8Array(ciphertext)),
  };
}

describe("encrypted graph envelopes", () => {
  it("round-trips a graph and authenticates all mutable envelope metadata", async () => {
    const projection = graphFixture();
    const envelope = await encryptGraph({
      projection,
      key: KEY,
      installationId: INSTALLATION_ID,
      keyId: "key-2",
      sequence: 7,
      createdAt: CREATED_AT,
      nonce: NONCE,
    });

    expect(await decryptGraph(envelope, KEY)).toEqual({
      ...projection,
      sequence: 7,
      generatedAt: CREATED_AT,
    });

    await expect(decryptGraph({ ...envelope, installationId: OTHER_INSTALLATION_ID }, KEY)).rejects.toThrow(
      /authenticate|decrypt/i,
    );
    await expect(decryptGraph({ ...envelope, keyId: "key-3" }, KEY)).rejects.toThrow(/authenticate|decrypt/i);
    await expect(decryptGraph({ ...envelope, sequence: 6 }, KEY)).rejects.toThrow(/authenticate|decrypt/i);
    await expect(decryptGraph({ ...envelope, createdAt: "2026-07-14T12:00:01.000Z" }, KEY)).rejects.toThrow(
      /authenticate|decrypt/i,
    );

    const tamperedNonce = Uint8Array.from(NONCE, (byte) => byte ^ 1);
    await expect(decryptGraph({ ...envelope, nonce: base64url(tamperedNonce) }, KEY)).rejects.toThrow(/authenticate|decrypt/i);

    const tamperedCiphertext = fromBase64url(envelope.ciphertext);
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 1;
    await expect(decryptGraph({ ...envelope, ciphertext: base64url(tamperedCiphertext) }, KEY)).rejects.toThrow(
      /authenticate|decrypt/i,
    );
  });

  it("rejects invalid AES-256-GCM key and nonce lengths", async () => {
    const projection = graphFixture();
    const input = {
      projection,
      key: KEY,
      installationId: INSTALLATION_ID,
      keyId: "key-2",
      sequence: 7,
      createdAt: CREATED_AT,
      nonce: NONCE,
    };

    await expect(encryptGraph({ ...input, key: KEY.slice(1) })).rejects.toThrow(/32.*key|key.*32/i);
    await expect(encryptGraph({ ...input, nonce: NONCE.slice(1) })).rejects.toThrow(/12.*nonce|nonce.*12/i);

    const envelope = await encryptGraph(input);
    await expect(decryptGraph(envelope, KEY.slice(1))).rejects.toThrow(/32.*key|key.*32/i);
  });

  it("rejects a validly authenticated document whose mirrored metadata does not match its envelope", async () => {
    const projection = graphFixture();
    const document: GraphDocumentV1 = { ...projection, sequence: 6, generatedAt: CREATED_AT };
    const envelope = await encryptRawDocument(document);

    await expect(decryptGraph(envelope, KEY)).rejects.toThrow(/metadata|match/i);
  });

  it("rejects a graph document after decompression when it exceeds the fixed v1 size cap", async () => {
    const envelope = await encryptRawDocument({ padding: "x".repeat(MAX_GRAPH_DECOMPRESSED_BYTES + 1) });

    await expect(decryptGraph(envelope, KEY)).rejects.toThrow(/decompressed|size|large/i);
  });

  it("rejects a wrong graph key without exposing plaintext", async () => {
    const envelope = await encryptGraph({
      projection: graphFixture(),
      key: KEY,
      installationId: INSTALLATION_ID,
      keyId: "key-2",
      sequence: 7,
      createdAt: CREATED_AT,
      nonce: NONCE,
    });

    await expect(decryptGraph(envelope, WRONG_KEY)).rejects.toThrow(/authenticate|decrypt/i);
  });

  it("uses canonical graph bytes so a fixed test nonce produces a deterministic v1 envelope", async () => {
    const ordered = graphFixture();
    const reordered: GraphProjectionV1 = {
      ...ordered,
      nodes: [...ordered.nodes].reverse().map((node) => ({ ...node, tags: [...node.tags].reverse() })),
      edges: [...ordered.edges].reverse(),
    };

    expect(await canonicalGraphHash(reordered)).toBe(await canonicalGraphHash(ordered));

    const input = {
      key: KEY,
      installationId: INSTALLATION_ID,
      keyId: "key-2",
      sequence: 7,
      createdAt: CREATED_AT,
      nonce: NONCE,
    };
    expect(await encryptGraph({ ...input, projection: reordered })).toEqual(await encryptGraph({ ...input, projection: ordered }));
  });
});
