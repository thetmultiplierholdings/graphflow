// Build-time code-hash codegen (decorator-alternatives.md §4). Hashes are computed over AUTHORED
// TypeScript source via ts-morph, so they are immune to transpiler/bundler churn; per-node
// granularity keeps memo hits (including human answers) when unchanged nodes are copy-pasted into
// a new workflow version file.
import { readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallExpression, SourceFile } from 'ts-morph';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { canonicalBytes, sha256Hex } from '../src/domain/canonical/Canonical.js';
import type { JsonValue } from '../src/domain/json/JsonValue.js';
import type { HashDep, NodeDef } from '../src/domain/registry/Registry.js';
import { RuntimeError, ValidationError } from '../src/shared/errors/Errors.js';
import { ALL_WORKFLOWS } from '../src/workflows/index.js';

type FunctionDep = Exclude<HashDep, JsonValue>;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = join(packageRoot, 'src', 'workflows');
const outPath = join(packageRoot, 'src', 'generated', 'CodeHashes.ts');

const encoder = new TextEncoder();
const WHITESPACE_ONLY_RE = /^[ \t]+$/;
const LEADING_WHITESPACE_RE = /^[ \t]*/;

function relPath(sourceFile: SourceFile): string {
  return relative(packageRoot, sourceFile.getFilePath());
}

// Dedent contract: whitespace-only lines are blanked, then the longest common leading whitespace
// of the remaining lines is stripped. Also normalizes line endings to LF.
function dedent(text: string): string {
  const lines = text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => (WHITESPACE_ONLY_RE.test(line) ? '' : line));
  let margin: string | undefined;
  for (const line of lines) {
    if (line === '') {
      continue;
    }
    const indent = LEADING_WHITESPACE_RE.exec(line)?.[0] ?? '';
    margin = margin === undefined ? indent : commonPrefix(margin, indent);
  }
  if (margin === undefined || margin === '') {
    return lines.join('\n');
  }
  const m = margin;
  return lines.map((line) => (line.startsWith(m) ? line.slice(m.length) : line)).join('\n');
}

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i += 1;
  }
  return a.slice(0, i);
}

// Concatenate parts with a NUL byte between them—Uint8Array is zero-initialized, so the
// separators need no explicit write.
function joinWithNul(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0) + Math.max(0, parts.length - 1);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const [i, part] of parts.entries()) {
    if (i > 0) {
      offset += 1;
    }
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function stringLiteralProperty(call: CallExpression, propName: string): string | undefined {
  const [arg] = call.getArguments();
  if (arg === undefined || !Node.isObjectLiteralExpression(arg)) {
    return undefined;
  }
  const prop = arg.getProperty(propName);
  if (prop === undefined || !Node.isPropertyAssignment(prop)) {
    return undefined;
  }
  const init = prop.getInitializer();
  return init !== undefined && Node.isStringLiteral(init) ? init.getLiteralValue() : undefined;
}

function callsTo(sourceFile: SourceFile, calleeNames: readonly string[]): CallExpression[] {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => calleeNames.includes(call.getExpression().getText()));
}

function findDefineCall(sourceFile: SourceFile, nodeId: string): CallExpression {
  const matches = callsTo(sourceFile, ['defineNode', 'defineHumanNode']).filter(
    (call) => stringLiteralProperty(call, 'name') === nodeId
  );
  if (matches.length !== 1) {
    throw new RuntimeError(
      `expected exactly one defineNode/defineHumanNode call with name '${nodeId}' in ${relPath(sourceFile)}, ` +
        `found ${matches.length}`
    );
  }
  return matches[0];
}

function localDeclaration(sourceFile: SourceFile, name: string): Node | undefined {
  const fn = sourceFile.getFunction(name);
  if (fn !== undefined) {
    return fn;
  }
  const variable = sourceFile.getVariableDeclaration(name);
  if (variable === undefined) {
    return undefined;
  }
  const statement = variable.getVariableStatement();
  return statement !== undefined && statement.getDeclarations().length === 1 ? statement : variable;
}

function importedDeclaration(sourceFile: SourceFile, name: string): Node | undefined {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const specifier = importDecl.getNamedImports().find((named) => named.getName() === name);
    if (specifier === undefined) {
      continue;
    }
    const moduleFile = importDecl.getModuleSpecifierSourceFile();
    return moduleFile === undefined ? undefined : localDeclaration(moduleFile, name);
  }
  return undefined;
}

// Function deps are hashed by declaration source, resolved by Function.name in the owning file
// first, then through its imports. Anonymous/unresolvable deps are config errors—fail the build.
function functionDepSource(sourceFile: SourceFile, dep: FunctionDep): string {
  const name = dep.name;
  if (name === '') {
    throw new ValidationError(`anonymous hashWith function in ${relPath(sourceFile)}—declare it with a name`);
  }
  const decl = localDeclaration(sourceFile, name) ?? importedDeclaration(sourceFile, name);
  if (decl === undefined) {
    throw new RuntimeError(`cannot resolve declaration of hashWith function '${name}' from ${relPath(sourceFile)}`);
  }
  return decl.getText();
}

function nodeCodeHash(sourceFile: SourceFile, nd: NodeDef): string {
  const call = findDefineCall(sourceFile, nd.nodeId);
  const parts: Uint8Array[] = [
    canonicalBytes({ node_id: nd.nodeId, output_kind: nd.outputKind, executor: nd.executor }),
    encoder.encode(dedent(call.getText())),
  ];
  for (const dep of nd.hashWith) {
    parts.push(
      typeof dep === 'function' ? encoder.encode(dedent(functionDepSource(sourceFile, dep))) : canonicalBytes(dep)
    );
  }
  parts.push(encoder.encode(nd.codeSalt));
  return sha256Hex(joinWithNul(parts));
}

// Filename-stem rule + manifest completeness (decorator-alternatives.md §5.3): every workflow id
// must equal its file's stem (the filename IS the version), and every workflow file must be
// listed in the ALL_WORKFLOWS manifest so nothing ships unregistered.
function checkStemsAndManifest(project: Project, workflowFiles: readonly string[]): void {
  const stemById = new Map<string, string>();
  for (const file of workflowFiles) {
    const sourceFile = project.getSourceFileOrThrow(join(workflowsDir, file));
    const stem = file.slice(0, -'.ts'.length);
    for (const call of callsTo(sourceFile, ['defineWorkflow'])) {
      const id = stringLiteralProperty(call, 'id');
      if (id !== undefined) {
        stemById.set(id, stem);
      }
    }
  }
  for (const wd of ALL_WORKFLOWS) {
    const stem = stemById.get(wd.workflowId);
    if (stem === undefined) {
      throw new RuntimeError(`no defineWorkflow call with id '${wd.workflowId}' found in src/workflows/`);
    }
    if (stem !== wd.workflowId) {
      throw new ValidationError(
        `workflow id '${wd.workflowId}' must equal its filename stem '${stem}' (the filename IS the version)`
      );
    }
  }
  const manifestIds = new Set(ALL_WORKFLOWS.map((wd) => wd.workflowId));
  for (const file of workflowFiles) {
    if (!manifestIds.has(file.slice(0, -'.ts'.length))) {
      throw new RuntimeError(
        `workflow file 'src/workflows/${file}' is not listed in ALL_WORKFLOWS (src/workflows/index.ts)`
      );
    }
  }
}

function emit(hashes: ReadonlyMap<string, string>): string {
  const entries = [...hashes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = [
    '// Generated by npm run gen:hashes — do not edit.',
    'export const CODE_HASHES: Readonly<Record<string, string>> = {',
    ...entries.map(([key, hash]) => `  '${key}': '${hash}',`),
    '};',
  ];
  return `${lines.join('\n')}\n`;
}

function main(): void {
  const project = new Project({ tsConfigFilePath: join(packageRoot, 'tsconfig.lib.json') });
  const workflowFiles = readdirSync(workflowsDir)
    .filter((file) => file.endsWith('.ts') && file !== 'index.ts' && !file.endsWith('.test.ts'))
    .sort();
  checkStemsAndManifest(project, workflowFiles);

  const hashes = new Map<string, string>();
  for (const wd of ALL_WORKFLOWS) {
    const sourceFile = project.getSourceFileOrThrow(join(workflowsDir, `${wd.workflowId}.ts`));
    for (const nd of wd.nodes) {
      hashes.set(`${wd.workflowId}:${nd.nodeId}`, nodeCodeHash(sourceFile, nd));
    }
  }
  writeFileSync(outPath, emit(hashes));
  process.stdout.write(
    `src/generated/CodeHashes.ts: ${hashes.size} node hashes across ${ALL_WORKFLOWS.length} workflows\n`
  );
}

main();
