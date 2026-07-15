import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SAFE_FIXTURE_ROOT = "tests/fixtures/safe/";
const SENSITIVE_NAME = /(?:credential|token|authorization|header|cookie|canary|pairing|secret|provider)/iu;
const STRING_ASSEMBLY_METHODS = new Set(["join", "concat", "replace", "replaceAll"]);
const SAFE_FIXTURE_READ = [
  'import { readFileSync } from "node:fs";',
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
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    (ts.isStringLiteral(name.expression) ||
      ts.isNoSubstitutionTemplateLiteral(name.expression) ||
      ts.isNumericLiteral(name.expression))
  ) {
    return name.expression.text;
  }
  return undefined;
}

function isSensitiveName(name: string | undefined): boolean {
  return name !== undefined && SENSITIVE_NAME.test(name);
}

type BindingSource = "local" | "node-fs-read-file";

interface Binding {
  readonly declaration: ts.Declaration;
  readonly name: string;
  readonly source: BindingSource;
}

interface Scope {
  readonly parent: Scope | undefined;
  readonly bindings: Map<string, Binding>;
}

interface ScopeAnalysis {
  readonly bindingForDeclaration: ReadonlyMap<ts.Declaration, Binding>;
  resolve(identifier: ts.Identifier): Binding | undefined;
}

function bindingIdentifier(declaration: ts.Declaration): ts.Identifier | undefined {
  if (
    (ts.isVariableDeclaration(declaration) ||
      ts.isParameter(declaration) ||
      ts.isImportSpecifier(declaration) ||
      ts.isFunctionDeclaration(declaration) ||
      ts.isClassDeclaration(declaration)) &&
    ts.isIdentifier(declaration.name)
  ) {
    return declaration.name;
  }
  return undefined;
}

function scopeAnalysis(sourceFile: ts.SourceFile): ScopeAnalysis {
  const root: Scope = { parent: undefined, bindings: new Map() };
  const scopes = new Map<ts.Node, Scope>();
  const bindingForDeclaration = new Map<ts.Declaration, Binding>();

  const bind = (declaration: ts.Declaration, scope: Scope, source: BindingSource): void => {
    const existing = bindingForDeclaration.get(declaration);
    if (existing !== undefined) {
      scope.bindings.set(existing.name, existing);
      return;
    }
    const name = bindingIdentifier(declaration);
    if (name === undefined) return;
    const binding: Binding = { declaration, name: name.text, source };
    scope.bindings.set(binding.name, binding);
    bindingForDeclaration.set(declaration, binding);
  };

  const visitStatements = (statements: readonly ts.Statement[], scope: Scope): void => {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) bind(statement, scope, "local");
    }
    for (const statement of statements) visit(statement, scope);
  };

  const visit = (node: ts.Node, scope: Scope): void => {
    scopes.set(node, scope);
    if (ts.isSourceFile(node)) {
      visitStatements(node.statements, scope);
      return;
    }
    if (ts.isImportDeclaration(node)) {
      const bindings = node.importClause?.namedBindings;
      const isNodeFs = ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "node:fs";
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const imported = element.propertyName ?? element.name;
          bind(element, scope, isNodeFs && imported.text === "readFileSync" ? "node-fs-read-file" : "local");
        }
      }
      return;
    }
    if (ts.isFunctionLike(node)) {
      if (ts.isFunctionDeclaration(node)) bind(node, scope, "local");
      const functionScope: Scope = { parent: scope, bindings: new Map() };
      scopes.set(node, functionScope);
      for (const parameter of node.parameters) {
        bind(parameter, functionScope, "local");
        if (parameter.initializer !== undefined) visit(parameter.initializer, functionScope);
      }
      if (node.body !== undefined) visit(node.body, functionScope);
      return;
    }
    if (ts.isBlock(node)) {
      const blockScope: Scope = { parent: scope, bindings: new Map() };
      scopes.set(node, blockScope);
      visitStatements(node.statements, blockScope);
      return;
    }
    if (ts.isCatchClause(node)) {
      const catchScope: Scope = { parent: scope, bindings: new Map() };
      scopes.set(node, catchScope);
      if (node.variableDeclaration !== undefined) bind(node.variableDeclaration, catchScope, "local");
      visit(node.block, catchScope);
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      bind(node, scope, "local");
      if (node.initializer !== undefined) visit(node.initializer, scope);
      return;
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };

  visit(sourceFile, root);
  return {
    bindingForDeclaration,
    resolve(identifier) {
      let scope = scopes.get(identifier);
      while (scope !== undefined) {
        const binding = scope.bindings.get(identifier.text);
        if (binding !== undefined) return binding;
        scope = scope.parent;
      }
      return undefined;
    },
  };
}

function isBindingDeclarationName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent)) &&
    parent.name === identifier
  );
}

function isReferenceIdentifier(identifier: ts.Identifier): boolean {
  if (isBindingDeclarationName(identifier)) return false;
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === identifier) return false;
  return true;
}

function isSafeFixtureRead(initializer: ts.Expression, analysis: ScopeAnalysis): boolean {
  let safeRead = false;
  walk(initializer, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isIdentifier(node.expression) ||
      analysis.resolve(node.expression)?.source !== "node-fs-read-file"
    ) {
      return;
    }
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

function referencesAny(node: ts.Node, bindings: ReadonlySet<Binding>, analysis: ScopeAnalysis): boolean {
  let found = false;
  walk(node, (child) => {
    if (!ts.isIdentifier(child) || !isReferenceIdentifier(child)) return;
    const binding = analysis.resolve(child);
    if (binding !== undefined && bindings.has(binding)) found = true;
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
  fixtureBindings: ReadonlySet<Binding>,
  analysis: ScopeAnalysis,
): ReadonlySet<Binding> {
  const derived = new Set(fixtureBindings);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const binding = analysis.bindingForDeclaration.get(declaration);
      if (binding === undefined || declaration.initializer === undefined || derived.has(binding)) continue;
      if (isSimpleFixtureCarrier(declaration.initializer) && referencesAny(declaration.initializer, derived, analysis)) {
        derived.add(binding);
        changed = true;
      }
    }
  }
  return derived;
}

function isStaticDateBinding(binding: Binding | undefined): boolean {
  if (binding === undefined || !ts.isVariableDeclaration(binding.declaration) || binding.declaration.initializer === undefined) {
    return false;
  }
  const initializer = binding.declaration.initializer;
  return (
    ts.isNewExpression(initializer) &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === "Date" &&
    (initializer.arguments?.every(
      (argument) => ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument),
    ) ?? true)
  );
}

function isFixedTimestampFormatting(initializer: ts.Expression, analysis: ScopeAnalysis): boolean {
  if (!ts.isTemplateExpression(initializer) || initializer.templateSpans.length === 0) return false;
  return initializer.templateSpans.every((span) => {
    const expression = span.expression;
    return (
      ts.isCallExpression(expression) &&
      ts.isPropertyAccessExpression(expression.expression) &&
      expression.expression.name.text === "toISOString" &&
      ts.isIdentifier(expression.expression.expression) &&
      isStaticDateBinding(analysis.resolve(expression.expression.expression))
    );
  });
}

function dynamicBindings(
  declarations: readonly ts.VariableDeclaration[],
  analysis: ScopeAnalysis,
): ReadonlySet<Binding> {
  const dynamic = new Set<Binding>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const binding = analysis.bindingForDeclaration.get(declaration);
      if (binding === undefined || declaration.initializer === undefined || dynamic.has(binding)) continue;
      if (
        (!isFixedTimestampFormatting(declaration.initializer, analysis) && containsStringAssembly(declaration.initializer)) ||
        referencesAny(declaration.initializer, dynamic, analysis)
      ) {
        dynamic.add(binding);
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
    (node.expression.text === "NotionClient" ||
      node.expression.text === "NotionTransportError" ||
      node.expression.text === "Error" ||
      node.expression.text === "DOMException" ||
      node.expression.text === "Response")
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

function unwrapTransparentExpression(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent) ||
    ts.isAsExpression(current.parent) ||
    ts.isTypeAssertionExpression(current.parent) ||
    ts.isNonNullExpression(current.parent)
  ) {
    current = current.parent;
  }
  return current;
}

function isDiscardedAccess(node: ts.Expression): boolean {
  let current = unwrapTransparentExpression(node);
  while (true) {
    if (ts.isExpressionStatement(current.parent) || ts.isVoidExpression(current.parent)) return true;
    const parent = current.parent;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.CommaToken && parent.right === current) {
      current = unwrapTransparentExpression(parent);
      continue;
    }
    if (
      ts.isCommaListExpression(parent) &&
      parent.elements[parent.elements.length - 1] === current
    ) {
      current = unwrapTransparentExpression(parent);
      continue;
    }
    return false;
  }
}

function rootBinding(node: ts.PropertyAccessExpression | ts.ElementAccessExpression, analysis: ScopeAnalysis): Binding | undefined {
  let current: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? analysis.resolve(current) : undefined;
}

function isNestedAccess(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
}

function isAccessBase(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === identifier;
}

function bindingUses(sourceFile: ts.SourceFile, binding: Binding, analysis: ScopeAnalysis): readonly ts.Expression[] {
  const uses: ts.Expression[] = [];
  walk(sourceFile, (node) => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && !isNestedAccess(node)) {
      if (rootBinding(node, analysis) === binding) uses.push(node);
      return;
    }
    if (
      ts.isIdentifier(node) &&
      isReferenceIdentifier(node) &&
      !isAccessBase(node) &&
      analysis.resolve(node) === binding
    ) {
      uses.push(node);
    }
  });
  return uses;
}

function aliasBindingForUse(expression: ts.Expression, analysis: ScopeAnalysis): Binding | undefined {
  const current = unwrapTransparentExpression(expression);
  if (ts.isVariableDeclaration(current.parent) && current.parent.initializer === current) {
    return analysis.bindingForDeclaration.get(current.parent);
  }
  return undefined;
}

function hasTerminalNonDiscardedUse(
  sourceFile: ts.SourceFile,
  binding: Binding,
  analysis: ScopeAnalysis,
  seen = new Set<Binding>(),
): boolean {
  if (seen.has(binding)) return false;
  const branch = new Set(seen);
  branch.add(binding);
  for (const use of bindingUses(sourceFile, binding, analysis)) {
    if (isDiscardedAccess(use)) continue;
    const alias = aliasBindingForUse(use, analysis);
    if (alias !== undefined && alias !== binding) {
      if (hasTerminalNonDiscardedUse(sourceFile, alias, analysis, branch)) return true;
      continue;
    }
    return true;
  }
  return false;
}

function hasMeaningfulFixtureUse(sourceFile: ts.SourceFile, fixtureBinding: Binding, analysis: ScopeAnalysis): boolean {
  return hasTerminalNonDiscardedUse(sourceFile, fixtureBinding, analysis);
}

function sensitiveSinkExpression(node: ts.Node): ts.Expression | undefined {
  if (ts.isPropertyAssignment(node) && isSensitiveName(propertyName(node.name))) return node.initializer;
  if (isSensitiveConstructor(node)) return node.arguments?.[0];
  if (isTimestampOverride(node)) return node.arguments[2];
  return undefined;
}

function policyViolations(source: string): readonly string[] {
  const sourceFile = ts.createSourceFile("credential-fixture-policy.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const analysis = scopeAnalysis(sourceFile);
  const declarations = variableDeclarations(sourceFile);
  const fixtures = new Set(
    declarations.flatMap((declaration) => {
      const binding = analysis.bindingForDeclaration.get(declaration);
      return binding !== undefined &&
        declaration.initializer !== undefined &&
        isSafeFixtureRead(declaration.initializer, analysis)
        ? [binding]
        : [];
    }),
  );
  const violations = new Set<string>();
  if (fixtures.size === 0) violations.add("missing safe fixture read");
  for (const fixture of fixtures) {
    if (!hasMeaningfulFixtureUse(sourceFile, fixture, analysis)) violations.add("safe fixture read is unused");
  }

  const fixtureDerived = fixtureDerivedBindings(declarations, fixtures, analysis);
  const dynamic = dynamicBindings(declarations, analysis);
  walk(sourceFile, (node) => {
    if (hasStringAssembly(node) && (referencesAny(node, fixtureDerived, analysis) || hasSensitiveContext(node))) {
      violations.add("dynamic credential construction");
    }
    const sink = sensitiveSinkExpression(node);
    if (sink !== undefined && referencesAny(sink, dynamic, analysis)) {
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
    [
      "indirected computed Authorization construction",
      'use(loaded); const value = prefix + suffix; const headers = { ["Authorization"]: value };',
    ],
    ["indirected error context construction", "const value = prefix + suffix; throw new Error(value);"],
    [
      "indirected timestamp override construction",
      "use(loaded); const value = prefix + suffix; Object.defineProperty(date, \"toISOString\", { value: () => value });",
    ],
    [
      "indirected Notion transport error construction",
      "use(loaded); const value = prefix + suffix; throw new NotionTransportError(value);",
    ],
    [
      "indirected DOM exception construction",
      "use(loaded); const value = prefix + suffix; throw new DOMException(value);",
    ],
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

  it("rejects a fixture read through a locally shadowed reader", () => {
    const shadowedReader = [
      'import { readFileSync } from "node:fs";',
      "function load(readFileSync: () => string) {",
      "  const fixture = JSON.parse(readFileSync(",
      '    new URL("tests/fixtures/safe/canary.json", import.meta.url),',
      '    "utf8",',
      "  ));",
      "  return fixture.token;",
      "}",
    ].join("\n");

    expect(policyViolations(shadowedReader)).toContain("missing safe fixture read");
  });

  it("rejects a fixture read through a function declaration shadow", () => {
    const functionShadowedReader = [
      'import { readFileSync } from "node:fs";',
      "function load() {",
      "  function readFileSync(): string { return \"{}\"; }",
      "  const fixture = JSON.parse(readFileSync(",
      '    new URL("tests/fixtures/safe/canary.json", import.meta.url),',
      '    "utf8",',
      "  ));",
      "  return fixture.token;",
      "}",
    ].join("\n");

    expect(policyViolations(functionShadowedReader)).toContain("missing safe fixture read");
  });

  it("rejects a fixture value whose alias chain ends in a discarded use", () => {
    const deadAliasChain = [
      'import { readFileSync } from "node:fs";',
      "const fixture = JSON.parse(readFileSync(",
      '  new URL("tests/fixtures/safe/canary.json", import.meta.url),',
      '  "utf8",',
      "));",
      "const first = fixture.token;",
      "const second = first;",
      "void second;",
    ].join("\n");

    expect(policyViolations(deadAliasChain)).toContain("safe fixture read is unused");
  });

  it("rejects a fixture value whose alias chain ends in a comma-wrapped discard", () => {
    const commaDiscardedAliasChain = [
      'import { readFileSync } from "node:fs";',
      "const fixture = JSON.parse(readFileSync(",
      '  new URL("tests/fixtures/safe/canary.json", import.meta.url),',
      '  "utf8",',
      "));",
      "const first = fixture.token;",
      "const second = first;",
      "void (0, second);",
    ].join("\n");

    expect(policyViolations(commaDiscardedAliasChain)).toContain("safe fixture read is unused");
  });
});
