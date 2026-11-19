export type GraphqlOperationType = 'query' | 'mutation' | 'subscription';

type Token = { readonly kind: 'name' | 'atom' | 'punct'; readonly value: string };

function isNameStart(char: string | undefined): boolean {
  return char !== undefined && /[_A-Za-z]/.test(char);
}

function isNameContinue(char: string | undefined): boolean {
  return char !== undefined && /[_0-9A-Za-z]/.test(char);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < source.length) {
    const char = source[index]!;
    if (/\s/.test(char) || char === ',') { index++; continue; }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index++;
      continue;
    }
    if (source.startsWith('"""', index)) {
      index += 3;
      let closed = false;
      while (index < source.length) {
        if (source.startsWith('\\"""', index)) { index += 4; continue; }
        if (source.startsWith('"""', index)) { index += 3; closed = true; break; }
        index++;
      }
      if (!closed) throw new TypeError('GraphQL document contains an unterminated block string.');
      tokens.push({ kind: 'atom', value: '<string>' });
      continue;
    }
    if (char === '"') {
      index++;
      let closed = false;
      while (index < source.length) {
        const current = source[index]!;
        if (current === '\\') { index += 2; continue; }
        if (current === '"') { index++; closed = true; break; }
        if (current === '\n' || current === '\r') throw new TypeError('GraphQL document contains an invalid string.');
        index++;
      }
      if (!closed) throw new TypeError('GraphQL document contains an unterminated string.');
      tokens.push({ kind: 'atom', value: '<string>' });
      continue;
    }
    if (isNameStart(char)) {
      const start = index++;
      while (isNameContinue(source[index])) index++;
      tokens.push({ kind: 'name', value: source.slice(start, index) });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const start = index++;
      while (index < source.length && /[0-9.eE+-]/.test(source[index]!)) index++;
      tokens.push({ kind: 'atom', value: source.slice(start, index) });
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('!$():=@[]{|}&'.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index++;
      continue;
    }
    throw new TypeError('GraphQL document contains an invalid token.');
  }
  return tokens;
}

function skipSelection(tokens: readonly Token[], start: number): number {
  if (tokens[start]?.value !== '{') throw new TypeError('GraphQL operation is missing a selection set.');
  let depth = 0;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index]?.value === '{') depth++;
    else if (tokens[index]?.value === '}') {
      depth--;
      if (depth === 0) return index + 1;
      if (depth < 0) break;
    }
  }
  throw new TypeError('GraphQL document contains an unbalanced selection set.');
}

function findSelection(tokens: readonly Token[], start: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let valueObjectDepth = 0;
  for (let index = start; index < tokens.length; index++) {
    const value = tokens[index]!.value;
    if (value === '(') parenDepth++;
    else if (value === ')') parenDepth--;
    else if (value === '[') bracketDepth++;
    else if (value === ']') bracketDepth--;
    else if (value === '{' && parenDepth > 0) valueObjectDepth++;
    else if (value === '}' && valueObjectDepth > 0) valueObjectDepth--;
    else if (value === '{' && parenDepth === 0 && bracketDepth === 0) return index;
    if (parenDepth < 0 || bracketDepth < 0) throw new TypeError('GraphQL document contains unbalanced delimiters.');
  }
  throw new TypeError('GraphQL operation is missing a selection set.');
}

/**
 * Reads GraphQL definition-level operations while ignoring comments and string contents.
 * This is intentionally a read-only operation gate, not a replacement for server GraphQL validation.
 */
export function parseGraphqlOperationTypes(source: string): readonly GraphqlOperationType[] {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('A GraphQL document is required.');
  const tokens = tokenize(source);
  const operations: GraphqlOperationType[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.value === '{') {
      operations.push('query');
      index = skipSelection(tokens, index);
      continue;
    }
    if (token.kind !== 'name') throw new TypeError('GraphQL document contains an invalid definition.');
    if (token.value === 'fragment') {
      if (tokens[index + 1]?.kind !== 'name' || tokens[index + 2]?.value !== 'on' || tokens[index + 3]?.kind !== 'name') {
        throw new TypeError('GraphQL fragment definition is malformed.');
      }
      index = skipSelection(tokens, findSelection(tokens, index + 4));
      continue;
    }
    if (token.value !== 'query' && token.value !== 'mutation' && token.value !== 'subscription') {
      throw new TypeError('GraphQL document contains an unsupported definition.');
    }
    const operation = token.value;
    operations.push(operation);
    index++;
    if (tokens[index]?.kind === 'name') index++; // optional operation name
    index = skipSelection(tokens, findSelection(tokens, index));
  }
  if (operations.length !== 1) throw new TypeError('Exactly one GraphQL operation is required.');
  return operations;
}

export function assertReadOnlyGraphqlDocument(source: string): void {
  const [operation] = parseGraphqlOperationTypes(source);
  if (operation !== 'query') {
    throw new TypeError('Only GraphQL query operations are available through this client method.');
  }
}
