const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const HTTP_DECORATORS = new Set(['Get', 'Post', 'Put', 'Patch', 'Delete']);
const controllerRoot = path.resolve(__dirname, '..', 'src', 'modules');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walk(target)
      : entry.name.endsWith('.controller.ts')
        ? [target]
        : [];
  });
}

function decorators(node) {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}

function decoratorName(decorator) {
  const expression = decorator.expression;
  const target = ts.isCallExpression(expression) ? expression.expression : expression;
  return ts.isIdentifier(target) ? target.text : undefined;
}

function decoratorArgument(decorator) {
  const expression = decorator.expression;
  if (!ts.isCallExpression(expression) || expression.arguments.length === 0) return '';
  const value = expression.arguments[0];
  return ts.isStringLiteralLike(value) ? value.text : '';
}

function hasDecorator(node, name) {
  return decorators(node).some((decorator) => decoratorName(decorator) === name);
}

function guardNames(node) {
  return decorators(node)
    .filter((decorator) => decoratorName(decorator) === 'UseGuards')
    .flatMap((decorator) => {
      const expression = decorator.expression;
      return ts.isCallExpression(expression)
        ? expression.arguments.filter(ts.isIdentifier).map((argument) => argument.text)
        : [];
    });
}

function joinRoute(prefix, route) {
  return `/${[prefix, route].filter(Boolean).join('/')}`.replace(/\/+/g, '/');
}

function auditFile(file) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const records = [];

  source.forEachChild((node) => {
    if (!ts.isClassDeclaration(node)) return;
    const controller = decorators(node).find(
      (decorator) => decoratorName(decorator) === 'Controller',
    );
    if (!controller) return;

    const prefix = decoratorArgument(controller);
    const classGuards = guardNames(node);
    const classPublic = hasDecorator(node, 'Public');

    for (const member of node.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const routeDecorator = decorators(member).find((decorator) =>
        HTTP_DECORATORS.has(decoratorName(decorator)),
      );
      if (!routeDecorator) continue;

      const method = decoratorName(routeDecorator).toUpperCase();
      const route = joinRoute(prefix, decoratorArgument(routeDecorator));
      const methodGuards = guardNames(member);
      const guards = [...classGuards, ...methodGuards];
      const isPublic = classPublic || hasDecorator(member, 'Public');
      const isOptional = guards.includes('OptionalJwtAuthGuard');
      const isProtected = guards.includes('JwtAuthGuard');
      const access = isPublic
        ? isOptional
          ? 'PUBLIC_OPTIONAL_AUTH'
          : 'PUBLIC'
        : isProtected
          ? 'PROTECTED'
          : 'IMPLICIT';

      records.push({
        access,
        controller: node.name?.text ?? 'AnonymousController',
        file: path.relative(path.resolve(__dirname, '..'), file).replaceAll('\\', '/'),
        method,
        route,
      });
    }
  });

  return records;
}

const records = walk(controllerRoot).flatMap(auditFile).sort((a, b) =>
  `${a.route}:${a.method}`.localeCompare(`${b.route}:${b.method}`),
);
const implicit = records.filter((record) => record.access === 'IMPLICIT');

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
} else {
  for (const record of records) {
    process.stdout.write(`${record.access.padEnd(20)} ${record.method.padEnd(6)} ${record.route}\n`);
  }
  process.stdout.write(`endpointCount=${records.length} implicitCount=${implicit.length}\n`);
}

if (implicit.length > 0 && !process.argv.includes('--allow-implicit')) {
  process.exitCode = 1;
}
