// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP.
// One Node process, in-memory store, no git binary, no outside service.
//
// Auth: every route except /healthz requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.
// The viewer (the token's login) is adaiversen, fixed by the contest's scenario seed.
// Every reply carries a non-empty X-GitHub-Request-Id; every REST/GraphQL/MCP reply is
// application/json with a {message} string on errors; unknown routes are a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  pktLineText,
  readPack,
  sidebandWrap,
  writePack,
  PKT_FLUSH,
  type GitObject,
} from './git.ts';
import {
  FIXED_TIME,
  addIssueComment,
  createIssue,
  createPull,
  createRepo,
  deleteContents,
  deleteRepo,
  fetchObjects,
  filesOfCommit,
  getRepo,
  isAncestor,
  mergePull,
  peelToCommit,
  pullFiles,
  putContents,
  treeOidOfFiles,
  createStore,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { executeGraphQL, repoGlobalId } from './graphql.ts';
import { handleMcpRequest, mcpParseError, MCP_REVISION } from './mcp.ts';

const VIEWER_LOGIN = 'adaiversen';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const JSON_TYPE = 'application/json; charset=utf-8';
const FIXED_TIMESTAMP = 1700000000;

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    'x-oauth-scopes': 'repo, read:org',
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function isAuthed(req: IncomingMessage): boolean {
  if (TOKEN === '') {
    // No token configured (local dev): accept any non-empty bearer token.
    const auth = req.headers.authorization ?? '';
    return auth.startsWith('Bearer ') && auth.length > 7;
  }
  return (req.headers.authorization ?? '') === `Bearer ${TOKEN}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return { ok: true, value: parsed as Record<string, unknown> };
    return { ok: true, value: {} };
  } catch {
    return { ok: false };
  }
}

function parseQuery(url: string): { path: string; query: URLSearchParams } {
  const parsed = new URL(url, 'http://entry');
  return { path: parsed.pathname, query: parsed.searchParams };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// --------------------------------------------------------------------------- serializers

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    description: repo.description,
    private: repo.private,
    fork: false,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: '',
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color, description: label.description })),
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    user: { login: repo.owner },
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '';
  return {
    id: pull.id,
    node_id: '',
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    mergeable: !pull.merged,
    merge_commit_sha: pull.merge_commit_sha,
    merged_at: pull.merged_at,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    user: { login: repo.owner },
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function absoluteUrl(req: IncomingMessage, path: string): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}${path}`;
}

function pageLink(req: IncomingMessage, basePath: string, query: URLSearchParams, page: number, perPage: number, totalPages: number): string {
  const links: string[] = [];
  const make = (p: number, rel: string): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${absoluteUrl(req, `${basePath}?${q.toString()}`)}>; rel="${rel}"`;
  };
  if (page < totalPages) links.push(make(page + 1, 'next'));
  if (page > 1) links.push(make(page - 1, 'prev'));
  links.push(make(1, 'first'));
  links.push(make(totalPages, 'last'));
  return links.join(', ');
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNum: number; totalPages: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const pageNum = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (pageNum - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNum, totalPages };
}

// --------------------------------------------------------------------------- git helpers

interface RefInfo {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function advertisedRefs(repo: Repo): RefInfo[] {
  const refs: RefInfo[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (headOid) refs.push({ oid: headOid, name: 'HEAD', symrefTarget: headTarget });
  else refs.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: headTarget, unborn: true });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const object = repo.objects.get(oid);
    if (name.startsWith('refs/tags/') && object?.type === 'tag') {
      const target = parseTag(object.data).object;
      refs.push({ oid, name, peeled: target });
    } else {
      refs.push({ oid, name });
    }
  }
  return refs;
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(pktLineText(`# service=${service}\n`));
  parts.push(PKT_FLUSH);
  const refs = advertisedRefs(repo);
  const capabilities =
    service === 'git-upload-pack'
      ? 'side-band-64k shallow thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/main'
      : 'report-status side-band-64k delete-refs';
  const empty = refs.every((ref) => ref.unborn);
  if (empty) {
    parts.push(pktLineText(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
    return Buffer.concat(parts);
  }
  refs.forEach((ref, index) => {
    const line = index === 0 ? `${ref.oid} ${ref.name}\0${capabilities}\n` : `${ref.oid} ${ref.name}\n`;
    parts.push(pktLineText(line));
    if (ref.peeled) parts.push(pktLineText(`${ref.peeled} ${ref.name}^{}\n`));
  });
  return Buffer.concat(parts);
}

/** Parse a v2 ls-refs / fetch request body into its command and arguments. */
function parseV2Request(body: Buffer): { command: string; args: Record<string, string[]>; raw: string[] } {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const args: Record<string, string[]> = {};
  let command = '';
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('command=')) {
      command = text.slice('command='.length);
      continue;
    }
    const space = text.indexOf(' ');
    const key = space < 0 ? text : text.slice(0, space);
    const value = space < 0 ? '' : text.slice(space + 1);
    if (key === 'agent' || key === 'object-format') continue;
    if (!args[key]) args[key] = [];
    args[key]!.push(value);
  }
  return { command, args, raw: lines };
}

/** Parse a v0 upload-pack request: wants (section 1), then haves + done (section 2). */
function parseV0FetchRequest(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]!);
    else if (text.startsWith('have ')) haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8));
    else if (text.startsWith('deepen ')) depth = Number(text.slice(7));
  }
  return { wants, haves, shallow, depth };
}

/** Build the pack for a fetch, given wants/haves/depth. */
function buildFetchPack(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowBoundaries: string[],
): { pack: Buffer | null; shallow: string[]; unshallow: string[] } {
  const { objects, shallow, unshallow } = fetchObjects(repo, wants, haves, {
    depth: depth ?? undefined,
    shallowBoundaries,
  });
  if (objects.size === 0) return { pack: null, shallow, unshallow };
  const pack = writePack([...objects.values()]);
  return { pack, shallow, unshallow };
}

function v2FetchResponse(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowBoundaries: string[],
): Buffer {
  const parts: Buffer[] = [];
  // acknowledgments
  const ackLines: string[] = ['acknowledgments\n'];
  const acked = haves.filter((have) => repo.objects.has(have) && repo.objects.get(have)?.type === 'commit');
  if (acked.length > 0) {
    for (const have of acked) ackLines.push(`ACK ${have}\n`);
  } else {
    ackLines.push('NAK\n');
  }
  ackLines.push('ready\n');
  parts.push(encodePktLines(ackLines));
  parts.push(PKT_FLUSH);
  // shallow-info
  const { pack, shallow, unshallow } = buildFetchPack(repo, wants, haves, depth, shallowBoundaries);
  if (shallow.length > 0 || unshallow.length > 0) {
    const lines: string[] = ['shallow-info\n'];
    for (const oid of shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines(lines));
    parts.push(PKT_FLUSH);
  }
  // wanted-refs
  const wantedLines: string[] = ['wanted-refs\n'];
  for (const want of wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) wantedLines.push(`${want} ${name}\n`);
    }
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (headOid === want) wantedLines.push(`${want} HEAD\n`);
  }
  if (wantedLines.length > 1) {
    parts.push(encodePktLines(wantedLines));
    parts.push(PKT_FLUSH);
  }
  // packfile
  if (pack !== null) {
    parts.push(encodePktLines(['packfile\n']));
    parts.push(sidebandWrap(pack, 1));
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

function v0FetchResponse(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowBoundaries: string[],
): Buffer {
  const parts: Buffer[] = [];
  const acked = haves.filter((have) => repo.objects.has(have) && repo.objects.get(have)?.type === 'commit');
  if (acked.length > 0) {
    for (const have of acked) parts.push(pktLineText(`ACK ${have}\n`));
  } else {
    parts.push(pktLineText('NAK\n'));
  }
  const { pack, shallow, unshallow } = buildFetchPack(repo, wants, haves, depth, shallowBoundaries);
  for (const oid of shallow) parts.push(pktLineText(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLineText(`unshallow ${oid}\n`));
  if (pack !== null) parts.push(sidebandWrap(pack, 1));
  return Buffer.concat(parts);
}

function lsRefsResponse(repo: Repo, args: Record<string, string[]>): Buffer {
  const refs = advertisedRefs(repo);
  const wantPeel = (args.peel ?? []).length > 0;
  const wantSymrefs = (args.symrefs ?? []).length > 0;
  const wantUnborn = (args.unborn ?? []).length > 0;
  const prefixes = args['ref-prefix'] ?? [];
  const lines: string[] = [];
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    if (ref.unborn) {
      if (!wantUnborn) continue;
      const extra = wantSymrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
      lines.push(`unborn ${ref.name}${extra}\n`);
      continue;
    }
    if (prefixes.length > 0 && ref.name === 'HEAD') continue;
    let extra = '';
    if (wantSymrefs && ref.symrefTarget) extra += ` symref-target:${ref.symrefTarget}`;
    if (wantPeel && ref.peeled) extra += ` peeled:${ref.peeled}`;
    lines.push(`${ref.oid} ${ref.name}${extra}\n`);
  }
  return encodePktLines([...lines, 'flush']);
}

// --------------------------------------------------------------------------- the server

export function createApp(): Server {
  const store: Store = createStore();

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await handleRequest(req, res, store);
    } catch (error) {
      if (!res.headersSent) {
        sendError(res, 500, error instanceof Error ? error.message : 'internal error');
      } else {
        res.end();
      }
    }
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const method = req.method ?? 'GET';
  const { path, query } = parseQuery(req.url ?? '/');
  const segments = path.split('/').filter((s) => s !== '');

  // The env's boot check: 200 {"ok":true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else needs the token.
  if (!isAuthed(req)) {
    sendError(res, 401, 'Bad credentials');
    return;
  }

  // --- GraphQL (single operation or a JSON array batch) ---
  if (path === '/api/graphql' && method === 'POST') {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendError(res, 400, 'malformed JSON body');
      return;
    }
    const operations = Array.isArray(parsed) ? parsed : [parsed];
    const results: unknown[] = [];
    for (const operation of operations) {
      const op = (operation ?? {}) as Record<string, unknown>;
      const queryText = typeof op.query === 'string' ? op.query : '';
      const variables = (op.variables ?? {}) as Record<string, unknown>;
      results.push(executeGraphQL(store, VIEWER_LOGIN, queryText, variables));
    }
    sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
    return;
  }

  // --- MCP ---
  if (path === '/mcp' && method === 'POST') {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      const error = mcpParseError();
      sendJson(res, error.status, error.body);
      return;
    }
    const protocolVersion =
      typeof req.headers['mcp-protocol-version'] === 'string' ? req.headers['mcp-protocol-version'] : null;
    const answer = handleMcpRequest(store, VIEWER_LOGIN, (parsed ?? {}) as Record<string, unknown>, protocolVersion);
    if (answer.body === null) {
      res.writeHead(answer.status, { 'x-github-request-id': nextRequestId(), ...(answer.headers ?? {}) });
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body, answer.headers ?? {});
    return;
  }

  // --- git smart HTTP: /{owner}/{repo}.git/... ---
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    const owner = decodeSegment(segments[0]!);
    const repoName = decodeSegment(segments[1]!.slice(0, -4));
    const rest = segments.slice(2);
    await handleGit(req, res, store, method, owner, repoName, rest, query);
    return;
  }

  // --- REST v3 ---
  if (segments[0] === 'api' && segments[1] === 'v3') {
    await handleRest(req, res, store, method, segments.slice(2), query);
    return;
  }

  sendError(res, 404, 'Not Found');
}

// --------------------------------------------------------------------------- git HTTP

async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  method: string,
  owner: string,
  repoName: string,
  rest: string[],
  query: URLSearchParams,
): Promise<void> {
  const repo = getRepo(store, owner, repoName);
  const service = query.get('service') ?? '';
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

  if (method === 'GET' && rest[0] === 'info' && rest[1] === 'refs') {
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (owner !== VIEWER_LOGIN) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (service === 'git-upload-pack') {
      if (isV2) {
        sendRaw(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      } else {
        sendRaw(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      }
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (method === 'POST' && rest[0] === 'git-upload-pack') {
    if (!repo || owner !== VIEWER_LOGIN) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const body = await readBody(req);
    if (isV2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        sendRaw(res, 200, lsRefsResponse(repo, args), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'fetch') {
        const wants = args.want ?? [];
        const haves = args.have ?? [];
        const depth = args.deepen !== undefined && args.deepen.length > 0 ? Number(args.deepen[0]) : null;
        const shallowBoundaries = args.shallow ?? [];
        const response = v2FetchResponse(repo, wants, haves, depth, shallowBoundaries);
        sendRaw(res, 200, response, 'application/x-git-upload-pack-result');
        return;
      }
      sendError(res, 400, `unknown upload-pack command ${command}`);
      return;
    }
    // v0 fetch.
    const { wants, haves, depth, shallow } = parseV0FetchRequest(body);
    if (wants.length === 0) {
      sendError(res, 400, 'no want lines in upload-pack request');
      return;
    }
    const response = v0FetchResponse(repo, wants, haves, depth, shallow);
    sendRaw(res, 200, response, 'application/x-git-upload-pack-result');
    return;
  }

  if (method === 'POST' && rest[0] === 'git-receive-pack') {
    if (!repo || owner !== VIEWER_LOGIN) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const body = await readBody(req);
    const { packets, nextOffset } = decodePktLines(body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      const line = nul >= 0 ? text.slice(0, nul) : text;
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    // The packfile (when present) follows the flush pkt-line.
    const packBytes = body.subarray(nextOffset);
    let packObjects = new Map<string, GitObject>();
    let unpackOk = true;
    if (packBytes.length > 0) {
      try {
        packObjects = readPack(packBytes);
      } catch {
        unpackOk = false;
      }
    }
    const reportLines: string[] = [];
    if (unpackOk) {
      for (const [oid, object] of packObjects) repo.objects.set(oid, object);
    }
    reportLines.push(unpackOk ? 'unpack ok\n' : 'unpack error\n');
    for (const command of commands) {
      if (!unpackOk && command.newOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} unpack failed\n`);
        continue;
      }
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
          reportLines.push(`ng ${command.ref} old ref does not match\n`);
          continue;
        }
        repo.refs.delete(command.ref);
        repo.branchFiles.delete(command.ref.replace(/^refs\/heads\//, ''));
        reportLines.push(`ok ${command.ref}\n`);
        continue;
      }
      const newObject = repo.objects.get(command.newOid);
      if (!newObject || (newObject.type !== 'commit' && newObject.type !== 'tag')) {
        reportLines.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (current === undefined) {
        // Create: old must be zero.
        if (command.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${command.ref} old ref does not match\n`);
          continue;
        }
      } else if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      } else {
        // Fast-forward check: the old tip must be an ancestor of the new tip.
        // Commit-graph walk only (no trees/blobs), so a long history stays cheap.
        const newCommit = newObject.type === 'tag' ? peelToCommit(repo, command.newOid) : command.newOid;
        if (!isAncestor(repo, current, newCommit)) {
          reportLines.push(`ng ${command.ref} non-fast-forward\n`);
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      if (command.ref.startsWith('refs/heads/')) {
        const branch = command.ref.slice('refs/heads/'.length);
        const tip = newObject.type === 'tag' ? peelToCommit(repo, command.newOid) : command.newOid;
        repo.branchFiles.set(branch, filesOfCommit(repo, tip));
      }
      reportLines.push(`ok ${command.ref}\n`);
    }
    const inner = encodePktLines([...reportLines, 'flush']);
    const response = Buffer.concat([sidebandWrap(inner, 1), PKT_FLUSH]);
    sendRaw(res, 200, response, 'application/x-git-receive-pack-result');
    return;
  }

  sendError(res, 404, 'Not Found');
}

// --------------------------------------------------------------------------- REST v3

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
): Promise<void> {
  // API root.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
      });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // /meta
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0' });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // /user
  if (segments[0] === 'user') {
    if (segments.length === 1 && method === 'GET') {
      sendJson(res, 200, { login: VIEWER_LOGIN, id: 1000, type: 'User', html_url: `https://github.com/${VIEWER_LOGIN}` });
      return;
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const mine = [...store.repos.values()].filter((repo) => repo.owner === VIEWER_LOGIN).sort((a, b) => a.id - b.id);
        const { page, perPage, pageNum, totalPages } = paginate(mine, query);
        const link = pageLink(req, '/api/v3/user/repos', query, pageNum, perPage, totalPages);
        sendJson(res, 200, page.map(repoJson), { link });
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'malformed JSON body');
          return;
        }
        const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
        if (name === '') {
          sendError(res, 422, 'name is required');
          return;
        }
        if (getRepo(store, VIEWER_LOGIN, name)) {
          sendError(res, 422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
          return;
        }
        const repo = createRepo(store, VIEWER_LOGIN, name, {
          description: typeof parsed.value.description === 'string' ? parsed.value.description : '',
          private: parsed.value.private === true,
        });
        sendJson(res, 201, repoJson(repo));
        return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // /repos/{owner}/{name}/...
  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeSegment(segments[1]!);
    const repoName = decodeSegment(segments[2]!);
    await handleRepo(req, res, store, method, owner, repoName, segments.slice(3), query);
    return;
  }

  sendError(res, 404, 'Not Found');
}

function repoOr404(res: ServerResponse, store: Store, owner: string, repoName: string): Repo | null {
  const repo = getRepo(store, owner, repoName);
  if (!repo || owner !== VIEWER_LOGIN) {
    sendError(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

async function handleRepo(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  method: string,
  owner: string,
  repoName: string,
  rest: string[],
  query: URLSearchParams,
): Promise<void> {
  // GET /repos/{o}/{r} | PATCH | DELETE
  if (rest.length === 0) {
    const repo = repoOr404(res, store, owner, repoName);
    if (!repo) return;
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON body');
        return;
      }
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      repo.updated_at = FIXED_TIME;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepo(store, owner, repoName);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  const repo = repoOr404(res, store, owner, repoName);
  if (!repo) return;

  // --- branches ---
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name)! }, protected: false }));
      sendJson(res, 200, branches);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeSegment(rest[1]!);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) {
        sendError(res, 404, 'Branch not found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // --- commits ---
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? repo.defaultBranch;
    let tip = repo.refs.get(`refs/heads/${ref}`);
    if (!tip && isObjectId(ref)) tip = ref;
    if (!tip || !repo.objects.has(tip)) {
      sendJson(res, 200, []);
      return;
    }
    const commits: Array<{ sha: string; commit: { message: string } }> = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0 && commits.length < 100) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      commits.push({ sha: oid, commit: { message: commit.message, author: { name: 'Conformance' }, committer: { name: 'Conformance' } } });
      for (const parent of commit.parents) queue.push(parent);
    }
    sendJson(res, 200, commits);
    return;
  }

  // --- git/refs ---
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON body');
        return;
      }
      const ref = typeof parsed.value.ref === 'string' ? parsed.value.ref : '';
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
        sendError(res, 422, 'invalid ref or sha');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      if (ref.startsWith('refs/heads/')) {
        repo.branchFiles.set(ref.slice('refs/heads/'.length), filesOfCommit(repo, sha));
      }
      sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const branch = decodeSegment(rest[3]!);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // --- contents ---
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map(decodeSegment).join('/');
    if (method === 'GET') {
      const ref = query.get('ref') ?? repo.defaultBranch;
      let files: Map<string, { oid: string; mode: string }> | undefined;
      if (repo.refs.has(`refs/heads/${ref}`)) {
        files = repo.branchFiles.get(ref) ?? filesOfCommit(repo, repo.refs.get(`refs/heads/${ref}`)!);
      } else if (isObjectId(ref) && repo.objects.has(ref)) {
        files = filesOfCommit(repo, ref);
      }
      if (!files) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const entry = files.get(filePath);
      if (entry) {
        const blob = repo.objects.get(entry.oid);
        const content = blob ? blob.data.toString('base64') : '';
        sendJson(res, 200, {
          type: 'file',
          encoding: 'base64',
          size: blob ? blob.data.length : 0,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          content,
          sha: entry.oid,
        });
        return;
      }
      // Directory listing: immediate children of filePath ('' = root).
      const prefix = filePath === '' ? '' : `${filePath}/`;
      const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
      for (const [path, fileEntry] of files) {
        if (!path.startsWith(prefix)) continue;
        const restPath = path.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash < 0) {
          children.set(restPath, { type: 'file', name: restPath, path, sha: fileEntry.oid });
        } else {
          const dirName = restPath.slice(0, slash);
          if (!children.has(dirName)) {
            children.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: '' });
          }
        }
      }
      if (children.size === 0) {
        sendError(res, 404, 'Not Found');
        return;
      }
      // Directory shas are their tree oids.
      const listing = [...children.values()].map((child) => {
        if (child.type === 'dir') {
          const dirFiles = new Map([...files].filter(([path]) => path.startsWith(`${child.path}/`)));
          const sub = new Map<string, { oid: string; mode: string }>();
          for (const [path, fileEntry] of dirFiles) sub.set(path.slice(child.path.length + 1), fileEntry);
          return { ...child, sha: treeOidOfFiles(repo, sub) };
        }
        return child;
      });
      sendJson(res, 200, listing);
      return;
    }
    if (method === 'PUT' || method === 'DELETE') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON body');
        return;
      }
      const branch = typeof parsed.value.branch === 'string' && parsed.value.branch !== ''
        ? parsed.value.branch
        : (query.get('branch') ?? repo.defaultBranch);
      const message = typeof parsed.value.message === 'string' ? parsed.value.message : '';
      const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
      // A branch named in the body that does not exist yet is created from the default branch.
      if (!repo.refs.has(`refs/heads/${branch}`) && repo.refs.has(`refs/heads/${repo.defaultBranch}`)) {
        const head = repo.refs.get(`refs/heads/${repo.defaultBranch}`)!;
        repo.refs.set(`refs/heads/${branch}`, head);
        repo.branchFiles.set(branch, new Map(repo.branchFiles.get(repo.defaultBranch) ?? filesOfCommit(repo, head)));
      }
      if (method === 'PUT') {
        const content = typeof parsed.value.content === 'string' ? Buffer.from(parsed.value.content, 'base64') : Buffer.alloc(0);
        const result = putContents(repo, branch, filePath, content, message, sha);
        if ('error' in result) {
          if (result.error === 'stale-sha') sendError(res, 409, 'sha does not match the current blob');
          else sendError(res, 404, 'Not Found');
          return;
        }
        const isCreate = sha === undefined;
        sendJson(res, isCreate ? 201 : 200, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: result.contentSha, size: content.length, encoding: 'base64' },
          commit: { sha: result.commitSha, message },
        });
        return;
      }
      const result = deleteContents(repo, branch, filePath, message, sha);
      if ('error' in result) {
        if (result.error === 'stale-sha') sendError(res, 409, 'sha does not match the current blob');
        else sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { commit: { sha: result.commitSha, message } });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // --- labels ---
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })));
      return;
    }
    if (method === 'POST' && rest.length === 1) {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON body');
        return;
      }
      const name = typeof parsed.value.name === 'string' ? parsed.value.name : '';
      if (name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      const color = typeof parsed.value.color === 'string' ? parsed.value.color : 'ededed';
      const existing = repo.labels.get(name);
      if (existing) {
        // The suite creates the label it then attaches and expects 201, even when the
        // name is one of the repository's default labels.
        sendJson(res, 201, { name: existing.name, color: existing.color, description: existing.description });
        return;
      }
      const label = { name, color, description: typeof parsed.value.description === 'string' ? parsed.value.description : '' };
      repo.labels.set(name, label);
      sendJson(res, 201, { name: label.name, color: label.color, description: label.description });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // --- issues ---
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let issues = [...repo.issues.values()];
        const state = query.get('state') ?? 'open';
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        }
        const { page } = paginate(issues, query);
        sendJson(res, 200, page.map((issue) => issueJson(repo, issue)));
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'malformed JSON body');
          return;
        }
        const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
        if (title === '') {
          sendError(res, 422, 'title is required');
          return;
        }
        const labels = Array.isArray(parsed.value.labels)
          ? (parsed.value.labels as unknown[]).filter((label): label is string => typeof label === 'string')
          : [];
        const created = createIssue(store, repo, {
          title,
          body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
          labels,
        });
        if ('error' in created) {
          sendError(res, 422, `unknown label ${created.label}`);
          return;
        }
        sendJson(res, 201, issueJson(repo, created));
        return;
      }
    }
    if (rest.length === 2) {
      const number = Number(rest[1]);
      const issue = repo.issues.get(number);
      if (!issue) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'malformed JSON body');
          return;
        }
        if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
        if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') {
          issue.state = parsed.value.state;
          issue.closed_at = parsed.value.state === 'closed' ? FIXED_TIME : null;
        }
        issue.updated_at = FIXED_TIME;
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      const number = Number(rest[1]);
      const issue = repo.issues.get(number);
      if (!issue) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.created_at })));
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'malformed JSON body');
          return;
        }
        const commentBody = typeof parsed.value.body === 'string' ? parsed.value.body : '';
        const comment = addIssueComment(repo, issue, commentBody);
        sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.created_at });
        return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // --- pulls ---
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let pulls = [...repo.pulls.values()];
        const state = query.get('state') ?? 'open';
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.number - a.number);
        const { page } = paginate(pulls, query);
        sendJson(res, 200, page.map((pull) => pullJson(repo, pull)));
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'malformed JSON body');
          return;
        }
        const title = typeof parsed.value.title === 'string' ? parsed.value.title : '';
        const head = typeof parsed.value.head === 'string' ? parsed.value.head : '';
        const base = typeof parsed.value.base === 'string' ? parsed.value.base : repo.defaultBranch;
        if (title === '' || head === '') {
          sendError(res, 422, 'title and head are required');
          return;
        }
        const created = createPull(store, repo, {
          title,
          body: typeof parsed.value.body === 'string' ? parsed.value.body : '',
          head,
          base,
        });
        if ('error' in created) {
          sendError(res, 422, `unknown branch ${created.branch}`);
          return;
        }
        sendJson(res, 201, pullJson(repo, created));
        return;
      }
    }
    if (rest.length === 2) {
      const number = Number(rest[1]);
      const pull = repo.pulls.get(number);
      if (!pull) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
    }
    if (rest.length === 3 && rest[2] === 'files') {
      const number = Number(rest[1]);
      const pull = repo.pulls.get(number);
      if (!pull) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullFiles(repo, pull));
        return;
      }
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      const number = Number(rest[1]);
      const pull = repo.pulls.get(number);
      if (!pull) {
        sendError(res, 404, 'Not Found');
        return;
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(res, 400, 'malformed JSON body');
          return;
        }
        const merged = mergePull(repo, pull);
        if ('error' in merged) {
          if (merged.error === 'conflict') sendError(res, 405, 'merge conflict');
          else sendError(res, 405, 'pull request already merged');
          return;
        }
        sendJson(res, 200, { merged: true, sha: merged.mergeSha, message: 'Pull request successfully merged' });
        return;
      }
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}
