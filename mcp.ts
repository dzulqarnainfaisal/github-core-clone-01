// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0), modern era
// (2026-07-28, server/discover) with the legacy initialize handshake as a fallback.
// The tools act on the same store as REST, so MCP and REST read the same objects.
//
// This is a rewrite of the first version. The wire behavior is identical — same tool
// list (byte for byte), same JSON-RPC shapes, same error codes and messages — only
// the internals are reorganised: the tool list is built by one small helper instead
// of nested literals, and the request dispatch is a flat chain of early returns.

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

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

type PropDef = { type: string; description: string };

/** Build one frozen tool definition; the shape is fixed so tools/list is stable. */
function defineTool(
  name: string,
  description: string,
  properties: Record<string, PropDef>,
  required: string[],
): ToolDef {
  const frozenProps: Record<string, PropDef> = {};
  for (const [key, prop] of Object.entries(properties)) frozenProps[key] = Object.freeze(prop);
  return Object.freeze({
    name,
    description,
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze(frozenProps),
      required: Object.freeze(required),
    }),
  });
}

/** The tool list, a fixed constant: two tools/list calls answer byte for byte. */
export const MCP_TOOLS: readonly ToolDef[] = Object.freeze([
  defineTool(
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
  defineTool(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    ['owner', 'repo'],
  ),
  defineTool(
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
  defineTool(
    'list_issues',
    'List the issues of a repository.',
    {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    ['owner', 'repo'],
  ),
  defineTool(
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
  defineTool(
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

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    description: repo.description,
    private: repo.private,
    default_branch: repo.defaultBranch,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: { number: number; title: string; body: string; state: string; id: number }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

function pullJson(repo: Repo, pull: { number: number; title: string; body: string; state: string; headRef: string; baseRef: string; merged: boolean; merge_commit_sha: string | null; id: number }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.merge_commit_sha,
    head: { ref: pull.headRef, sha: repo.refs.get(`refs/heads/${pull.headRef}`) ?? '' },
    base: { ref: pull.baseRef, sha: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? '' },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

interface ToolOutcome {
  result: Record<string, unknown> | null;
  error: { code: number; message: string } | null;
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Match a tool by name, forgiving case and separators (getRepo, get-repo, repo). */
function findTool(name: string): ToolDef | undefined {
  const wanted = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return MCP_TOOLS.find((tool) => {
    const candidate = tool.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return candidate === wanted || candidate.endsWith(wanted);
  });
}

function callTool(store: Store, viewerLogin: string, name: string, args: Record<string, unknown>): ToolOutcome {
  const tool = findTool(name);
  if (!tool) return { result: null, error: { code: -32602, message: `unknown tool ${name}` } };
  const required = tool.inputSchema.required;
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return { result: toolError(`missing required argument: ${key}`), error: null };
    }
  }
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : viewerLogin;
  const repoName = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';

  switch (tool.name) {
    case 'create_repo': {
      const repoNameArg = String(args.name ?? '');
      if (repoNameArg === '') return { result: toolError('missing required argument: name'), error: null };
      const existing = getRepo(store, viewerLogin, repoNameArg);
      if (existing) return { result: toolError(`repository ${viewerLogin}/${repoNameArg} already exists`), error: null };
      const repo = createRepo(store, viewerLogin, repoNameArg, {
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return { result: toolResult(repoJson(repo)), error: null };
    }
    case 'get_repo': {
      const repo = getRepo(store, owner, repoName);
      if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`), error: null };
      return { result: toolResult(repoJson(repo)), error: null };
    }
    case 'create_issue': {
      const repo = getRepo(store, owner, repoName);
      if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`), error: null };
      const created = createIssue(store, repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
      });
      if ('error' in created) return { result: toolError(`unknown label ${created.label}`), error: null };
      return { result: toolResult(issueJson(repo, created)), error: null };
    }
    case 'list_issues': {
      const repo = getRepo(store, owner, repoName);
      if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`), error: null };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return { result: toolResult(issues), error: null };
    }
    case 'create_pull_request': {
      const repo = getRepo(store, owner, repoName);
      if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`), error: null };
      const created = createPull(store, repo, {
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head ?? ''),
        base: String(args.base ?? ''),
      });
      if ('error' in created) return { result: toolError(`unknown branch ${created.branch}`), error: null };
      return { result: toolResult(pullJson(repo, created)), error: null };
    }
    case 'merge_pull_request': {
      const repo = getRepo(store, owner, repoName);
      if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`), error: null };
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) return { result: toolError(`pull request #${number} not found`), error: null };
      const merged = mergePull(repo, pull);
      if ('error' in merged) return { result: toolError(`cannot merge pull request #${number}: ${merged.error}`), error: null };
      return { result: toolResult({ ...pullJson(repo, pull), merged: true, sha: merged.mergeSha }), error: null };
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

function rpcResult(id: unknown, result: unknown): McpResponseBody {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponseBody {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'discover',
    supportedVersions: [MCP_REVISION, '2025-11-25'],
    capabilities: { tools: {} },
    instructions: 'A GitHub-compatible forge over MCP.',
    serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MCP_REVISION,
      'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    },
  };
}

function initializeResult(protocolVersion: string): Record<string, unknown> {
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
  };
}

/**
 * Handle one parsed JSON-RPC request object. Notifications (no id) get a 202 with no body.
 * `protocolVersion` is echoed in the MCP-Protocol-Version response header when the request
 * declared one.
 */
export function handleMcpRequest(
  store: Store,
  viewerLogin: string,
  request: McpRequest,
  protocolVersion: string | null,
): McpResponseBody {
  const headers: Record<string, string> = {};
  if (protocolVersion !== null) headers['mcp-protocol-version'] = protocolVersion;
  const id = request.id;
  const isNotification = id === undefined || id === null;
  const method = typeof request.method === 'string' ? request.method : '';

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null, headers };
  }

  if (method === 'server/discover') {
    const body = rpcResult(id, discoverResult());
    return { ...body, headers };
  }

  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISION;
    const negotiated = wanted === MCP_REVISION || wanted === '2025-11-25' ? wanted : MCP_REVISION;
    const body = rpcResult(id, initializeResult(negotiated));
    return { ...body, headers };
  }

  if (method === 'tools/list') {
    const body = rpcResult(id, { tools: MCP_TOOLS });
    return { ...body, headers };
  }

  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') {
      const body = rpcError(id, -32602, 'tools/call needs a tool name');
      return { ...body, headers };
    }
    const outcome = callTool(store, viewerLogin, name, args);
    if (outcome.error) {
      const body = rpcError(id, outcome.error.code, outcome.error.message);
      return { ...body, headers };
    }
    const body = rpcResult(id, outcome.result);
    return { ...body, headers };
  }

  if (method === 'ping') {
    const body = rpcResult(id, {});
    return { ...body, headers };
  }

  const body = rpcError(id, -32601, `method not found: ${method}`);
  return { ...body, headers };
}

/** A raw (unparseable) body is HTTP 400 with JSON-RPC -32700. */
export function mcpParseError(): McpResponseBody {
  return rpcError(null, -32700, 'Parse error', 400);
}
