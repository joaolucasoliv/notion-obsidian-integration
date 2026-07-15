import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SAFE_FIXTURE_ROOT = "tests/fixtures/safe/";
const SENSITIVE_NAME = /(?:credential|token|authorization|header|cookie|canary|pairing|secret|provider)/iu;
const STRING_ASSEMBLY_METHODS = new Set(["join", "concat", "replace", "replaceAll"]);
const SAFE_FIXTURE_READ = [
  "const fixture = JSON.parse(readFileSync(",
  '  new URL("tests/fixtures/safe/canary.json", import.meta.url),',
  '  "utf8",',
  "));",
  "const loaded = fixture.token;",
].join("\n");

const TARGET_TESTS = [
  new URL("../worker/src/notion/client.test.ts", import.meta.url),
  new URL("../worker/src/notion/transport.test.ts", import.meta.url),
  new URL("../worker/src/runtime/safe-log.test.ts", import.meta.url),
] as const;

function walk(node: ts.Node, visit: (current: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function bindingName(declaration: ts.VariableDeclaration): string | undefined {
  return ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function isSensitiveName(name: string | undefined): boolean {
  return name !== undefined && SENSITIVE_NAME.test(name);
}

function isSafeFixtureRead(initializer: ts.Expression): boolean {
  let safeRead = false;
  walk(initializer, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "readFileSync") return;
    let safePath = false;
    walk(node, (child) => {
      if (
        (ts.isStringLiteral(child) || ts.isNoSubstitutionTemplateLiteral(child)) &&
        child.text.includes(SAFE_FIXTURE_ROOT)
      ) {
        safePath = true;
      }
    });
    if (safePath) safeRead = true;
  });
  return safeRead;
}

function variableDeclarations(sourceFile: ts.SourceFile): readonly ts.VariableDeclaration[] {
  const declarations: ts.VariableDeclaration[] = [];
  walk(sourceFile, (node) => {
    if (ts.isVariableDeclaration(node)) declarations.push(node);
  });
  return declarations;
}

function referencesAny(node: ts.Node, names: ReadonlySet<string>): boolean {
  let found = false;
  walk(node, (child) => {
    if (ts.isIdentifier(child) && names.has(child.text)) found = true;
  });
  return found;
}

function hasStringAssembly(node: ts.Node): boolean {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return true;
  if (ts.isTemplateExpression(node)) return true;
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    STRING_ASSEMBLY_METHODS.has(node.expression.name.text)
  );
}

function containsStringAssembly(node: ts.Node): boolean {
  let found = false;
  walk(node, (child) => {
    if (hasStringAssembly(child)) found = true;
  });
  return found;
}

function isSimpleFixtureCarrier(initializer: ts.Expression): boolean {
  return (
    ts.isIdentifier(initializer) ||
    ts.isPropertyAccessExpression(initializer) ||
    ts.isElementAccessExpression(initializer) ||
    ts.isArrayLiteralExpression(initializer)
  );
}

function fixtureDerivedBindings(
  declarations: readonly ts.VariableDeclaration[],
  fixtureBindings: ReadonlySet<string>,
): ReadonlySet<string> {
  const derived = new Set(fixtureBindings);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const name = bindingName(declaration);
      if (name === undefined || declaration.initializer === undefined || derived.has(name)) continue;
      if (isSimpleFixtureCarrier(declaration.initializer) && referencesAny(declaration.initializer, derived)) {
        derived.add(name);
        changed = true;
      }
    }
  }
  return derived;
}

function dynamicBindings(declarations: readonly ts.VariableDeclaration[]): ReadonlySet<string> {
  const dynamic = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const name = bindingName(declaration);
      if (name === undefined || declaration.initializer === undefined || dynamic.has(name)) continue;
      if (containsStringAssembly(declaration.initializer) || referencesAny(declaration.initializer, dynamic)) {
        dynamic.add(name);
        changed = true;
      }
    }
  }
  return dynamic;
}

function isTimestampOverride(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "Object" &&
    node.expression.name.text === "defineProperty" &&
    node.arguments.length >= 3 &&
    (ts.isStringLiteral(node.arguments[1]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[1])) &&
    node.arguments[1].text === "toISOString"
  );
}

function isSensitiveConstructor(node: ts.Node): node is ts.NewExpression {
  return (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "NotionClient" || node.expression.text === "Error" || node.expression.text === "Response")
  );
}

function hasSensitiveContext(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current?.parent !== undefined) {
    const parent = current.parent;
    if (ts.isVariableDeclaration(parent) && isSensitiveName(bindingName(parent))) return true;
    if (ts.isPropertyAssignment(parent) && isSensitiveName(propertyName(parent.name))) return true;
    if (isTimestampOverride(parent) || isSensitiveConstructor(parent)) return true;
    current = parent;
  }
  return false;
}

function isDiscardedAccess(node: ts.Node): boolean {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent)) current = current.parent;
  return ts.isExpressionStatement(current.parent) || ts.isVoidExpression(current.parent);
}

function hasMeaningfulAliasUse(sourceFile: ts.SourceFile, declaration: ts.VariableDeclaration): boolean {
  const name = bindingName(declaration);
  if (name === undefined) return false;
  let used = false;
  walk(sourceFile, (node) => {
    if (node === declaration.name || !ts.isIdentifier(node) || node.text !== name || isDiscardedAccess(node)) return;
    used = true;
  });
  return used;
}

function hasMeaningfulFixtureUse(sourceFile: ts.SourceFile, fixtureBinding: string): boolean {
  let used = false;
  walk(sourceFile, (node) => {
    const propertyAccess =
      (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === fixtureBinding) ||
      (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === fixtureBinding);
    if (!propertyAccess || isDiscardedAccess(node)) return;
    if (ts.isVariableDeclaration(node.parent)) {
      if (hasMeaningfulAliasUse(sourceFile, node.parent)) used = true;
      return;
    }
    used = true;
  });
  return used;
}

function sensitiveSinkExpression(node: ts.Node): ts.Expression | undefined {
  if (ts.isPropertyAssignment(node) && isSensitiveName(propertyName(node.name))) return node.initializer;
  if (isSensitiveConstructor(node)) return node.arguments?.[0];
  return undefined;
}

function policyViolations(source: string): readonly string[] {
  const sourceFile = ts.createSourceFile("credential-fixture-policy.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = variableDeclarations(sourceFile);
  const fixtures = new Set(
    declarations.flatMap((declaration) => {
      const name = bindingName(declaration);
      return name !== undefined && declaration.initializer !== undefined && isSafeFixtureRead(declaration.initializer) ? [name] : [];
    }),
  );
  const violations = new Set<string>();
  if (fixtures.size === 0) violations.add("missing safe fixture read");
  for (const fixture of fixtures) {
    if (!hasMeaningfulFixtureUse(sourceFile, fixture)) violations.add("safe fixture read is unused");
  }

  const fixtureDerived = fixtureDerivedBindings(declarations, fixtures);
  const dynamic = dynamicBindings(declarations);
  walk(sourceFile, (node) => {
    if (hasStringAssembly(node) && (referencesAny(node, fixtureDerived) || hasSensitiveContext(node))) {
      violations.add("dynamic credential construction");
    }
    const sink = sensitiveSinkExpression(node);
    if (sink !== undefined && referencesAny(sink, dynamic)) {
      violations.add("dynamic credential construction");
    }
  });
  return [...violations];
}

describe("credential fixture hygiene", () => {
  it("loads credential-bearing test values from safe fixtures without dynamic assembly", () => {
    for (const testFile of TARGET_TESTS) {
      const source = readFileSync(testFile, "utf8");

      expect(policyViolations(source)).toEqual([]);
    }
  });

  it.each([
    ["concatenation", "const token = loaded + suffix;"],
    ["template expression", "const authorization = `${loaded}${suffix}`;"],
    ["variable join", "const parts = [loaded, suffix]; const token = parts.join(\"\");"],
    ["three-part join", "const token = [loaded, middle, suffix].join(\"\");"],
    ["concat call", "const token = loaded.concat(suffix);"],
    ["replacement call", "const token = loaded.replace(\"x\", \"y\");"],
    ["timestamp assembly", "Object.defineProperty(date, \"toISOString\", { value: () => `${loaded}-${suffix}` });"],
    ["indirected header construction", "const value = prefix + suffix; const headers = { Authorization: value };"],
    ["indirected error context construction", "const value = prefix + suffix; throw new Error(value);"],
  ])("rejects credential construction through %s", (_label, construction) => {
    expect(policyViolations(`${SAFE_FIXTURE_READ}\n${construction}`)).toContain("dynamic credential construction");
  });

  it.each([
    ["never used", "void 0;"],
    ["used only in a discarded expression", "void fixture.token;"],
  ])("rejects a safe fixture read that is %s", (_label, replacement) => {
    const unusedFixture = SAFE_FIXTURE_READ.replace("const loaded = fixture.token;", replacement);

    expect(policyViolations(unusedFixture)).toContain("safe fixture read is unused");
  });

  it("rejects a fixture value copied only to an unused alias", () => {
    expect(policyViolations(SAFE_FIXTURE_READ)).toContain("safe fixture read is unused");
  });
});
