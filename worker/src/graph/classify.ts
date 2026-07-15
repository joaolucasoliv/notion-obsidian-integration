export type GraphDomain = "github" | "academic" | "research" | "project" | "personal" | "other";

export interface GraphDomainRule {
  pathPrefix: string;
  domain: "academic" | "research" | "project" | "personal" | "other";
}

interface NormalizedRule {
  readonly pathPrefix: string;
  readonly domain: GraphDomainRule["domain"];
  readonly specificity: number;
}

function invalidGraphPath(): Error {
  return new Error("Invalid graph path");
}

/** Resolves harmless dot segments while refusing paths that could leave the vault. */
export function normalizeGraphPath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    Buffer.byteLength(path, "utf8") > 1_024 ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    /[\r\n]/u.test(path)
  ) {
    throw invalidGraphPath();
  }

  const normalized: string[] = [];
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) {
      if (index === segments.length - 1) continue;
      throw invalidGraphPath();
    }
    if (segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) throw invalidGraphPath();
      normalized.pop();
      continue;
    }
    if (/[\u0000-\u001f\u007f]/u.test(segment)) throw invalidGraphPath();
    normalized.push(segment);
  }

  if (normalized.length === 0) throw invalidGraphPath();
  return normalized.join("/");
}

function normalizeRule(rule: GraphDomainRule): NormalizedRule {
  if (
    rule === null ||
    typeof rule !== "object" ||
    typeof rule.pathPrefix !== "string" ||
    !["academic", "research", "project", "personal", "other"].includes(rule.domain)
  ) {
    throw new Error("Invalid graph domain rule");
  }

  const pathPrefix = normalizeGraphPath(rule.pathPrefix);
  return {
    pathPrefix,
    domain: rule.domain,
    specificity: pathPrefix.split("/").length,
  };
}

function hasPathPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function normalizedRules(rules: readonly GraphDomainRule[]): NormalizedRule[] {
  if (!Array.isArray(rules)) {
    throw new Error("Graph domain rules must be an array");
  }
  const normalized = rules.map(normalizeRule);
  for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
    const left = normalized[leftIndex] as NormalizedRule;
    for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex += 1) {
      const right = normalized[rightIndex] as NormalizedRule;
      if (
        left.specificity === right.specificity &&
        (hasPathPrefix(left.pathPrefix, right.pathPrefix) || hasPathPrefix(right.pathPrefix, left.pathPrefix))
      ) {
        throw new Error("Graph domain rules have an equal-specificity overlap");
      }
    }
  }
  return normalized;
}

export function classifyDomain(path: string, rules: readonly GraphDomainRule[] = []): GraphDomain {
  const normalizedPath = normalizeGraphPath(path);
  if (hasPathPrefix(normalizedPath, "Repositories")) {
    return "github";
  }

  const matches = normalizedRules(rules).filter((rule) => hasPathPrefix(normalizedPath, rule.pathPrefix));
  if (matches.length > 0) {
    matches.sort((left, right) => right.specificity - left.specificity || (left.pathPrefix < right.pathPrefix ? -1 : 1));
    return (matches[0] as NormalizedRule).domain;
  }

  const topLevel = normalizedPath.split("/")[0] as string;
  return topLevel.toLowerCase() === "personal" ? "personal" : "other";
}
