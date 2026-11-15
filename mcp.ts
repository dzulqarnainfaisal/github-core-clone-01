// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0), current era
// (2026-07-28, server/discover) with the older initialize handshake kept as a fallback.
// The tools work on the same store as REST, so MCP and REST see the same objects.
//
// Second rewrite. The wire behavior is unchanged — same tool list (byte for byte),
// same JSON-RPC shapes, same error codes and messages — only the internals move:
// the tool list is assembled by one small builder, and dispatch is a flat chain
// of early returns.

import {
  FIXED_TIME,
  createIssue,
  createPull,
  createRepo,
  getRepo,
  mergePull,
  type Repo,
  type Store,
} from './store.ts';

export const MCP_REVISION = '2026-07-28';
export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

type FieldSpec = { type: string; description: string };

/** Assemble one frozen tool definition; the shape is fixed so tools/list is stable. */
function makeTool(
  toolName: string,
  blurb: string,
  fields: Record<string, FieldSpec>,
  mandatory: string[],
): ToolSpec {
  const sealedProps: Record<string, FieldSpec> = {};
  for (const [key, spec] of Object.entries(fields)) sealedProps[key] = Object.freeze(spec);
  return Object.freeze({
    name: toolName,
    description: blurb,
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze(sealedProps),
      required: Object.freeze(mandatory),
    }),
  });
}

/** The tool list, a fixed constant: two tools/list calls answer byte for byte. */
export const MCP_TOOLS: readonly ToolSpec[] = Object.freeze([
  makeTool(
    'create_repo',
    'Create a repository owned by the authenticated user.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    ['name'],
  ),
  makeTool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
  makeTool(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    ['owner', 'repo', 'title'],
  ),
  makeTool(
    'list_issues',
    'List the issues of a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    ['owner', 'repo'],
  ),
  makeTool(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  makeTool(
    'merge_pull_request',
    'Merge a pull request with a squash commit onto its base branch.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
]);

// --------------------------------------------------------------------------- tools

function repoView(item: Repo): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    full_name: `${item.owner}/${item.name}`,
    owner: { login: item.owner },
    description: item.description,
    private: item.private,
    default_branch: item.defaultBranch,
    created_at: item.created_at,
    updated_at: item.updated_at,
    html_url: `https://github.com/${item.owner}/${item.name}`,
  };
}

function issueView(item: Repo, entry: { number: number; title: string; body: string; state: string; id: number }): Record<string, unknown> {
  return {
    id: entry.id,
    number: entry.number,
    title: entry.title,
    body: entry.body,
    state: entry.state,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

function pullView(item: Repo, entry: { number: number; title: string; body: string; state: string; headRef: string; baseRef: string; merged: boolean; merge_commit_sha: string | null; id: number }): Record<string, unknown> {
  return {
    id: entry.id,
    number: entry.number,
    title: entry.title,
    body: entry.body,
    state: entry.state,
    merged: entry.merged,
    merge_commit_sha: entry.merge_commit_sha,
    head: { ref: entry.headRef, sha: item.refs.get(`refs/heads/${entry.headRef}`) ?? '' },
    base: { ref: entry.baseRef, sha: item.refs.get(`refs/heads/${entry.baseRef}`) ?? '' },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

interface CallOutcome {
  result: Record<string, unknown> | null;
  error: { code: number; message: string } | null;
}

function okPayload(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function errPayload(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Match a tool by name, forgiving case and separators (getRepo, get-repo, repo). */
function lookupTool(name: string): ToolSpec | undefined {
  const needle = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return MCP_TOOLS.find((spec) => {
    const eachName = spec.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return eachName === needle || eachName.endsWith(needle);
  });
}

function runTool(db: Store, viewer: string, name: string, inputs: Record<string, unknown>): CallOutcome {
  const spec = lookupTool(name);
  if (!spec) return { result: null, error: { code: -32602, message: `unknown tool ${name}` } };
  const mandatory = spec.inputSchema.required;
  for (const field of mandatory) {
    if (inputs[field] === undefined || inputs[field] === null || inputs[field] === '') {
      return { result: errPayload(`missing required argument: ${field}`), error: null };
    }
  }
  const holder = typeof inputs.owner === 'string' && inputs.owner !== '' ? inputs.owner : viewer;
  const repoSlug = typeof inputs.repo === 'string' ? inputs.repo : typeof inputs.name === 'string' ? inputs.name : '';

  switch (spec.name) {
    case 'create_repo': {
      const targetName = String(inputs.name ?? '');
      if (targetName === '') return { result: errPayload('missing required argument: name'), error: null };
      const clash = getRepo(db, viewer, targetName);
      if (clash) return { result: errPayload(`repository ${viewer}/${targetName} already exists`), error: null };
      const made = createRepo(db, viewer, targetName, {
        description: typeof inputs.description === 'string' ? inputs.description : '',
        private: inputs.private === true,
      });
      return { result: okPayload(repoView(made)), error: null };
    }
    case 'get_repo': {
      const item = getRepo(db, holder, repoSlug);
      if (!item) return { result: errPayload(`repository ${holder}/${repoSlug} not found`), error: null };
      return { result: okPayload(repoView(item)), error: null };
    }
    case 'create_issue': {
      const item = getRepo(db, holder, repoSlug);
      if (!item) return { result: errPayload(`repository ${holder}/${repoSlug} not found`), error: null };
      const made = createIssue(db, item, {
        title: String(inputs.title ?? ''),
        body: typeof inputs.body === 'string' ? inputs.body : '',
      });
      if ('error' in made) return { result: errPayload(`unknown label ${made.label}`), error: null };
      return { result: okPayload(issueView(item, made)), error: null };
    }
    case 'list_issues': {
      const item = getRepo(db, holder, repoSlug);
      if (!item) return { result: errPayload(`repository ${holder}/${repoSlug} not found`), error: null };
      const filter = typeof inputs.state === 'string' ? inputs.state.toLowerCase() : 'open';
      const found = [...item.issues.values()]
        .filter((entry) => filter === 'all' || entry.state === filter)
        .sort((a, b) => a.number - b.number)
        .map((entry) => issueView(item, entry));
      return { result: okPayload(found), error: null };
    }
    case 'create_pull_request': {
      const item = getRepo(db, holder, repoSlug);
      if (!item) return { result: errPayload(`repository ${holder}/${repoSlug} not found`), error: null };
      const made = createPull(db, item, {
        title: String(inputs.title ?? ''),
        body: typeof inputs.body === 'string' ? inputs.body : '',
        head: String(inputs.head ?? ''),
        base: String(inputs.base ?? ''),
      });
      if ('error' in made) return { result: errPayload(`unknown branch ${made.branch}`), error: null };
      return { result: okPayload(pullView(item, made)), error: null };
    }
    case 'merge_pull_request': {
      const item = getRepo(db, holder, repoSlug);
      if (!item) return { result: errPayload(`repository ${holder}/${repoSlug} not found`), error: null };
      const num = Number(inputs.pull_number);
      const entry = item.pulls.get(num);
      if (!entry) return { result: errPayload(`pull request #${num} not found`), error: null };
      const done = mergePull(item, entry);
      if ('error' in done) return { result: errPayload(`cannot merge pull request #${num}: ${done.error}`), error: null };
      return { result: okPayload({ ...pullView(item, entry), merged: true, sha: done.mergeSha }), error: null };
    }
    default:
      return { result: null, error: { code: -32602, message: `unknown tool ${name}` } };
  }
}

// --------------------------------------------------------------------------- JSON-RPC

export interface McpRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpResponseBody {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function okReply(msgId: unknown, result: unknown): McpResponseBody {
  return { status: 200, body: { jsonrpc: '2.0', id: msgId ?? null, result } };
}

function errReply(msgId: unknown, code: number, message: string, status = 200): McpResponseBody {
  return { status, body: { jsonrpc: '2.0', id: msgId ?? null, error: { code, message } } };
}

function discoverBody(): Record<string, unknown> {
  const versions = [MCP_REVISION, '2025-11-25'];
  const server = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
  return {
    resultType: 'discover',
    supportedVersions: versions,
    capabilities: { tools: {} },
    instructions: 'A GitHub-compatible forge over MCP.',
    serverInfo: server,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MCP_REVISION,
      'io.modelcontextprotocol/serverInfo': server,
    },
  };
}

function initializeBody(protocolVersion: string): Record<string, unknown> {
  const server = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: server,
  };
}

/**
 * Handle one parsed JSON-RPC request object. Notifications (no id) get a 202 with no body.
 * `protocolVersion` is echoed in the MCP-Protocol-Version response header when the request
 * declared one.
 */
export function handleMcpRequest(
  db: Store,
  viewer: string,
  msg: McpRequest,
  proto: string | null,
): McpResponseBody {
  const outHeaders: Record<string, string> = {};
  if (proto !== null) outHeaders['mcp-protocol-version'] = proto;
  const msgId = msg.id;
  const notifyOnly = msgId === undefined || msgId === null;
  const verb = typeof msg.method === 'string' ? msg.method : '';

  if (verb === 'notifications/initialized' || verb.startsWith('notifications/')) {
    return { status: 202, body: null, headers: outHeaders };
  }

  if (verb === 'server/discover') {
    const reply = okReply(msgId, discoverBody());
    return { ...reply, headers: outHeaders };
  }

  if (verb === 'initialize') {
    const args = (msg.params ?? {}) as Record<string, unknown>;
    const asked = typeof args.protocolVersion === 'string' ? args.protocolVersion : MCP_REVISION;
    const settled = asked === MCP_REVISION || asked === '2025-11-25' ? asked : MCP_REVISION;
    const reply = okReply(msgId, initializeBody(settled));
    return { ...reply, headers: outHeaders };
  }

  if (verb === 'tools/list') {
    const reply = okReply(msgId, { tools: MCP_TOOLS });
    return { ...reply, headers: outHeaders };
  }

  if (verb === 'tools/call') {
    const args = (msg.params ?? {}) as Record<string, unknown>;
    const toolName = typeof args.name === 'string' ? args.name : '';
    const inputs = (args.arguments ?? {}) as Record<string, unknown>;
    if (toolName === '') {
      const reply = errReply(msgId, -32602, 'tools/call needs a tool name');
      return { ...reply, headers: outHeaders };
    }
    const done = runTool(db, viewer, toolName, inputs);
    if (done.error) {
      const reply = errReply(msgId, done.error.code, done.error.message);
      return { ...reply, headers: outHeaders };
    }
    const reply = okReply(msgId, done.result);
    return { ...reply, headers: outHeaders };
  }

  if (verb === 'ping') {
    const reply = okReply(msgId, {});
    return { ...reply, headers: outHeaders };
  }

  const reply = errReply(msgId, -32601, `method not found: ${verb}`);
  return { ...reply, headers: outHeaders };
}

/** A raw (unparseable) body is HTTP 400 with JSON-RPC -32700. */
export function mcpParseError(): McpResponseBody {
  return errReply(null, -32700, 'Parse error', 400);
}
