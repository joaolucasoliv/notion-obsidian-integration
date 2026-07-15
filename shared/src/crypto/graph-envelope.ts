import type { GraphDocumentV1, GraphEnvelopeV1, GraphProjectionV1 } from "../contracts/graph.ts";
import { sha256Hex } from "./hash.ts";
import { fromBase64url, base64url } from "./base64url.ts";
import { canonicalJson } from "./canonical-json.ts";
import { parseGraphDocument, parseGraphEnvelope, parseGraphProjection } from "../schemas/graph.ts";

export const MAX_GRAPH_DECOMPRESSED_BYTES = 5 * 1024 * 1024;

export interface EncryptGraphInput {
  projection: GraphProjectionV1;
  key: Uint8Array;
  installationId: string;
  keyId: string;
  sequence: number;
  createdAt: string;
  nonce: Uint8Array;
}

function compareLexically(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalProjection(projection: GraphProjectionV1): GraphProjectionV1 {
  const parsed = parseGraphProjection(projection);
  return {
    ...parsed,
    nodes: parsed.nodes
      .map((node) => ({ ...node, tags: [...node.tags].sort(compareLexically) }))
      .sort((left, right) => compareLexically(left.id, right.id)),
    edges: [...parsed.edges].sort((left, right) => compareLexically(left.id, right.id)),
  };
}

function canonicalDocument(document: GraphDocumentV1): GraphDocumentV1 {
  const { sequence, generatedAt, ...projection } = document;
  const canonicalizedProjection = canonicalProjection(projection);
  return {
    ...canonicalizedProjection,
    sequence,
    generatedAt,
  };
}

function validateKey(key: Uint8Array): Uint8Array {
  if (key.byteLength !== 32) throw new Error("Expected a 32-byte AES-256-GCM key");
  const copy = new Uint8Array(key.byteLength);
  copy.set(key);
  return copy;
}

function validateNonce(nonce: Uint8Array): Uint8Array {
  if (nonce.byteLength !== 12) throw new Error("Expected a 12-byte AES-GCM nonce");
  const copy = new Uint8Array(nonce.byteLength);
  copy.set(nonce);
  return copy;
}

function toWebArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy: Uint8Array<ArrayBuffer> = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function envelopeAdditionalData(envelope: Pick<GraphEnvelopeV1, "version" | "algorithm" | "installationId" | "keyId" | "sequence" | "createdAt">): Uint8Array {
  const { version, algorithm, installationId, keyId, sequence, createdAt } = envelope;
  return new TextEncoder().encode(canonicalJson({ version, algorithm, installationId, keyId, sequence, createdAt }));
}

async function readStream(stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new Error("Decompressed graph exceeds the fixed v1 size cap");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return readStream(
    new Blob([toWebArrayBuffer(bytes)]).stream().pipeThrough(new CompressionStream("gzip")),
    Number.MAX_SAFE_INTEGER,
  );
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await readStream(
      new Blob([toWebArrayBuffer(bytes)]).stream().pipeThrough(new DecompressionStream("gzip")),
      MAX_GRAPH_DECOMPRESSED_BYTES,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("fixed v1 size cap")) throw error;
    throw new Error("Unable to decompress graph envelope");
  }
}

export async function canonicalGraphHash(projection: GraphProjectionV1): Promise<string> {
  return sha256Hex(canonicalJson(canonicalProjection(projection)));
}

export async function encryptGraph(input: EncryptGraphInput): Promise<GraphEnvelopeV1> {
  const key = validateKey(input.key);
  const nonce = validateNonce(input.nonce);
  const projection = canonicalProjection(input.projection);
  if (projection.installationId !== input.installationId) {
    throw new Error("Graph projection installationId must match its envelope");
  }

  const document = parseGraphDocument({
    ...projection,
    sequence: input.sequence,
    generatedAt: input.createdAt,
  });
  if (input.keyId.length === 0 || input.keyId.length > 256) {
    throw new Error("Expected a non-empty graph keyId");
  }

  const plaintext = new TextEncoder().encode(canonicalJson(canonicalDocument(document)));
  if (plaintext.byteLength > MAX_GRAPH_DECOMPRESSED_BYTES) {
    throw new Error("Graph document exceeds the fixed v1 decompressed size cap");
  }

  const metadata = {
    version: 1 as const,
    algorithm: "A256GCM" as const,
    installationId: input.installationId,
    keyId: input.keyId,
    sequence: input.sequence,
    createdAt: input.createdAt,
  };
  const cryptoKey = await globalThis.crypto.subtle.importKey("raw", toWebArrayBuffer(key), "AES-GCM", false, ["encrypt"]);
  const ciphertext = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toWebArrayBuffer(nonce),
      additionalData: toWebArrayBuffer(envelopeAdditionalData(metadata)),
      tagLength: 128,
    },
    cryptoKey,
    toWebArrayBuffer(await gzip(plaintext)),
  );

  return parseGraphEnvelope({
    ...metadata,
    nonce: base64url(nonce),
    ciphertext: base64url(new Uint8Array(ciphertext)),
  });
}

export async function decryptGraph(envelope: GraphEnvelopeV1, keyMaterial: Uint8Array): Promise<GraphDocumentV1> {
  const parsedEnvelope = parseGraphEnvelope(envelope);
  const key = validateKey(keyMaterial);
  const nonce = fromBase64url(parsedEnvelope.nonce);
  if (nonce.byteLength !== 12) throw new Error("Expected a 12-byte AES-GCM nonce");

  const ciphertext = fromBase64url(parsedEnvelope.ciphertext);
  if (ciphertext.byteLength < 16) throw new Error("Unable to decrypt or authenticate graph envelope");

  let compressed: Uint8Array;
  try {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "raw",
      toWebArrayBuffer(key),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const decrypted = await globalThis.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toWebArrayBuffer(nonce),
        additionalData: toWebArrayBuffer(envelopeAdditionalData(parsedEnvelope)),
        tagLength: 128,
      },
      cryptoKey,
      toWebArrayBuffer(ciphertext),
    );
    compressed = new Uint8Array(decrypted);
  } catch {
    throw new Error("Unable to decrypt or authenticate graph envelope");
  }

  const plaintext = await gunzip(compressed);
  let documentInput: unknown;
  try {
    documentInput = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch {
    throw new Error("Unable to parse decrypted graph document");
  }

  let document: GraphDocumentV1;
  try {
    document = parseGraphDocument(documentInput);
  } catch {
    throw new Error("Decrypted graph document failed schema validation");
  }

  if (
    document.installationId !== parsedEnvelope.installationId ||
    document.sequence !== parsedEnvelope.sequence ||
    document.generatedAt !== parsedEnvelope.createdAt
  ) {
    throw new Error("Decrypted graph document metadata does not match its envelope");
  }

  return document;
}
