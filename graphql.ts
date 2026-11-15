// graphql.ts — a small GraphQL engine for the two documents the suite sends (gh and
// github-mcp-server). It is deliberately narrow: a lexer and recursive-descent parser
// for the query-language subset those documents use, plus resolvers that read the
// store. Anything outside that subset fails the way the suite expects: unknown fields
// become validation errors that name the field, and malformed documents become parse
// errors.
//
// This is a rewrite of the first version. The wire behavior is identical — same token
// rules, same error strings, same response shapes — only the internals are
// reorganised: the lexer is a class with one method per token kind, the resolver
// shares one pagination helper and one scalar lookup, and the field dispatch is
// grouped by the shape of the value it returns.

import {
  FIXED_TIME,
  createIssue,
  createPull,
  mergeConflicts,
  mergePull,
  pullFiles,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// --------------------------------------------------------------------------- AST

export interface FieldSel {
  kind: 'field';
  name: string;
  alias: string;
  args: Record<string, unknown>;
  selections: Selection[];
}

export interface FragmentSel {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

export type Selection = FieldSel | FragmentSel;

export interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: Selection[];
}

// --------------------------------------------------------------------------- lexer

type Token =
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'int'; value: number }
  | { type: 'float'; value: number }
  | { type: 'punct'; value: string }
  | { type: 'spread' }
  | { type: 'variable'; value: string }
  | { type: 'eof' };

const PUNCTUATION = '{}()[]:!=@&|';
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;

/** Turns a document string into tokens, in source order, ending with an eof token. */
class Lexer {
  private source: string;
  private pos = 0;

  constructor(source: string) {
    this.source = source;
  }

  run(): Token[] {
    const tokens: Token[] = [];
    while (this.pos < this.source.length) {
      const token = this.nextToken();
      if (token !== null) tokens.push(token);
    }
    tokens.push({ type: 'eof' });
    return tokens;
  }

  private peekChar(offset = 0): string {
    return this.source[this.pos + offset] ?? '';
  }

  /** Read one token, or null for skipped input (whitespace, commas, comments). */
  private nextToken(): Token | null {
    const c = this.peekChar();
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      this.pos += 1;
      return null;
    }
    if (c === '#') {
      while (this.pos < this.source.length && this.peekChar() !== '\n') this.pos += 1;
      return null;
    }
    if (c === '.' && this.peekChar(1) === '.' && this.peekChar(2) === '.') {
      this.pos += 3;
      return { type: 'spread' };
    }
    if (PUNCTUATION.includes(c)) {
      this.pos += 1;
      return { type: 'punct', value: c };
    }
    if (c === '"') return this.readString();
    if (c === '$') return this.readVariable();
    if (DIGIT.test(c) || c === '-') return this.readNumber();
    if (NAME_START.test(c)) return this.readName();
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${this.pos}`);
  }

  private readString(): Token {
    // The opening quote is at pos. Escapes map n/t/r, anything else to itself.
    let value = '';
    this.pos += 1;
    while (this.pos < this.source.length && this.peekChar() !== '"') {
      if (this.peekChar() === '\\' && this.pos + 1 < this.source.length) {
        const esc = this.source[this.pos + 1]!;
        value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
        this.pos += 2;
      } else {
        value += this.peekChar();
        this.pos += 1;
      }
    }
    this.pos += 1;
    return { type: 'string', value };
  }

  private readVariable(): Token {
    let end = this.pos + 1;
    while (end < this.source.length && NAME_CHAR.test(this.source[end]!)) end += 1;
    const value = this.source.slice(this.pos + 1, end);
    this.pos = end;
    return { type: 'variable', value };
  }

  private readNumber(): Token {
    let end = this.pos;
    let isFloat = false;
    if (this.source[end] === '-') end += 1;
    while (end < this.source.length && DIGIT.test(this.source[end]!)) end += 1;
    if (this.source[end] === '.') {
      isFloat = true;
      end += 1;
      while (end < this.source.length && DIGIT.test(this.source[end]!)) end += 1;
    }
    if (this.source[end] === 'e' || this.source[end] === 'E') {
      isFloat = true;
      end += 1;
      if (this.source[end] === '+' || this.source[end] === '-') end += 1;
      while (end < this.source.length && DIGIT.test(this.source[end]!)) end += 1;
    }
    const text = this.source.slice(this.pos, end);
    this.pos = end;
    return isFloat ? { type: 'float', value: parseFloat(text) } : { type: 'int', value: parseInt(text, 10) };
  }

  private readName(): Token {
    let end = this.pos;
    while (end < this.source.length && NAME_CHAR.test(this.source[end]!)) end += 1;
    const value = this.source.slice(this.pos, end);
    this.pos = end;
    return { type: 'name', value };
  }
}

// --------------------------------------------------------------------------- parser

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = new Lexer(source).run();
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  /** True when the next token is the given punctuation mark. */
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.type === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
    }
  }

  /** Consume a name token, or fail naming what was expected instead. */
  private takeName(what: string): string {
    const token = this.next();
    if (token.type !== 'name') throw new Error(what);
    return token.value;
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.takeName('expected a directive name');
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const first = this.peek();
    if (first.type === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
      if (this.peek().type === 'name') name = this.next().value as string;
    }
    // Variable definitions ($owner: String!, ...) are parsed and discarded.
    if (this.atPunct('(')) {
      this.next();
      let depth = 1;
      while (depth > 0) {
        const token = this.next();
        if (token.type === 'eof') throw new Error('unterminated variable definitions');
        if (token.type === 'punct' && token.value === '(') depth += 1;
        if (token.type === 'punct' && token.value === ')') depth -= 1;
      }
    }
    this.skipDirectives();
    return { type, name, selections: this.parseSelectionSet() };
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().type === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().type === 'spread') {
      this.next();
      let typeCondition: string | null = null;
      const on = this.peek();
      if (on.type === 'name' && on.value === 'on') {
        this.next();
        typeCondition = this.takeName('expected a type name after on');
      }
      this.skipDirectives();
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.type !== 'name') throw new Error('expected a field name');
    let alias = first.value;
    let name = first.value;
    if (this.atPunct(':')) {
      this.next();
      name = this.takeName('expected a field name after an alias');
    }
    const args = this.atPunct('(') ? this.parseArguments() : {};
    this.skipDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    while (!this.atPunct(')')) {
      if (this.peek().type === 'eof') throw new Error('unterminated arguments');
      const key = this.takeName('expected an argument name');
      this.expectPunct(':');
      args[key] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.type === 'string' || token.type === 'int' || token.type === 'float') return token.value;
    if (token.type === 'variable') return { __variable: token.value };
    if (token.type === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { __enum: token.value };
    }
    if (token.type === 'punct' && token.value === '[') {
      const list: unknown[] = [];
      while (!this.atPunct(']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list;
    }
    if (token.type === 'punct' && token.value === '{') {
      const object: Record<string, unknown> = {};
      while (!this.atPunct('}')) {
        const key = this.takeName('expected an object field name');
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      this.expectPunct('}');
      return object;
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// --------------------------------------------------------------------------- values

/** Resolve variables and enum wrappers in a parsed value, recursively. */
function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__variable' in (value as Record<string, unknown>)) {
      return variables[(value as { __variable: string }).__variable];
    }
    if ('__enum' in (value as Record<string, unknown>)) {
      return (value as { __enum: string }).__enum;
    }
    if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = resolveValue(entry, variables);
    }
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// --------------------------------------------------------------------------- global ids

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function unb64url(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: Repo): string {
  return b64url(`Repository:${repo.id}`);
}

export function issueGlobalId(repo: Repo, number: number): string {
  return b64url(`Issue:${repo.id}:${number}`);
}

export function pullGlobalId(repo: Repo, number: number): string {
  return b64url(`PullRequest:${repo.id}:${number}`);
}

export function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return b64url(`IssueComment:${repo.id}:${issueNumber}:${commentId}`);
}

interface DecodedId {
  type: string;
  repoId: number;
  number: number;
  commentId: number;
}

function decodeGlobalId(id: string): DecodedId | null {
  const text = unb64url(id);
  if (text === null) return null;
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const type = parts[0]!;
  const repoId = Number(parts[1]);
  if (!Number.isInteger(repoId)) return null;
  return {
    type,
    repoId,
    number: parts.length > 2 ? Number(parts[2]) : 0,
    commentId: parts.length > 3 ? Number(parts[3]) : 0,
  };
}

// --------------------------------------------------------------------------- schema (for introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'resourcePath'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'mergedAt', 'mergeCommit', 'createdAt', 'updatedAt', 'author', 'url', 'resourcePath'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url', 'resourcePath'],
  User: ['id', 'login', 'name', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'PACKAGE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// --------------------------------------------------------------------------- response shapes

function findRepoById(store: Store, repoId: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === repoId) return repo;
  return undefined;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    __repo: repo,
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    private: repo.private,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.created_at,
    updatedAt: repo.updated_at,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    resourcePath: `/${repo.owner}/${repo.name}`,
  };
}

function userJson(login: string): Record<string, unknown> {
  return { __typename: 'User', login, id: b64url(`User:${login}`), name: login, url: `https://github.com/${login}` };
}

function issueJson(repo: Repo, issue: { number: number; title: string; body: string; state: string }): Record<string, unknown> {
  return {
    __typename: 'Issue',
    __repo: repo,
    __number: issue.number,
    id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    closedAt: issue.state === 'closed' ? FIXED_TIME : null,
    author: userJson(repo.owner),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    resourcePath: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  const mergeable = pull.merged ? 'UNKNOWN' : mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __number: pull.number,
    id: pullGlobalId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergeable,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRef: { __typename: 'Ref', name: pull.headRef, target: { oid: headTip } },
    baseRef: { __typename: 'Ref', name: pull.baseRef, target: { oid: baseTip } },
    mergedAt: pull.merged_at,
    mergeCommit: pull.merge_commit_sha ? { oid: pull.merge_commit_sha } : null,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    author: userJson(repo.owner),
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    resourcePath: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function cursorFor(number: number): string {
  return b64url(`cursor:${number}`);
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  const text = unb64url(cursor);
  if (text === null || !text.startsWith('cursor:')) return null;
  const number = Number(text.slice('cursor:'.length));
  return Number.isInteger(number) ? number : null;
}

// --------------------------------------------------------------------------- execution

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

interface ExecContext {
  store: Store;
  viewerLogin: string;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

/**
 * A plain scalar field: the stored value, or null when the object lacks it.
 * Returns undefined when the name is not one of the type's scalars, so the caller
 * can fall through to the type's object-valued fields.
 */
function scalarField(object: Record<string, unknown>, name: string, allowed: readonly string[]): unknown {
  return allowed.includes(name) ? (object[name] ?? null) : undefined;
}

function fieldError(ctx: ExecContext, typeName: string, field: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
}

/** Resolve one object's fields against a selection set. */
function resolveFields(
  ctx: ExecContext,
  object: Record<string, unknown> | null,
  selections: Selection[],
): Record<string, unknown> | null {
  if (object === null || object === undefined) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== object.__typename) continue;
      const nested = resolveFields(ctx, object, selection.selections);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    out[selection.alias] = resolveField(ctx, object, selection);
  }
  return out;
}

/** Resolve one field of an object. Unknown fields record a validation error. */
function resolveField(ctx: ExecContext, object: Record<string, unknown>, field: FieldSel): unknown {
  const typeName = String(object.__typename ?? 'Unknown');
  const args = resolveArgs(field.args, ctx.variables);
  const name = field.name;

  // __type introspection (a root field; handled here for the aliased form too).
  if (name === '__type') {
    const typeNameArg = String(args.name ?? '');
    if (TYPE_FIELDS[typeNameArg] !== undefined || ENUM_VALUES[typeNameArg] !== undefined) {
      const typeObject: Record<string, unknown> = {
        __typename: '__Type',
        name: typeNameArg,
        kind: ENUM_VALUES[typeNameArg] !== undefined ? 'ENUM' : 'OBJECT',
      };
      return resolveFields(ctx, typeObject, field.selections);
    }
    return null;
  }
  if (name === '__typename') return typeName;

  // Mutation payloads: the nested object (issue / pullRequest / commentEdge) resolves
  // its own sub-selections.
  if (typeName.endsWith('Payload')) {
    const value = object[name];
    if (value === null || value === undefined) return null;
    if (typeof value === 'object' && !Array.isArray(value)) {
      return resolveFields(ctx, value as Record<string, unknown>, field.selections);
    }
    return value;
  }

  // Introspection object fields.
  if (typeName === '__Type') {
    if (name === 'name' || name === 'kind') return object[name];
    if (name === 'fields') {
      const names = TYPE_FIELDS[String(object.name ?? '')] ?? [];
      return names.map((fieldName) => ({ __typename: '__Field', name: fieldName }));
    }
    if (name === 'enumValues') {
      const names = ENUM_VALUES[String(object.name ?? '')] ?? [];
      return names.map((valueName) => ({ __typename: '__EnumValue', name: valueName }));
    }
    fieldError(ctx, '__Type', name);
    return null;
  }
  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (name === 'name') return object.name;
    fieldError(ctx, typeName, name);
    return null;
  }

  if (typeName === 'User') {
    const scalar = scalarField(object, name, ['login', 'name', 'id', 'url']);
    if (scalar !== undefined) return scalar;
    fieldError(ctx, 'User', name);
    return null;
  }

  if (typeName === 'Ref') {
    if (name === 'name') return object.name;
    if (name === 'target') {
      const target = object.target as Record<string, unknown> | undefined;
      return target ? resolveFields(ctx, { __typename: 'Commit', ...target }, field.selections) : null;
    }
    fieldError(ctx, 'Ref', name);
    return null;
  }

  if (typeName === 'Commit') {
    const scalar = scalarField(object, name, ['oid']);
    if (scalar !== undefined) return scalar;
    fieldError(ctx, 'Commit', name);
    return null;
  }

  if (typeName === 'Repository') {
    const repo = object.__repo as Repo;
    const scalar = scalarField(object, name, [
      'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'private',
      'viewerPermission', 'hasIssuesEnabled', 'createdAt', 'updatedAt', 'url', 'resourcePath',
    ]);
    if (scalar !== undefined) return scalar;
    switch (name) {
      case 'owner':
        return resolveFields(ctx, userJson(repo.owner), field.selections);
      case 'defaultBranchRef': {
        const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!head) return null;
        return resolveFields(ctx, { __typename: 'Ref', name: repo.defaultBranch, target: { oid: head } }, field.selections);
      }
      case 'issue': {
        const number = Number(args.number);
        const issue = repo.issues.get(number);
        if (!issue) return null;
        return resolveFields(ctx, issueJson(repo, issue), field.selections);
      }
      case 'issues':
        return resolveIssues(ctx, repo, args, field.selections);
      case 'pullRequest': {
        const number = Number(args.number);
        const pull = repo.pulls.get(number);
        if (!pull) return null;
        return resolveFields(ctx, pullJson(repo, pull), field.selections);
      }
      case 'pullRequests':
        return resolvePulls(ctx, repo, args, field.selections);
      default:
        fieldError(ctx, 'Repository', name);
        return null;
    }
  }

  if (typeName === 'Issue') {
    const repo = object.__repo as Repo;
    const scalar = scalarField(object, name, [
      'id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'url', 'resourcePath',
    ]);
    if (scalar !== undefined) return scalar;
    switch (name) {
      case 'author':
        return resolveFields(ctx, userJson(repo.owner), field.selections);
      case 'labels': {
        const issue = repo.issues.get(Number(object.__number));
        const labels = (issue?.labels ?? []).map((label) => ({ __typename: 'Label', name: label.name, color: label.color, description: label.description }));
        if (field.selections.length === 0) return labels;
        return { nodes: labels };
      }
      case 'comments': {
        const issue = repo.issues.get(Number(object.__number));
        const comments = (issue?.comments ?? []).map((comment) => ({
          __typename: 'IssueComment',
          id: commentGlobalId(repo, issue!.number, comment.id),
          body: comment.body,
          createdAt: comment.created_at,
          author: userJson(repo.owner),
        }));
        return { nodes: comments, pageInfo: { hasNextPage: false, endCursor: null } };
      }
      default:
        fieldError(ctx, 'Issue', name);
        return null;
    }
  }

  if (typeName === 'PullRequest') {
    const repo = object.__repo as Repo;
    const pull = repo.pulls.get(Number(object.__number));
    const scalar = scalarField(object, name, [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
      'mergedAt', 'createdAt', 'updatedAt', 'url', 'resourcePath',
    ]);
    if (scalar !== undefined) return scalar;
    switch (name) {
      case 'headRef':
        return resolveFields(ctx, { __typename: 'Ref', name: pull?.headRef ?? '', target: { oid: repo.refs.get(`refs/heads/${pull?.headRef ?? ''}`) ?? '' } }, field.selections);
      case 'baseRef':
        return resolveFields(ctx, { __typename: 'Ref', name: pull?.baseRef ?? '', target: { oid: repo.refs.get(`refs/heads/${pull?.baseRef ?? ''}`) ?? '' } }, field.selections);
      case 'mergeCommit':
        return pull?.merge_commit_sha ? { __typename: 'Commit', oid: pull.merge_commit_sha } : null;
      case 'author':
        return resolveFields(ctx, userJson(repo.owner), field.selections);
      case 'files': {
        if (!pull) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
        const first = typeof args.first === 'number' ? args.first : 100;
        const files = pullFiles(repo, pull).slice(0, first);
        const nodes = files.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status }));
        return { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
      }
      default:
        fieldError(ctx, 'PullRequest', name);
        return null;
    }
  }

  if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') {
      const nodes = (object.nodes as Array<Record<string, unknown>>) ?? [];
      return nodes.map((node) => resolveFields(ctx, node, field.selections));
    }
    if (name === 'edges') {
      const nodes = (object.nodes as Array<Record<string, unknown>>) ?? [];
      return nodes.map((node) => ({ node: resolveFields(ctx, node, field.selections), cursor: cursorFor(Number(node.number ?? 0)) }));
    }
    if (name === 'pageInfo') {
      return resolveFields(ctx, object.pageInfo as Record<string, unknown>, field.selections);
    }
    if (name === 'totalCount') return ((object.nodes as unknown[]) ?? []).length;
    fieldError(ctx, typeName, name);
    return null;
  }

  if (typeName === 'PageInfo') {
    const scalar = scalarField(object, name, ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']);
    if (scalar !== undefined) return scalar;
    fieldError(ctx, 'PageInfo', name);
    return null;
  }

  if (typeName === 'IssueComment') {
    const scalar = scalarField(object, name, ['id', 'body', 'createdAt']);
    if (scalar !== undefined) return scalar;
    if (name === 'author') return resolveFields(ctx, userJson((object.__repo as Repo | undefined)?.owner ?? ''), field.selections);
    fieldError(ctx, 'IssueComment', name);
    return null;
  }

  if (typeName === 'IssueCommentEdge') {
    if (name === 'node') return resolveFields(ctx, object.node as Record<string, unknown>, field.selections);
    const scalar = scalarField(object, name, ['cursor']);
    if (scalar !== undefined) return scalar;
    fieldError(ctx, 'IssueCommentEdge', name);
    return null;
  }

  if (typeName === 'Label') {
    const scalar = scalarField(object, name, ['id', 'name', 'color', 'description']);
    if (scalar !== undefined) return scalar;
    fieldError(ctx, 'Label', name);
    return null;
  }

  if (typeName === 'PullRequestChangedFile') {
    const scalar = scalarField(object, name, ['path', 'additions', 'deletions', 'changeType']);
    if (scalar !== undefined) return scalar;
    fieldError(ctx, 'PullRequestChangedFile', name);
    return null;
  }

  fieldError(ctx, typeName, name);
  return null;
}

// --------------------------------------------------------------------------- connections

/**
 * Assemble a connection object from one page of items. `totalCount` is the size of
 * the filtered list the page was cut from, so hasNextPage and totalCount agree.
 */
function connectionObject<T extends { number: number }>(
  typename: string,
  page: T[],
  totalCount: number,
  after: number | null,
  toNode: (item: T) => Record<string, unknown>,
): Record<string, unknown> {
  return {
    __typename: typename,
    nodes: page.map(toNode),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: totalCount > page.length,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    },
    totalCount,
  };
}

function resolveIssues(
  ctx: ExecContext,
  repo: Repo,
  args: Record<string, unknown>,
  selections: Selection[],
): Record<string, unknown> {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy?.field === 'CREATED_AT') {
    issues.sort((a, b) => (orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number));
  } else {
    issues.sort((a, b) => a.number - b.number);
  }
  const after = numberFromCursor(args.after as string | null | undefined);
  if (after !== null) issues = issues.filter((issue) => issue.number > after);
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  const connection = connectionObject('IssueConnection', page, issues.length, after, (issue) => issueJson(repo, issue));
  return resolveFields(ctx, connection, selections) as Record<string, unknown>;
}

function resolvePulls(
  ctx: ExecContext,
  repo: Repo,
  args: Record<string, unknown>,
  selections: Selection[],
): Record<string, unknown> {
  let pulls = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.state));
  } else {
    // Default: open only (gh pr list's default).
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  pulls.sort((a, b) => b.number - a.number);
  const after = numberFromCursor(args.after as string | null | undefined);
  if (after !== null) pulls = pulls.filter((pull) => pull.number < after);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  const connection = connectionObject('PullRequestConnection', page, pulls.length, after, (pull) => pullJson(repo, pull));
  return resolveFields(ctx, connection, selections) as Record<string, unknown>;
}

// --------------------------------------------------------------------------- root

function resolveRootField(ctx: ExecContext, field: FieldSel): unknown {
  const args = resolveArgs(field.args, ctx.variables);
  const name = field.name;

  if (field.name === '__type') {
    const typeNameArg = String(args.name ?? '');
    if (TYPE_FIELDS[typeNameArg] !== undefined || ENUM_VALUES[typeNameArg] !== undefined) {
      const typeObject: Record<string, unknown> = {
        __typename: '__Type',
        name: typeNameArg,
        kind: ENUM_VALUES[typeNameArg] !== undefined ? 'ENUM' : 'OBJECT',
      };
      return resolveFields(ctx, typeObject, field.selections);
    }
    return null;
  }

  if (name === 'viewer') {
    return resolveFields(ctx, userJson(ctx.viewerLogin), field.selections);
  }

  if (name === 'repository') {
    const owner = String(args.owner ?? '');
    const repoName = String(args.name ?? '');
    let repo: Repo | undefined;
    for (const candidate of ctx.store.repos.values()) {
      if (candidate.owner === owner && candidate.name === repoName) {
        repo = candidate;
        break;
      }
    }
    if (!repo) return null;
    return resolveFields(ctx, repoJson(repo), field.selections);
  }

  if (name === 'node') {
    const decoded = decodeGlobalId(String(args.id ?? ''));
    if (!decoded) return null;
    if (decoded.type === 'Repository') {
      const repo = findRepoById(ctx.store, decoded.repoId);
      if (!repo) return null;
      return resolveFields(ctx, repoJson(repo), field.selections);
    }
    if (decoded.type === 'Issue') {
      const repo = findRepoById(ctx.store, decoded.repoId);
      const issue = repo?.issues.get(decoded.number);
      if (!repo || !issue) return null;
      return resolveFields(ctx, issueJson(repo, issue), field.selections);
    }
    if (decoded.type === 'PullRequest') {
      const repo = findRepoById(ctx.store, decoded.repoId);
      const pull = repo?.pulls.get(decoded.number);
      if (!repo || !pull) return null;
      return resolveFields(ctx, pullJson(repo, pull), field.selections);
    }
    return null;
  }

  // Mutations.
  if (name === 'createIssue') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.type !== 'Repository') {
      ctx.errors.push({ message: 'createIssue: unknown repositoryId.' });
      return null;
    }
    const repo = findRepoById(ctx.store, decoded.repoId);
    if (!repo) {
      ctx.errors.push({ message: 'createIssue: unknown repositoryId.' });
      return null;
    }
    const created = createIssue(ctx.store, repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
    });
    if ('error' in created) {
      ctx.errors.push({ message: `createIssue: ${created.error}.` });
      return null;
    }
    return resolveFields(ctx, { __typename: 'CreateIssuePayload', issue: issueJson(repo, created) }, field.selections);
  }

  if (name === 'closeIssue') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    if (!decoded || decoded.type !== 'Issue') {
      ctx.errors.push({ message: 'closeIssue: unknown issueId.' });
      return null;
    }
    const repo = findRepoById(ctx.store, decoded.repoId);
    const issue = repo?.issues.get(decoded.number);
    if (!repo || !issue) {
      ctx.errors.push({ message: 'closeIssue: unknown issueId.' });
      return null;
    }
    issue.state = 'closed';
    issue.closed_at = FIXED_TIME;
    issue.updated_at = FIXED_TIME;
    return resolveFields(ctx, { __typename: 'CloseIssuePayload', issue: issueJson(repo, issue) }, field.selections);
  }

  if (name === 'createPullRequest') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    if (!decoded || decoded.type !== 'Repository') {
      ctx.errors.push({ message: 'createPullRequest: unknown repositoryId.' });
      return null;
    }
    const repo = findRepoById(ctx.store, decoded.repoId);
    if (!repo) {
      ctx.errors.push({ message: 'createPullRequest: unknown repositoryId.' });
      return null;
    }
    const created = createPull(ctx.store, repo, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      head: String(input.headRefName ?? ''),
      base: String(input.baseRefName ?? ''),
    });
    if ('error' in created) {
      ctx.errors.push({ message: `createPullRequest: ${created.error}.` });
      return null;
    }
    return resolveFields(ctx, { __typename: 'CreatePullRequestPayload', pullRequest: pullJson(repo, created) }, field.selections);
  }

  if (name === 'mergePullRequest') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    if (!decoded || decoded.type !== 'PullRequest') {
      ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId.' });
      return null;
    }
    const repo = findRepoById(ctx.store, decoded.repoId);
    const pull = repo?.pulls.get(decoded.number);
    if (!repo || !pull) {
      ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId.' });
      return null;
    }
    const merged = mergePull(repo, pull);
    if ('error' in merged) {
      ctx.errors.push({ message: `mergePullRequest: ${merged.error}.` });
      return null;
    }
    return resolveFields(ctx, { __typename: 'MergePullRequestPayload', pullRequest: pullJson(repo, pull) }, field.selections);
  }

  if (name === 'addComment') {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    if (!decoded || decoded.type !== 'Issue') {
      ctx.errors.push({ message: 'addComment: unknown subjectId.' });
      return null;
    }
    const repo = findRepoById(ctx.store, decoded.repoId);
    const issue = repo?.issues.get(decoded.number);
    if (!repo || !issue) {
      ctx.errors.push({ message: 'addComment: unknown subjectId.' });
      return null;
    }
    const body = String(input.body ?? '');
    const comment = { id: repo.nextCommentId++, body, created_at: FIXED_TIME };
    issue.comments.push(comment);
    const node: Record<string, unknown> = {
      __typename: 'IssueComment',
      __repo: repo,
      id: commentGlobalId(repo, issue.number, comment.id),
      body: comment.body,
      createdAt: comment.created_at,
      author: userJson(repo.owner),
    };
    const edge: Record<string, unknown> = { __typename: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) };
    return resolveFields(ctx, { __typename: 'AddCommentPayload', commentEdge: edge }, field.selections);
  }

  ctx.errors.push({ message: `Cannot query field "${name}" on type "Query".` });
  return null;
}

/** Execute one parsed operation. Unknown root fields and unknown nested fields error. */
export function executeOperation(
  store: Store,
  viewerLogin: string,
  operation: Operation,
  variables: Record<string, unknown>,
): GraphQLResult {
  const ctx: ExecContext = { store, viewerLogin, variables, errors: [] };
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind === 'fragment') {
      // A fragment at the root applies to Query/Mutation.
      const nested = resolveFields(ctx, { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' }, selection.selections);
      if (nested !== null) Object.assign(data, nested);
      continue;
    }
    data[selection.alias] = resolveRootField(ctx, selection);
  }
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data, errors: [] };
}

/** Parse and execute a GraphQL document string. */
export function executeGraphQL(
  store: Store,
  viewerLogin: string,
  query: string,
  variables: Record<string, unknown>,
): GraphQLResult {
  let operation: Operation;
  try {
    operation = new Parser(query).parseOperation();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  return executeOperation(store, viewerLogin, operation, variables);
}
