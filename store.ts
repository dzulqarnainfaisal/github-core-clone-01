// store.ts — the forge's in-memory data model: repositories, their git object stores and
// refs, branch file state, issues, pull requests, comments and labels.
//
// Determinism: ids and numbers come from counters; every timestamp is the fixed constant.
// Nothing here reads the clock or randomness, so two runs over the same requests answer
// the same bytes.

import {
  ZERO_OID,
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
} from './git.ts';

/** Fixed timestamp for every created_at / updated_at / merged_at / closed_at. */
export const FIXED_TIME = '2026-11-14T00:00:00Z';
export const FIXED_TIMESTAMP = 1700000000;

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  created_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileEntry {
  oid: string;
  mode: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  created_at: string;
  updated_at: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  branchFiles: Map<string, Map<string, FileEntry>>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  nextCommentId: number;
}

export interface Store {
  repos: Map<string, Repo>; // key: `${owner}/${name}`
  nextRepoId: number;
  nextIssueId: number;
  nextPullId: number;
}

export function createStore(): Store {
  return { repos: new Map(), nextRepoId: 1, nextIssueId: 1, nextPullId: 1 };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

// --------------------------------------------------------------------------- git state

/** The flat file map of a commit's tree, by walking tree objects recursively. */
export function filesOfCommit(repo: Repo, commitOid: string): Map<string, FileEntry> {
  const acc = new Map<string, FileEntry>();
  const found = repo.objects.get(commitOid);
  if (!found || found.type !== 'commit') return acc;
  const topTree = parseCommit(found.data).tree;
  const descend = (nodeOid: string, prefix: string): void => {
    const nodeObj = repo.objects.get(nodeOid);
    if (!nodeObj || nodeObj.type !== 'tree') return;
    for (const child of parseTree(nodeObj.data)) {
      const full = prefix === '' ? child.name : `${prefix}/${child.name}`;
      if (child.mode === '40000') descend(child.oid, full);
      else acc.set(full, { oid: child.oid, mode: child.mode });
    }
  };
  descend(topTree, '');
  return acc;
}

/**
 * Build (and store) the nested tree objects for a flat file map. Returns the root tree oid.
 * Directories are created for every path prefix that holds a file.
 */
export function treeOidOfFiles(repo: Repo, files: Map<string, FileEntry>): string {
  interface DirNode {
    files: Map<string, FileEntry>;
    dirs: Map<string, DirNode>;
  }
  const top: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let cursor = top;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i]!;
      let next = cursor.dirs.get(seg);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        cursor.dirs.set(seg, next);
      }
      cursor = next;
    }
    cursor.files.set(parts[parts.length - 1]!, entry);
  }
  const assemble = (node: DirNode): string => {
    const rows: { mode: string; name: string; oid: string }[] = [];
    for (const [name, entry] of node.files) rows.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) rows.push({ mode: '40000', name, oid: assemble(child) });
    const blob = buildTree(rows);
    const treeId = hashObject('tree', blob);
    repo.objects.set(treeId, { type: 'tree', data: blob });
    return treeId;
  };
  return assemble(top);
}

/** Store an object, returning its oid. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const id = hashObject(type, data);
  repo.objects.set(id, { type, data });
  return id;
}

/**
 * Create a commit on a branch from a file map. Stores the tree + commit, moves the branch ref
 * and its file map, and returns the commit oid.
 */
export function commitFiles(
  repo: Repo,
  branch: string,
  files: Map<string, FileEntry>,
  message: string,
  parents: readonly string[],
): string {
  const topTree = treeOidOfFiles(repo, files);
  const raw = buildCommit({ tree: topTree, parents, message });
  const id = putObject(repo, 'commit', raw);
  repo.refs.set(`refs/heads/${branch}`, id);
  repo.branchFiles.set(branch, new Map(files));
  return id;
}

/** The first commit reachable from both `a` and `b` (BFS from both sides, oldest first). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const walkBack = (start: string): Map<string, number> => {
    const visited = new Map<string, number>();
    const pending: Array<[string, number]> = [[start, 0]];
    while (pending.length > 0) {
      const [id, level] = pending.shift()!;
      if (visited.has(id)) continue;
      visited.set(id, level);
      const found = repo.objects.get(id);
      if (!found || found.type !== 'commit') continue;
      for (const parent of parseCommit(found.data).parents) pending.push([parent, level + 1]);
    }
    return visited;
  };
  const sideA = walkBack(a);
  const sideB = walkBack(b);
  let winner: string | null = null;
  let bestSum = Infinity;
  for (const [id, levelA] of sideA) {
    const levelB = sideB.get(id);
    if (levelB === undefined) continue;
    const sum = levelA + levelB;
    if (sum < bestSum) {
      bestSum = sum;
      winner = id;
    }
  }
  return winner;
}

/** The file-level diff from `oldFiles` to `newFiles`. */
export function diffFiles(
  oldFiles: Map<string, FileEntry>,
  newFiles: Map<string, FileEntry>,
): Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> {
  const edits: Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> = [];
  for (const [path, entry] of newFiles) {
    const prior = oldFiles.get(path);
    if (!prior) edits.push({ path, status: 'added', oldOid: null, newOid: entry.oid });
    else if (prior.oid !== entry.oid) edits.push({ path, status: 'modified', oldOid: prior.oid, newOid: entry.oid });
  }
  for (const path of oldFiles.keys()) {
    if (!newFiles.has(path)) edits.push({ path, status: 'removed', oldOid: oldFiles.get(path)!.oid, newOid: null });
  }
  edits.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return edits;
}

/** Count the lines of a blob's text (a trailing newline does not add a line). */
export function lineCount(repo: Repo, oid: string | null): number {
  if (oid === null) return 0;
  const found = repo.objects.get(oid);
  if (!found) return 0;
  const body = found.data.toString('utf8');
  if (body === '') return 0;
  const parts = body.split('\n');
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length;
}

/** True when merging `headTip` into `baseTip` would conflict on a file both sides changed. */
export function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const fork = mergeBase(repo, baseTip, headTip);
  if (fork === null) return false;
  const forkFiles = filesOfCommit(repo, fork);
  const tipFiles = filesOfCommit(repo, headTip);
  const nowFiles = filesOfCommit(repo, baseTip);
  const tipEdits = diffFiles(forkFiles, tipFiles);
  const nowEdits = new Map(diffFiles(forkFiles, nowFiles).map((c) => [c.path, c]));
  for (const edit of tipEdits) {
    const match = nowEdits.get(edit.path);
    if (!match) continue;
    // Both sides changed the same path: a conflict unless they landed on the same content.
    if (edit.status === 'removed' || match.status === 'removed') {
      if (edit.status !== match.status) return true;
      continue;
    }
    if (edit.newOid !== match.newOid) return true;
  }
  return false;
}

// --------------------------------------------------------------------------- repos

export function createRepo(
  store: Store,
  owner: string,
  name: string,
  options: { description?: string; private?: boolean },
): Repo {
  const fresh: Repo = {
    id: store.nextRepoId++,
    name,
    owner,
    description: options.description ?? '',
    private: options.private ?? false,
    defaultBranch: 'main',
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    objects: new Map(),
    refs: new Map(),
    branchFiles: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextCommentId: 1,
  };
  // The six labels the suite feature-detects; creating them up front is what GitHub does.
  for (const tag of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
    fresh.labels.set(tag, { name: tag, color: 'ededed', description: '' });
  }
  store.repos.set(repoKey(owner, name), fresh);
  return fresh;
}

export function deleteRepo(store: Store, owner: string, name: string): boolean {
  return store.repos.delete(repoKey(owner, name));
}

// --------------------------------------------------------------------------- contents

export interface ContentsResult {
  commitSha: string;
  contentSha: string;
}

/**
 * PUT /contents: create or update a file on a branch. Returns the commit and blob shas.
 * `sha` (when given) must be the current blob sha or the update is a 409.
 */
export function putContents(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  sha?: string,
): ContentsResult | { error: 'stale-sha' } | { error: 'not-found' } {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const acc = tip ? new Map(repo.branchFiles.get(branch) ?? filesOfCommit(repo, tip)) : new Map<string, FileEntry>();
  const current = acc.get(path);
  if (sha !== undefined) {
    if (!current || current.oid !== sha) return { error: 'stale-sha' };
  }
  const blobId = putObject(repo, 'blob', content);
  acc.set(path, { oid: blobId, mode: '100644' });
  const links = tip && tip !== ZERO_OID ? [tip] : [];
  const commitId = commitFiles(repo, branch, acc, message, links);
  return { commitSha: commitId, contentSha: blobId };
}

/** DELETE /contents: remove a file from a branch. */
export function deleteContents(
  repo: Repo,
  branch: string,
  path: string,
  message: string,
  sha?: string,
): ContentsResult | { error: 'stale-sha' } | { error: 'not-found' } {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return { error: 'not-found' };
  const acc = new Map(repo.branchFiles.get(branch) ?? filesOfCommit(repo, tip));
  const current = acc.get(path);
  if (!current) return { error: 'not-found' };
  if (sha !== undefined && current.oid !== sha) return { error: 'stale-sha' };
  acc.delete(path);
  const commitId = commitFiles(repo, branch, acc, message, [tip]);
  return { commitSha: commitId, contentSha: current.oid };
}

// --------------------------------------------------------------------------- issues

export function createIssue(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): Issue | { error: 'bad-label'; label: string } {
  const picked: Label[] = [];
  for (const wanted of input.labels ?? []) {
    const found = repo.labels.get(wanted);
    if (!found) return { error: 'bad-label', label: wanted };
    picked.push(found);
  }
  const num = repo.nextNumber++;
  const fresh: Issue = {
    id: store.nextIssueId++,
    number: num,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: picked,
    comments: [],
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: null,
  };
  repo.issues.set(num, fresh);
  return fresh;
}

export function addIssueComment(repo: Repo, issue: Issue, body: string): IssueComment {
  const note: IssueComment = { id: repo.nextCommentId++, body, created_at: FIXED_TIME };
  issue.comments.push(note);
  return note;
}

// --------------------------------------------------------------------------- pulls

export function createPull(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): Pull | { error: 'unknown-branch'; branch: string } {
  if (!repo.refs.has(`refs/heads/${input.head}`)) return { error: 'unknown-branch', branch: input.head };
  if (!repo.refs.has(`refs/heads/${input.base}`)) return { error: 'unknown-branch', branch: input.base };
  const num = repo.nextNumber++;
  const fresh: Pull = {
    id: store.nextPullId++,
    number: num,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    headRef: input.head,
    baseRef: input.base,
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
  repo.pulls.set(num, fresh);
  return fresh;
}

/** The files a pull request changes, head vs merge-base, with line counts. */
export function pullFiles(repo: Repo, pull: Pull): Array<{
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}> {
  const tipA = repo.refs.get(`refs/heads/${pull.headRef}`);
  const tipB = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!tipA || !tipB) return [];
  const fork = mergeBase(repo, tipA, tipB) ?? tipB;
  const forkFiles = filesOfCommit(repo, fork);
  const tipFiles = filesOfCommit(repo, tipA);
  return diffFiles(forkFiles, tipFiles).map((edit) => {
    const added = edit.status === 'removed' ? 0 : lineCount(repo, edit.newOid);
    const removed = edit.status === 'added' ? 0 : lineCount(repo, edit.oldOid);
    return {
      filename: edit.path,
      status: edit.status === 'modified' ? 'modified' : edit.status,
      additions: added,
      deletions: removed,
      changes: added + removed,
    };
  });
}

/**
 * Squash-merge a pull request into its base branch. Returns the merge commit oid, or an
 * error: 'conflict' when both sides changed a file differently, 'already-merged' when done.
 */
export function mergePull(
  repo: Repo,
  pull: Pull,
): { mergeSha: string } | { error: 'conflict' } | { error: 'already-merged' } {
  if (pull.merged || pull.state === 'closed') return { error: 'already-merged' };
  const tipA = repo.refs.get(`refs/heads/${pull.headRef}`);
  const tipB = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!tipA || !tipB) return { error: 'conflict' };
  if (mergeConflicts(repo, tipB, tipA)) return { error: 'conflict' };
  const fork = mergeBase(repo, tipA, tipB) ?? tipB;
  const forkFiles = filesOfCommit(repo, fork);
  const tipFiles = filesOfCommit(repo, tipA);
  const nowFiles = filesOfCommit(repo, tipB);
  // Squash: the merged tree is the base tip's tree with the head's changes applied.
  const next = new Map(nowFiles);
  for (const edit of diffFiles(forkFiles, tipFiles)) {
    if (edit.status === 'removed') next.delete(edit.path);
    else next.set(edit.path, { oid: edit.newOid!, mode: '100644' });
  }
  const topTree = treeOidOfFiles(repo, next);
  const title = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const raw = buildCommit({ tree: topTree, parents: [tipB], message: title });
  const id = putObject(repo, 'commit', raw);
  repo.refs.set(`refs/heads/${pull.baseRef}`, id);
  repo.branchFiles.set(pull.baseRef, new Map(next));
  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = FIXED_TIME;
  pull.merge_commit_sha = id;
  pull.updated_at = FIXED_TIME;
  return { mergeSha: id };
}

// --------------------------------------------------------------------------- tags / refs

/** Create an annotated tag object and point refs/tags/<name> at it. */
export function createTag(repo: Repo, name: string, targetOid: string, targetType: GitObjectType, message: string): string {
  const raw = buildTag({ object: targetOid, type: targetType, tag: name, message });
  const id = putObject(repo, 'tag', raw);
  repo.refs.set(`refs/tags/${name}`, id);
  return id;
}

/** True when `ancestor` is reachable from `descendant` following commit parents only (no trees). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const visited = new Set<string>([descendant]);
  const pending = [descendant];
  while (pending.length > 0) {
    const id = pending.pop()!;
    const found = repo.objects.get(id);
    if (!found || found.type !== 'commit') continue;
    for (const link of parseCommit(found.data).parents) {
      if (link === ancestor) return true;
      if (!visited.has(link)) {
        visited.add(link);
        pending.push(link);
      }
    }
  }
  return false;
}

/** Peel a ref to its commit: a tag ref peels to the tag's target, a branch ref is itself. */
export function peelToCommit(repo: Repo, oid: string): string {
  const found = repo.objects.get(oid);
  if (!found) return oid;
  if (found.type === 'tag') return parseTag(found.data).object;
  return oid;
}

/** The objects reachable from a set of wanted oids, minus the objects reachable from haves. */
export function fetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  options: { depth?: number; shallowBoundaries?: readonly string[] } = {},
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const fetch = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds: the full closure of its haves, except a shallow
  // boundary is a root whose parents the client does NOT have (it holds only the tip).
  const edge = new Set<string>(options.shallowBoundaries ?? []);
  const held = collectReachable(haves, fetch, { allowMissing: true, cutoff: edge });
  const picked = new Map<string, GitObject>();
  const cut: string[] = [];
  const freed: string[] = [];

  if (options.depth !== undefined) {
    // Shallow: include commits at depth 0..D-1 from each want (their tree closures too);
    // the commits at depth D-1 are the new shallow boundaries (their parents are cut off).
    const limit = options.depth;
    const edgeSet = new Set<string>();
    const seen = new Set<string>();
    const pending: Array<[string, number]> = wants.map((w) => [w, 0]);
    while (pending.length > 0) {
      const [id, level] = pending.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const found = fetch(id);
      if (!found) continue;
      picked.set(id, found);
      if (found.type === 'tag') {
        // A tag want pulls its target at the same depth.
        const goal = parseTag(found.data).object;
        if (goal !== ZERO_OID && !seen.has(goal)) pending.push([goal, level]);
      } else if (found.type === 'commit') {
        const head = parseCommit(found.data);
        const trees = collectReachable([head.tree], fetch, { allowMissing: true });
        for (const tid of trees) {
          const treeObj = fetch(tid);
          if (treeObj) picked.set(tid, treeObj);
        }
        if (level + 1 < limit) {
          for (const parent of head.parents) pending.push([parent, level + 1]);
        } else {
          // level + 1 === depth: this commit is the shallow boundary.
          edgeSet.add(id);
        }
      }
    }
    for (const id of edgeSet) cut.push(id);
    // Old shallow boundaries that are now fully included become unshallow.
    for (const prior of options.shallowBoundaries ?? []) {
      if (!edgeSet.has(prior) && picked.has(prior)) freed.push(prior);
    }
    // Remove anything the client already has.
    for (const id of [...picked.keys()]) if (held.has(id)) picked.delete(id);
    return { objects: picked, shallow: cut, unshallow: freed };
  }

  const wanted = collectReachable(wants, fetch, { allowMissing: true });
  for (const id of wanted) {
    if (held.has(id)) continue;
    const found = fetch(id);
    if (found) picked.set(id, found);
  }
  return { objects: picked, shallow: cut, unshallow: freed };
}

export { isObjectId, ZERO_OID };
