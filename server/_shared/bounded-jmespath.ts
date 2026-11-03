import jmespath from 'jmespath';

interface AstNode {
  type: string;
  name?: string;
  value?: unknown;
  children?: (AstNode | number | null)[];
}

// The package exposes compile() at runtime but its type declaration only lists search().
const compiler = jmespath as typeof jmespath & { compile(expression: string): AstNode };

const MAX_NODES = 128;
const MAX_DEPTH = 32;
const MAX_PIPES = 8;
const MAX_MULTISELECTS = 8;
const MAX_FANOUT = 64;
const EXPRESSION_REFERENCE_ARGUMENTS = new Map([
  ['map', 0],
  ['sort_by', 1],
  ['min_by', 1],
  ['max_by', 1],
]);

function scalarLiteral(node: AstNode | number | null | undefined): node is AstNode {
  return node !== null && typeof node === 'object' && node.type === 'Literal'
    && (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value));
}

// Limits expression-driven duplication before the library can traverse shared
// values in to_string(), comparisons, or implicit array-to-string coercion.
// The byte limit remains at each caller, before compilation.
export function searchBoundedJmespath(value: unknown, expression: string): unknown {
  const ast = compiler.compile(expression);
  let nodes = 0;
  let pipes = 0;
  let multiselects = 0;
  let fanout = 1;

  function reject(reason: string): never {
    throw new Error(`Unsafe JMESPath: ${reason}`);
  }

  function expand(width: number): void {
    fanout *= Math.max(1, width);
    if (fanout > MAX_FANOUT) reject('too much expression expansion');
  }

  function visitLiteral(literal: unknown): void {
    if (literal === null || typeof literal !== 'object') return;
    const values = Object.values(literal);
    expand(values.length);
    for (const child of values) visitLiteral(child);
  }

  function visit(node: AstNode, depth: number): void {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) reject('expression is too complex');
    if (node.type === 'Pipe' && ++pipes > MAX_PIPES) reject('too many pipe stages');
    if (node.type === 'MultiSelectList' || node.type === 'MultiSelectHash') {
      multiselects += 1;
      if (multiselects > MAX_MULTISELECTS) reject('too many multiselects');
      expand(node.children?.length ?? 0);
    }
    // Literal containers can be rebuilt on every map/projection iteration.
    // Multiply all widths, including independent branches, to bound that work.
    if (node.type === 'Literal') visitLiteral(node.value);
    if (node.type === 'Function') {
      if (node.name === 'to_string') reject('to_string() is not supported');
      // The runtime also accepts data tagged "Expref" as executable AST.
      // Only explicit references are guaranteed to have been visited here.
      const referenceIndex = EXPRESSION_REFERENCE_ARGUMENTS.get(node.name ?? '');
      if (referenceIndex !== undefined) {
        const reference = node.children?.[referenceIndex];
        if (reference === null || typeof reference !== 'object' || reference.type !== 'ExpressionReference') {
          reject(`${node.name}() requires an explicit &expression reference`);
        }
      }
      // A caller-derived separator can multiply input-sized strings and arrays.
      if (node.name === 'join') {
        const separator = node.children?.[0];
        if (!scalarLiteral(separator) || typeof separator.value !== 'string') {
          reject('join() requires a literal string separator');
        }
      }
    }
    if (node.type === 'Comparator' && (node.name === 'EQ' || node.name === 'NE')) {
      if (!node.children?.some(scalarLiteral)) reject('equality requires a scalar literal operand');
    }
    for (const child of node.children ?? []) {
      if (child !== null && typeof child === 'object') visit(child, depth + 1);
    }
    if (node.type === 'KeyValuePair') visit(node.value as AstNode, depth + 1);
  }

  visit(ast, 1);
  return jmespath.search(value, expression);
}

// Every field name an expression reads (multiselect keys it writes are not
// fields). Lets a caller tell a field that holds null from one the payload lacks.
export function jmespathFieldNames(expression: string): string[] {
  const names = new Set<string>();
  const visit = (node: AstNode | number | null | undefined): void => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (node.type === 'Field' && typeof node.name === 'string') names.add(node.name);
    for (const child of node.children ?? []) visit(child);
    if (node.type === 'KeyValuePair') visit(node.value as AstNode);
  };
  visit(compiler.compile(expression));
  return [...names];
}
