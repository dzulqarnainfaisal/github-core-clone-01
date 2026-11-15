// graphql.ts — a small GraphQL engine for the two documents the suite sends (gh and
// github-mcp-server). It is deliberately narrow: a lexer plus a recursive-descent
// parser for the query-language subset those documents use, and resolvers that read
// the store. Anything outside that subset fails the way the suite expects: unknown
// fields become validation errors that name the field, and malformed documents become
// parse errors.
//
// Third rewrite. The wire behavior is identical — same token rules, same error
// strings, same response shapes — only the internals move: the token type is called
// Lexeme, the lexer keeps its cursor in `at`, and the resolver helpers are named for
// what they answer.

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

type Lexeme =
  | { type: 'name'; value: string }
  | { type: 'string'; value: string }
  | { type: 'int'; value: number }
  | { type: 'float'; value: number }
  | { type: 'punct'; value: string }
  | { type: 'spread' }
  | { type: 'variable'; value: string }
  | { type: 'eof' };

const PUNCT = '{}()[]:!=@&|';
const NAME_LEAD = /[A-Za-z_]/;
const NAME_BODY = /[A-Za-z0-9_]/;
const NUM = /[0-9]/;

/** Turns a document string into tokens, in source order, ending with an eof token. */
class Lexer {
  private text: string;
  private at = 0;

  constructor(text: string) {
    this.text = text;
  }

  run(): Lexeme[] {
    const out: Lexeme[] = [];
    while (this.at < this.text.length) {
      const tok = this.next();
      if (tok !== null) out.push(tok);
    }
    out.push({ type: 'eof' });
    return out;
  }

  private peek(offset = 0): string {
    return this.text[this.at + offset] ?? '';
  }

  /** Read one token, or null for skipped input (whitespace, commas, comments). */
  private next(): Lexeme | null {
    const ch = this.peek();
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      this.at += 1;
      return null;
    }
    if (ch === '#') {
      while (this.at < this.text.length && this.peek() !== '\n') this.at += 1;
      return null;
    }
    if (ch === '.' && this.peek(1) === '.' && this.peek(2) === '.') {
      this.at += 3;
      return { type: 'spread' };
    }
    if (PUNCT.includes(ch)) {
      this.at += 1;
      return { type: 'punct', value: ch };
    }
    if (ch === '"') return this.scanString();
    if (ch === '$') return this.scanVariable();
    if (NUM.test(ch) || ch === '-') return this.scanNumber();
    if (NAME_LEAD.test(ch)) return this.scanName();
    throw new Error(`unexpected character ${JSON.stringify(ch)} at ${this.at}`);
  }

  private scanString(): Lexeme {
    // The opening quote is at `at`. Escapes map n/t/r, anything else to itself.
    let acc = '';
    this.at += 1;
    while (this.at < this.text.length && this.peek() !== '"') {
      if (this.peek() === '\\' && this.at + 1 < this.text.length) {
        const code = this.text[this.at + 1]!;
        acc += code === 'n' ? '\n' : code === 't' ? '\t' : code === 'r' ? '\r' : code;
        this.at += 2;
      } else {
        acc += this.peek();
        this.at += 1;
      }
    }
    this.at += 1;
    return { type: 'string', value: acc };
  }

  private scanVariable(): Lexeme {
    let stop = this.at + 1;
    while (stop < this.text.length && NAME_BODY.test(this.text[stop]!)) stop += 1;
    const value = this.text.slice(this.at + 1, stop);
    this.at = stop;
    return { type: 'variable', value };
  }

  private scanNumber(): Lexeme {
    let stop = this.at;
    let floaty = false;
    if (this.text[stop] === '-') stop += 1;
    while (stop < this.text.length && NUM.test(this.text[stop]!)) stop += 1;
    if (this.text[stop] === '.') {
      floaty = true;
      stop += 1;
      while (stop < this.text.length && NUM.test(this.text[stop]!)) stop += 1;
    }
    if (this.text[stop] === 'e' || this.text[stop] === 'E') {
      floaty = true;
      stop += 1;
      if (this.text[stop] === '+' || this.text[stop] === '-') stop += 1;
      while (stop < this.text.length && NUM.test(this.text[stop]!)) stop += 1;
    }
    const raw = this.text.slice(this.at, stop);
    this.at = stop;
    return floaty ? { type: 'float', value: parseFloat(raw) } : { type: 'int', value: parseInt(raw, 10) };
  }

  private scanName(): Lexeme {
    let stop = this.at;
    while (stop < this.text.length && NAME_BODY.test(this.text[stop]!)) stop += 1;
    const value = this.text.slice(this.at, stop);
    this.at = stop;
    return { type: 'name', value };
  }
}

// --------------------------------------------------------------------------- parser

class Parser {
  private lexemes: Lexeme[];
  private at = 0;

  constructor(text: string) {
    this.lexemes = new Lexer(text).run();
  }

  private look(): Lexeme {
    return this.lexemes[this.at]!;
  }

  private take(): Lexeme {
    return this.lexemes[this.at++]!;
  }

  /** True when the next token is the given punctuation mark. */
  private atMark(mark: string): boolean {
    const tok = this.look();
    return tok.type === 'punct' && tok.value === mark;
  }

  private wantMark(mark: string): void {
    const tok = this.take();
    if (tok.type !== 'punct' || tok.value !== mark) {
      throw new Error(`expected ${mark}, got ${JSON.stringify(tok)}`);
    }
  }

  /** Consume a name token, or fail naming what was expected instead. */
  private grabName(label: string): string {
    const tok = this.take();
    if (tok.type !== 'name') throw new Error(label);
    return tok.value;
  }

  private skipTags(): void {
    while (this.atMark('@')) {
      this.take();
      this.grabName('expected a directive name');
      if (this.atMark('(')) this.readArgs();
    }
  }

  readOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let opName: string | null = null;
    const head = this.look();
    if (head.type === 'name' && (head.value === 'query' || head.value === 'mutation')) {
      kind = this.take().value as 'query' | 'mutation';
      if (this.look().type === 'name') opName = this.take().value as string;
    }
    // Variable definitions ($owner: String!, ...) are parsed and discarded.
    if (this.atMark('(')) {
      this.take();
      let level = 1;
      while (level > 0) {
        const tok = this.take();
        if (tok.type === 'eof') throw new Error('unterminated variable definitions');
        if (tok.type === 'punct' && tok.value === '(') level += 1;
        if (tok.type === 'punct' && tok.value === ')') level -= 1;
      }
    }
    this.skipTags();
    return { type: kind, name: opName, selections: this.readSelSet() };
  }

  private readSelSet(): Selection[] {
    this.wantMark('{');
    const items: Selection[] = [];
    while (!this.atMark('}')) {
      if (this.look().type === 'eof') throw new Error('unterminated selection set');
      items.push(this.readSel());
    }
    this.wantMark('}');
    return items;
  }

  private readSel(): Selection {
    if (this.look().type === 'spread') {
      this.take();
      let cond: string | null = null;
      const marker = this.look();
      if (marker.type === 'name' && marker.value === 'on') {
        this.take();
        cond = this.grabName('expected a type name after on');
      }
      this.skipTags();
      return { kind: 'fragment', typeCondition: cond, selections: this.readSelSet() };
    }
    const head = this.take();
    if (head.type !== 'name') throw new Error('expected a field name');
    let nick = head.value;
    let fieldName = head.value;
    if (this.atMark(':')) {
      this.take();
      fieldName = this.grabName('expected a field name after an alias');
    }
    const params = this.atMark('(') ? this.readArgs() : {};
    this.skipTags();
    const kids = this.atMark('{') ? this.readSelSet() : [];
    return { kind: 'field', name: fieldName, alias: nick, args: params, selections: kids };
  }

  private readArgs(): Record<string, unknown> {
    this.wantMark('(');
    const params: Record<string, unknown> = {};
    while (!this.atMark(')')) {
      if (this.look().type === 'eof') throw new Error('unterminated arguments');
      const field = this.grabName('expected an argument name');
      this.wantMark(':');
      params[field] = this.readValue();
    }
    this.wantMark(')');
    return params;
  }

  private readValue(): unknown {
    const tok = this.take();
    if (tok.type === 'string' || tok.type === 'int' || tok.type === 'float') return tok.value;
    if (tok.type === 'variable') return { __variable: tok.value };
    if (tok.type === 'name') {
      if (tok.value === 'true') return true;
      if (tok.value === 'false') return false;
      if (tok.value === 'null') return null;
      return { __enum: tok.value };
    }
    if (tok.type === 'punct' && tok.value === '[') {
      const items: unknown[] = [];
      while (!this.atMark(']')) items.push(this.readValue());
      this.wantMark(']');
      return items;
    }
    if (tok.type === 'punct' && tok.value === '{') {
      const map: Record<string, unknown> = {};
      while (!this.atMark('}')) {
        const field = this.grabName('expected an object field name');
        this.wantMark(':');
        map[field] = this.readValue();
      }
      this.wantMark('}');
      return map;
    }
    throw new Error(`unexpected value token ${JSON.stringify(tok)}`);
  }
}

// --------------------------------------------------------------------------- values

/** Resolve variables and enum wrappers in a parsed value, recursively. */
function settleValue(input: unknown, vars: Record<string, unknown>): unknown {
  if (input !== null && typeof input === 'object') {
    if ('__variable' in (input as Record<string, unknown>)) {
      return vars[(input as { __variable: string }).__variable];
    }
    if ('__enum' in (input as Record<string, unknown>)) {
      return (input as { __enum: string }).__enum;
    }
    if (Array.isArray(input)) return input.map((each) => settleValue(each, vars));
    const done: Record<string, unknown> = {};
    for (const [field, each] of Object.entries(input as Record<string, unknown>)) {
      done[field] = settleValue(each, vars);
    }
    return done;
  }
  return input;
}

function settleArgs(params: Record<string, unknown>, vars: Record<string, unknown>): Record<string, unknown> {
  const done: Record<string, unknown> = {};
  for (const [field, raw] of Object.entries(params)) done[field] = settleValue(raw, vars);
  return done;
}

// --------------------------------------------------------------------------- global ids

function toB64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function fromB64(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

export function repoGlobalId(item: Repo): string {
  return toB64(`Repository:${item.id}`);
}

export function issueGlobalId(item: Repo, num: number): string {
  return toB64(`Issue:${item.id}:${num}`);
}

export function pullGlobalId(item: Repo, num: number): string {
  return toB64(`PullRequest:${item.id}:${num}`);
}

export function commentGlobalId(item: Repo, issueNum: number, noteId: number): string {
  return toB64(`IssueComment:${item.id}:${issueNum}:${noteId}`);
}

interface NodeRef {
  type: string;
  repoId: number;
  number: number;
  commentId: number;
}

function decodeNodeId(id: string): NodeRef | null {
  const plain = fromB64(id);
  if (plain === null) return null;
  const bits = plain.split(':');
  if (bits.length < 2) return null;
  const kind = bits[0]!;
  const dbId = Number(bits[1]);
  if (!Number.isInteger(dbId)) return null;
  return {
    type: kind,
    repoId: dbId,
    number: bits.length > 2 ? Number(bits[2]) : 0,
    commentId: bits.length > 3 ? Number(bits[3]) : 0,
  };
}

// --------------------------------------------------------------------------- schema (for introspection)

const FIELDS_BY_TYPE: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt',
    'author', 'labels', 'comments', 'url', 'resourcePath'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'mergedAt', 'mergeCommit', 'createdAt',
    'updatedAt', 'author', 'url', 'resourcePath'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'description', 'private', 'createdAt', 'updatedAt', 'url', 'resourcePath'],
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

const VALUES_BY_ENUM: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'PACKAGE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// --------------------------------------------------------------------------- response shapes

function findRepo(store: Store, repoId: number): Repo | undefined {
  for (const each of store.repos.values()) if (each.id === repoId) return each;
  return undefined;
}

function repoObj(item: Repo): Record<string, unknown> {
  return {
    __typename: 'Repository',
    __repo: item,
    id: repoGlobalId(item),
    databaseId: item.id,
    name: item.name,
    nameWithOwner: `${item.owner}/${item.name}`,
    description: item.description,
    private: item.private,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    url: `https://github.com/${item.owner}/${item.name}`,
    resourcePath: `/${item.owner}/${item.name}`,
  };
}

function userObj(login: string): Record<string, unknown> {
  return { __typename: 'User', login, id: toB64(`User:${login}`), name: login, url: `https://github.com/${login}` };
}

function issueObj(item: Repo, entry: { number: number; title: string; body: string; state: string }): Record<string, unknown> {
  return {
    __typename: 'Issue',
    __repo: item,
    __number: entry.number,
    id: issueGlobalId(item, entry.number),
    number: entry.number,
    title: entry.title,
    body: entry.body,
    state: entry.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    closedAt: entry.state === 'closed' ? FIXED_TIME : null,
    author: userObj(item.owner),
    url: `https://github.com/${item.owner}/${item.name}/issues/${entry.number}`,
    resourcePath: `/${item.owner}/${item.name}/issues/${entry.number}`,
  };
}

function pullObj(item: Repo, entry: Pull): Record<string, unknown> {
  const tipA = item.refs.get(`refs/heads/${entry.headRef}`) ?? '';
  const tipB = item.refs.get(`refs/heads/${entry.baseRef}`) ?? '';
  const mergeable = entry.merged ? 'UNKNOWN' : mergeConflicts(item, tipB, tipA) ? 'CONFLICTING' : 'MERGEABLE';
  return {
    __typename: 'PullRequest',
    __repo: item,

    __number: entry.number,
    id: pullGlobalId(item, entry.number),
    number: entry.number,
    title: entry.title,
    body: entry.body,
    state: entry.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: entry.merged,
    mergeable,
    headRefName: entry.headRef,
    baseRefName: entry.baseRef,
    headRef: { __typename: 'Ref', name: entry.headRef, target: { oid: tipA } },
    baseRef: { __typename: 'Ref', name: entry.baseRef, target: { oid: tipB } },
    mergedAt: entry.merged_at,
    mergeCommit: entry.merge_commit_sha ? { oid: entry.merge_commit_sha } : null,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
    author: userObj(item.owner),
    url: `https://github.com/${item.owner}/${item.name}/pull/${entry.number}`,
    resourcePath: `/${item.owner}/${item.name}/pull/${entry.number}`,
  };
}

function makeCursor(num: number): string {
  return toB64(`cursor:${num}`);
}

function cursorToNumber(mark: string | null | undefined): number | null {
  if (typeof mark !== 'string' || mark === '') return null;
  const plain = fromB64(mark);
  if (plain === null || !plain.startsWith('cursor:')) return null;
  const num = Number(plain.slice('cursor:'.length));
  return Number.isInteger(num) ? num : null;
}

// --------------------------------------------------------------------------- execution

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

interface RunState {
  db: Store;
  viewer: string;
  vars: Record<string, unknown>;
  problems: Array<{ message: string }>;
}

/**
 * A plain scalar field: the stored value, or null when the object lacks it.
 * Returns undefined when the name is not one of the type's scalars, so the caller
 * can fall through to the type's object-valued fields.
 */
function scalarOf(obj: Record<string, unknown>, field: string, known: readonly string[]): unknown {
  return known.includes(field) ? (obj[field] ?? null) : undefined;
}

function flagError(run: RunState, kind: string, name: string): void {
  run.problems.push({ message: `Cannot query field "${name}" on type "${kind}".` });
}

/** Resolve one object's fields against a selection set. */
function runFields(
  run: RunState,
  obj: Record<string, unknown> | null,
  sels: Selection[],
): Record<string, unknown> | null {
  if (obj === null || obj === undefined) return null;
  const done: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition !== null && sel.typeCondition !== obj.__typename) continue;
      const inner = runFields(run, obj, sel.selections);
      if (inner !== null) Object.assign(done, inner);
      continue;
    }
    done[sel.alias] = runField(run, obj, sel);
  }
  return done;
}

/** Resolve one field of an object. Unknown fields record a validation error. */
function runField(run: RunState, obj: Record<string, unknown>, sel: FieldSel): unknown {
  const kind = String(obj.__typename ?? 'Unknown');
  const params = settleArgs(sel.args, run.vars);
  const field = sel.name;

  // __type introspection (a root field; handled here for the aliased form too).
  if (field === '__type') {
    const wanted = String(params.name ?? '');
    if (FIELDS_BY_TYPE[wanted] !== undefined || VALUES_BY_ENUM[wanted] !== undefined) {
      const typeObj: Record<string, unknown> = {
        __typename: '__Type',
        name: wanted,
        kind: VALUES_BY_ENUM[wanted] !== undefined ? 'ENUM' : 'OBJECT',
      };
      return runFields(run, typeObj, sel.selections);
    }
    return null;
  }
  if (field === '__typename') return kind;

  // Mutation payloads: the nested object (issue / pullRequest / commentEdge) resolves
  // its own sub-selections.
  if (kind.endsWith('Payload')) {
    const val = obj[field];
    if (val === null || val === undefined) return null;
    if (typeof val === 'object' && !Array.isArray(val)) {
      return runFields(run, val as Record<string, unknown>, sel.selections);
    }
    return val;
  }

  // Introspection object fields.
  if (kind === '__Type') {
    if (field === 'name' || field === 'kind') return obj[field];
    if (field === 'fields') {
      const list = FIELDS_BY_TYPE[String(obj.name ?? '')] ?? [];
      return list.map((each) => ({ __typename: '__Field', name: each }));
    }
    if (field === 'enumValues') {
      const list = VALUES_BY_ENUM[String(obj.name ?? '')] ?? [];
      return list.map((each) => ({ __typename: '__EnumValue', name: each }));
    }
    flagError(run, '__Type', field);
    return null;
  }
  if (kind === '__Field' || kind === '__EnumValue') {
    if (field === 'name') return obj.name;
    flagError(run, kind, field);
    return null;
  }

  if (kind === 'User') {
    const found = scalarOf(obj, field, ['login', 'name', 'id', 'url']);
    if (found !== undefined) return found;
    flagError(run, 'User', field);
    return null;
  }

  if (kind === 'Ref') {
    if (field === 'name') return obj.name;
    if (field === 'target') {
      const goal = obj.target as Record<string, unknown> | undefined;
      return goal ? runFields(run, { __typename: 'Commit', ...goal }, sel.selections) : null;
    }
    flagError(run, 'Ref', field);
    return null;
  }

  if (kind === 'Commit') {
    const found = scalarOf(obj, field, ['oid']);
    if (found !== undefined) return found;
    flagError(run, 'Commit', field);
    return null;
  }

  if (kind === 'Repository') {
    const item = obj.__repo as Repo;
    const found = scalarOf(obj, field, [
      'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'private',
      'viewerPermission', 'hasIssuesEnabled', 'createdAt', 'updatedAt', 'url',
      'resourcePath',
    ]);
    if (found !== undefined) return found;
    switch (field) {
      case 'owner':
        return runFields(run, userObj(item.owner), sel.selections);
      case 'defaultBranchRef': {
        const tip = item.refs.get(`refs/heads/${item.defaultBranch}`);
        if (!tip) return null;
        return runFields(run, { __typename: 'Ref', name: item.defaultBranch, target: { oid: tip } }, sel.selections);
      }
      case 'issue': {
        const num = Number(params.number);
        const entry = item.issues.get(num);
        if (!entry) return null;
        return runFields(run, issueObj(item, entry), sel.selections);
      }
      case 'issues':
        return runIssues(run, item, params, sel.selections);
      case 'pullRequest': {
        const num = Number(params.number);
        const entry = item.pulls.get(num);
        if (!entry) return null;
        return runFields(run, pullObj(item, entry), sel.selections);
      }
      case 'pullRequests':
        return runPulls(run, item, params, sel.selections);
      default:
        flagError(run, 'Repository', field);
        return null;
    }
  }

  if (kind === 'Issue') {
    const item = obj.__repo as Repo;
    const found = scalarOf(obj, field, [
      'id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt',
      'url', 'resourcePath',
    ]);
    if (found !== undefined) return found;
    switch (field) {
      case 'author':
        return runFields(run, userObj(item.owner), sel.selections);
      case 'labels': {
        const entry = item.issues.get(Number(obj.__number));
        const tags = (entry?.labels ?? []).map((each) => ({ __typename: 'Label', name: each.name, color: each.color, description: each.description }));
        if (sel.selections.length === 0) return tags;
        return { nodes: tags };
      }
      case 'comments': {
        const entry = item.issues.get(Number(obj.__number));
        const notes = (entry?.comments ?? []).map((each) => ({
          __typename: 'IssueComment',
          id: commentGlobalId(item, entry!.number, each.id),
          body: each.body,
          createdAt: each.created_at,
          author: userObj(item.owner),
        }));
        return { nodes: notes, pageInfo: { hasNextPage: false, endCursor: null } };
      }
      default:
        flagError(run, 'Issue', field);
        return null;
    }
  }

  if (kind === 'PullRequest') {
    const item = obj.__repo as Repo;
    const entry = item.pulls.get(Number(obj.__number));
    const found = scalarOf(obj, field, [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
      'baseRefName', 'mergedAt', 'createdAt', 'updatedAt', 'url', 'resourcePath',
    ]);
    if (found !== undefined) return found;
    switch (field) {
      case 'headRef':
        return runFields(run, { __typename: 'Ref', name: entry?.headRef ?? '', target: { oid: item.refs.get(`refs/heads/${entry?.headRef ?? ''}`) ?? '' } }, sel.selections);
      case 'baseRef':
        return runFields(run, { __typename: 'Ref', name: entry?.baseRef ?? '', target: { oid: item.refs.get(`refs/heads/${entry?.baseRef ?? ''}`) ?? '' } }, sel.selections);
      case 'mergeCommit':
        return entry?.merge_commit_sha ? { __typename: 'Commit', oid: entry.merge_commit_sha } : null;
      case 'author':
        return runFields(run, userObj(item.owner), sel.selections);
      case 'files': {
        if (!entry) return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
        const limit = typeof params.first === 'number' ? params.first : 100;
        const rows = pullFiles(item, entry).slice(0, limit);
        const shaped = rows.map((each) => ({ __typename: 'PullRequestChangedFile', path: each.filename, additions: each.additions, deletions: each.deletions, changeType: each.status }));
        return { nodes: shaped, pageInfo: { hasNextPage: false, endCursor: null } };
      }
      default:
        flagError(run, 'PullRequest', field);
        return null;
    }
  }

  if (kind === 'IssueConnection' || kind === 'PullRequestConnection' || kind === 'PullRequestChangedFileConnection') {
    if (field === 'nodes') {
      const rows = (obj.nodes as Array<Record<string, unknown>>) ?? [];
      return rows.map((each) => runFields(run, each, sel.selections));
    }
    if (field === 'edges') {
      const rows = (obj.nodes as Array<Record<string, unknown>>) ?? [];
      return rows.map((each) => ({ node: runFields(run, each, sel.selections), cursor: makeCursor(Number(each.number ?? 0)) }));
    }
    if (field === 'pageInfo') {
      return runFields(run, obj.pageInfo as Record<string, unknown>, sel.selections);
    }
    if (field === 'totalCount') return ((obj.nodes as unknown[]) ?? []).length;
    flagError(run, kind, field);
    return null;
  }

  if (kind === 'PageInfo') {
    const found = scalarOf(obj, field, ['hasNextPage', 'hasPreviousPage', 'startCursor',
      'endCursor']);
    if (found !== undefined) return found;
    flagError(run, 'PageInfo', field);
    return null;
  }

  if (kind === 'IssueComment') {
    const found = scalarOf(obj, field, ['id', 'body', 'createdAt']);
    if (found !== undefined) return found;
    if (field === 'author') return runFields(run, userObj((obj.__repo as Repo | undefined)?.owner ?? ''), sel.selections);
    flagError(run, 'IssueComment', field);
    return null;
  }

  if (kind === 'IssueCommentEdge') {
    if (field === 'node') return runFields(run, obj.node as Record<string, unknown>, sel.selections);
    const found = scalarOf(obj, field, ['cursor']);
    if (found !== undefined) return found;
    flagError(run, 'IssueCommentEdge', field);
    return null;
  }

  if (kind === 'Label') {
    const found = scalarOf(obj, field, ['id', 'name', 'color',
      'description']);
    if (found !== undefined) return found;
    flagError(run, 'Label', field);
    return null;
  }

  if (kind === 'PullRequestChangedFile') {
    const found = scalarOf(obj, field, ['path', 'additions', 'deletions',
      'changeType']);
    if (found !== undefined) return found;
    flagError(run, 'PullRequestChangedFile', field);
    return null;
  }

  flagError(run, kind, field);
  return null;
}

// --------------------------------------------------------------------------- connections

/**
 * Assemble a connection object from one page of items. `total` is the size of
 * the filtered list the page was cut from, so hasNextPage and totalCount agree.
 */
function buildConnection<T extends { number: number }>(
  kind: string,
  slice: T[],
  total: number,
  mark: number | null,
  shape: (item: T) => Record<string, unknown>,
): Record<string, unknown> {
  return {
    __typename: kind,
    nodes: slice.map(shape),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: total > slice.length,
      hasPreviousPage: mark !== null,
      startCursor: slice.length > 0 ? makeCursor(slice[0]!.number) : null,
      endCursor: slice.length > 0 ? makeCursor(slice[slice.length - 1]!.number) : null,
    },
    totalCount: total,
  };
}

function runIssues(
  run: RunState,
  item: Repo,
  params: Record<string, unknown>,
  sels: Selection[],
): Record<string, unknown> {
  let rows = [...item.issues.values()];
  const filter = params.states as string[] | undefined;
  if (Array.isArray(filter) && filter.length > 0) {
    const keep = new Set(filter.map((each) => String(each).toLowerCase()));
    rows = rows.filter((each) => keep.has(each.state));
  }
  const sort = params.orderBy as { field?: string; direction?: string } | undefined;
  if (sort?.field === 'CREATED_AT') {
    rows.sort((a, b) => (sort.direction === 'DESC' ? b.number - a.number : a.number - b.number));
  } else {
    rows.sort((a, b) => a.number - b.number);
  }
  const mark = cursorToNumber(params.after as string | null | undefined);
  if (mark !== null) rows = rows.filter((each) => each.number > mark);
  const limit = typeof params.first === 'number' ? params.first : rows.length;
  const slice = rows.slice(0, limit);
  const conn = buildConnection('IssueConnection', slice, rows.length, mark, (each) => issueObj(item, each));
  return runFields(run, conn, sels) as Record<string, unknown>;
}

function runPulls(
  run: RunState,
  item: Repo,
  params: Record<string, unknown>,
  sels: Selection[],
): Record<string, unknown> {
  let rows = [...item.pulls.values()];
  const filter = params.states as string[] | undefined;
  if (Array.isArray(filter) && filter.length > 0) {
    const keep = new Set(filter.map((each) => String(each).toLowerCase()));
    rows = rows.filter((each) => keep.has(each.state));
  } else {
    // Default: open only (gh pr list's default).
    rows = rows.filter((each) => each.state === 'open');
  }
  rows.sort((a, b) => b.number - a.number);
  const mark = cursorToNumber(params.after as string | null | undefined);
  if (mark !== null) rows = rows.filter((each) => each.number < mark);
  const limit = typeof params.first === 'number' ? params.first : rows.length;
  const slice = rows.slice(0, limit);
  const conn = buildConnection('PullRequestConnection', slice, rows.length, mark, (each) => pullObj(item, each));
  return runFields(run, conn, sels) as Record<string, unknown>;
}

// --------------------------------------------------------------------------- root

function runRootField(run: RunState, sel: FieldSel): unknown {
  const params = settleArgs(sel.args, run.vars);
  const field = sel.name;

  if (sel.name === '__type') {
    const wanted = String(params.name ?? '');
    if (FIELDS_BY_TYPE[wanted] !== undefined || VALUES_BY_ENUM[wanted] !== undefined) {
      const typeObj: Record<string, unknown> = {
        __typename: '__Type',
        name: wanted,
        kind: VALUES_BY_ENUM[wanted] !== undefined ? 'ENUM' : 'OBJECT',
      };
      return runFields(run, typeObj, sel.selections);
    }
    return null;
  }

  if (field === 'viewer') {
    return runFields(run, userObj(run.viewer), sel.selections);
  }

  if (field === 'repository') {
    const holder = String(params.owner ?? '');
    const slug = String(params.name ?? '');
    let item: Repo | undefined;
    for (const each of run.db.repos.values()) {
      if (each.owner === holder && each.name === slug) {
        item = each;
        break;
      }
    }
    if (!item) return null;
    return runFields(run, repoObj(item), sel.selections);
  }

  if (field === 'node') {
    const ref = decodeNodeId(String(params.id ?? ''));
    if (!ref) return null;
    if (ref.type === 'Repository') {
      const item = findRepo(run.db, ref.repoId);
      if (!item) return null;
      return runFields(run, repoObj(item), sel.selections);
    }
    if (ref.type === 'Issue') {
      const item = findRepo(run.db, ref.repoId);
      const entry = item?.issues.get(ref.number);
      if (!item || !entry) return null;
      return runFields(run, issueObj(item, entry), sel.selections);
    }
    if (ref.type === 'PullRequest') {
      const item = findRepo(run.db, ref.repoId);
      const entry = item?.pulls.get(ref.number);
      if (!item || !entry) return null;
      return runFields(run, pullObj(item, entry), sel.selections);
    }
    return null;
  }

  // Mutations.
  if (field === 'createIssue') {
    const body = (params.input ?? {}) as Record<string, unknown>;
    const ref = decodeNodeId(String(body.repositoryId ?? ''));
    if (!ref || ref.type !== 'Repository') {
      run.problems.push({ message: 'createIssue: unknown repositoryId.' });
      return null;
    }
    const item = findRepo(run.db, ref.repoId);
    if (!item) {
      run.problems.push({ message: 'createIssue: unknown repositoryId.' });
      return null;
    }
    const made = createIssue(run.db, item, {
      title: String(body.title ?? ''),
      body: typeof body.body === 'string' ? body.body : '',
    });
    if ('error' in made) {
      run.problems.push({ message: `createIssue: ${made.error}.` });
      return null;
    }
    return runFields(run, { __typename: 'CreateIssuePayload', issue: issueObj(item, made) }, sel.selections);
  }

  if (field === 'closeIssue') {
    const body = (params.input ?? {}) as Record<string, unknown>;
    const ref = decodeNodeId(String(body.issueId ?? ''));
    if (!ref || ref.type !== 'Issue') {
      run.problems.push({ message: 'closeIssue: unknown issueId.' });

      return null;
    }
    const item = findRepo(run.db, ref.repoId);
    const entry = item?.issues.get(ref.number);
    if (!item || !entry) {
      run.problems.push({ message: 'closeIssue: unknown issueId.' });
      return null;
    }
    entry.state = 'closed';
    entry.closed_at = FIXED_TIME;
    entry.updated_at = FIXED_TIME;
    return runFields(run, { __typename: 'CloseIssuePayload', issue: issueObj(item, entry) }, sel.selections);
  }

  if (field === 'createPullRequest') {
    const body = (params.input ?? {}) as Record<string, unknown>;
    const ref = decodeNodeId(String(body.repositoryId ?? ''));
    if (!ref || ref.type !== 'Repository') {
      run.problems.push({ message: 'createPullRequest: unknown repositoryId.' });
      return null;
    }
    const item = findRepo(run.db, ref.repoId);
    if (!item) {
      run.problems.push({ message: 'createPullRequest: unknown repositoryId.' });
      return null;
    }
    const made = createPull(run.db, item, {
      title: String(body.title ?? ''),
      body: typeof body.body === 'string' ? body.body : '',
      head: String(body.headRefName ?? ''),
      base: String(body.baseRefName ?? ''),
    });
    if ('error' in made) {
      run.problems.push({ message: `createPullRequest: ${made.error}.` });
      return null;
    }
    return runFields(run, { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(item, made) }, sel.selections);
  }

  if (field === 'mergePullRequest') {
    const body = (params.input ?? {}) as Record<string, unknown>;
    const ref = decodeNodeId(String(body.pullRequestId ?? ''));
    if (!ref || ref.type !== 'PullRequest') {
      run.problems.push({ message: 'mergePullRequest: unknown pullRequestId.' });
      return null;
    }
    const item = findRepo(run.db, ref.repoId);
    const entry = item?.pulls.get(ref.number);
    if (!item || !entry) {
      run.problems.push({ message: 'mergePullRequest: unknown pullRequestId.' });
      return null;
    }
    const done = mergePull(item, entry);
    if ('error' in done) {
      run.problems.push({ message: `mergePullRequest: ${done.error}.` });
      return null;
    }
    return runFields(run, { __typename: 'MergePullRequestPayload', pullRequest: pullObj(item, entry) }, sel.selections);
  }

  if (field === 'addComment') {
    const form = (params.input ?? {}) as Record<string, unknown>;
    const ref = decodeNodeId(String(form.subjectId ?? ''));
    if (!ref || ref.type !== 'Issue') {
      run.problems.push({ message: 'addComment: unknown subjectId.' });
      return null;
    }
    const item = findRepo(run.db, ref.repoId);
    const entry = item?.issues.get(ref.number);
    if (!item || !entry) {
      run.problems.push({ message: 'addComment: unknown subjectId.' });
      return null;
    }
    const body = String(form.body ?? '');
    const note = { id: item.nextCommentId++, body, created_at: FIXED_TIME };
    entry.comments.push(note);
    const nodeObj: Record<string, unknown> = {
      __typename: 'IssueComment',
      __repo: item,
      id: commentGlobalId(item, entry.number, note.id),
      body: note.body,
      createdAt: note.created_at,
      author: userObj(item.owner),
    };
    const edgeObj: Record<string, unknown> = { __typename: 'IssueCommentEdge', node: nodeObj, cursor: makeCursor(note.id) };
    return runFields(run, { __typename: 'AddCommentPayload', commentEdge: edgeObj }, sel.selections);
  }

  run.problems.push({ message: `Cannot query field "${field}" on type "Query".` });
  return null;
}

/** Execute one parsed operation. Unknown root fields and unknown nested fields error. */
export function executeOperation(
  db: Store,
  viewer: string,
  op: Operation,
  vars: Record<string, unknown>,
): GraphQLResult {
  const run: RunState = { db, viewer, vars, problems: [] };
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind === 'fragment') {
      // A fragment at the root applies to Query/Mutation.
      const inner = runFields(run, { __typename: op.type === 'mutation' ? 'Mutation' : 'Query' }, sel.selections);
      if (inner !== null) Object.assign(data, inner);
      continue;
    }
    data[sel.alias] = runRootField(run, sel);
  }
  if (run.problems.length > 0) return { data: null, errors: run.problems };
  return { data, errors: [] };
}

/** Parse and execute a GraphQL document string. */
export function executeGraphQL(
  db: Store,
  viewer: string,
  doc: string,
  vars: Record<string, unknown>,
): GraphQLResult {
  let op: Operation;
  try {
    op = new Parser(doc).readOperation();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  return executeOperation(db, viewer, op, vars);
}
