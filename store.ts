// store.ts — the forge's in-memory data model: repositories, their git object stores and
// refs, branch file state, issues, pull requests, comments and labels.
//
// Determinism: ids and numbers come from counters; every timestamp is the fixed constant.
// Nothing here reads the clock or randomness, so two runs over the same requests answer the
// same bytes.

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
  const files = new Map<string, FileEntry>();
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return files;
  const rootTree = parseCommit(object.data).tree;
  const walk = (treeOid: string, prefix: string): void => {
    const treeObject = repo.objects.get(treeOid);
    if (!treeObject || treeObject.type !== 'tree') return;
    for (const entry of parseTree(treeObject.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else files.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(rootTree, '');
  return files;
}

/**
 * Build (and store) the nested tree objects for a flat file map. Returns the root tree oid.
 * Directories are created for every path prefix that holds a file.
 */
export function treeOidOfFiles(repo: Repo, files: Map<string, FileEntry>): string {
  interface Node {
    files: Map<string, FileEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let child = node.dirs.get(part);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Store an object, returning its oid. */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  repo.objects.set(oid, { type, data });
  return oid;
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
  const treeOid = treeOidOfFiles(repo, files);
  const commitData = buildCommit({ tree: treeOid, parents, message });
  const commitOid = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.branchFiles.set(branch, new Map(files));
  return commitOid;
}

/** The first commit reachable from both `a` and `b` (BFS from both sides, oldest first). */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestors = (start: string): Map<string, number> => {
    const seen = new Map<string, number>();
    const queue: Array<[string, number]> = [[start, 0]];
    while (queue.length > 0) {
      const [oid, depth] = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.set(oid, depth);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
    }
    return seen;
  };
  const fromA = ancestors(a);
  const fromB = ancestors(b);
  let best: string | null = null;
  let bestDepth = Infinity;
  for (const [oid, depthA] of fromA) {
    const depthB = fromB.get(oid);
    if (depthB === undefined) continue;
    const depth = depthA + depthB;
    if (depth < bestDepth) {
      bestDepth = depth;
      best = oid;
    }
  }
  return best;
}

/** The file-level diff from `oldFiles` to `newFiles`. */
export function diffFiles(
  oldFiles: Map<string, FileEntry>,
  newFiles: Map<string, FileEntry>,
): Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> {
  const changes: Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> = [];
  for (const [path, entry] of newFiles) {
    const old = oldFiles.get(path);
    if (!old) changes.push({ path, status: 'added', oldOid: null, newOid: entry.oid });
    else if (old.oid !== entry.oid) changes.push({ path, status: 'modified', oldOid: old.oid, newOid: entry.oid });
  }
  for (const path of oldFiles.keys()) {
    if (!newFiles.has(path)) changes.push({ path, status: 'removed', oldOid: oldFiles.get(path)!.oid, newOid: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** Count the lines of a blob's text (a trailing newline does not add a line). */
export function lineCount(repo: Repo, oid: string | null): number {
  if (oid === null) return 0;
  const object = repo.objects.get(oid);
  if (!object) return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** True when merging `headTip` into `baseTip` would conflict on a file both sides changed. */
export function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const base = mergeBase(repo, baseTip, headTip);
  if (base === null) return false;
  const baseFiles = filesOfCommit(repo, base);
  const headFiles = filesOfCommit(repo, headTip);
  const baseNowFiles = filesOfCommit(repo, baseTip);
  const headChanges = diffFiles(baseFiles, headFiles);
  const baseChanges = new Map(diffFiles(baseFiles, baseNowFiles).map((c) => [c.path, c]));
  for (const change of headChanges) {
    const other = baseChanges.get(change.path);
    if (!other) continue;
    // Both sides changed the same path: a conflict unless they landed on the same content.
    if (change.status === 'removed' || other.status === 'removed') {
      if (change.status !== other.status) return true;
      continue;
    }
    if (change.newOid !== other.newOid) return true;
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
  const repo: Repo = {
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
  for (const labelName of ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted']) {
    repo.labels.set(labelName, { name: labelName, color: 'ededed', description: '' });
  }
  store.repos.set(repoKey(owner, name), repo);
  return repo;
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
  const head = repo.refs.get(`refs/heads/${branch}`);
  const files = head ? new Map(repo.branchFiles.get(branch) ?? filesOfCommit(repo, head)) : new Map<string, FileEntry>();
  const existing = files.get(path);
  if (sha !== undefined) {
    if (!existing || existing.oid !== sha) return { error: 'stale-sha' };
  }
  const blobOid = putObject(repo, 'blob', content);
  files.set(path, { oid: blobOid, mode: '100644' });
  const parents = head && head !== ZERO_OID ? [head] : [];
  const commitSha = commitFiles(repo, branch, files, message, parents);
  return { commitSha, contentSha: blobOid };
}

/** DELETE /contents: remove a file from a branch. */
export function deleteContents(
  repo: Repo,
  branch: string,
  path: string,
  message: string,
  sha?: string,
): ContentsResult | { error: 'stale-sha' } | { error: 'not-found' } {
  const head = repo.refs.get(`refs/heads/${branch}`);
  if (!head) return { error: 'not-found' };
  const files = new Map(repo.branchFiles.get(branch) ?? filesOfCommit(repo, head));
  const existing = files.get(path);
  if (!existing) return { error: 'not-found' };
  if (sha !== undefined && existing.oid !== sha) return { error: 'stale-sha' };
  files.delete(path);
  const commitSha = commitFiles(repo, branch, files, message, [head]);
  return { commitSha, contentSha: existing.oid };
}

// --------------------------------------------------------------------------- issues

export function createIssue(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): Issue | { error: 'bad-label'; label: string } {
  const labels: Label[] = [];
  for (const name of input.labels ?? []) {
    const label = repo.labels.get(name);
    if (!label) return { error: 'bad-label', label: name };
    labels.push(label);
  }
  const number = repo.nextNumber++;
  const issue: Issue = {
    id: store.nextIssueId++,
    number,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    comments: [],
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    closed_at: null,
  };
  repo.issues.set(number, issue);
  return issue;
}

export function addIssueComment(repo: Repo, issue: Issue, body: string): IssueComment {
  const comment: IssueComment = { id: repo.nextCommentId++, body, created_at: FIXED_TIME };
  issue.comments.push(comment);
  return comment;
}

// --------------------------------------------------------------------------- pulls

export function createPull(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; head: string; base: string },
): Pull | { error: 'unknown-branch'; branch: string } {
  if (!repo.refs.has(`refs/heads/${input.head}`)) return { error: 'unknown-branch', branch: input.head };
  if (!repo.refs.has(`refs/heads/${input.base}`)) return { error: 'unknown-branch', branch: input.base };
  const number = repo.nextNumber++;
  const pull: Pull = {
    id: store.nextPullId++,
    number,
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
  repo.pulls.set(number, pull);
  return pull;
}

/** The files a pull request changes, head vs merge-base, with line counts. */
export function pullFiles(repo: Repo, pull: Pull): Array<{
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return [];
  const base = mergeBase(repo, headTip, baseTip) ?? baseTip;
  const baseFiles = filesOfCommit(repo, base);
  const headFiles = filesOfCommit(repo, headTip);
  return diffFiles(baseFiles, headFiles).map((change) => {
    const additions = change.status === 'removed' ? 0 : lineCount(repo, change.newOid);
    const deletions = change.status === 'added' ? 0 : lineCount(repo, change.oldOid);
    return {
      filename: change.path,
      status: change.status === 'modified' ? 'modified' : change.status,
      additions,
      deletions,
      changes: additions + deletions,
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
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return { error: 'conflict' };
  if (mergeConflicts(repo, baseTip, headTip)) return { error: 'conflict' };
  const base = mergeBase(repo, headTip, baseTip) ?? baseTip;
  const baseFiles = filesOfCommit(repo, base);
  const headFiles = filesOfCommit(repo, headTip);
  const baseNowFiles = filesOfCommit(repo, baseTip);
  // Squash: the merged tree is the base tip's tree with the head's changes applied.
  const merged = new Map(baseNowFiles);
  for (const change of diffFiles(baseFiles, headFiles)) {
    if (change.status === 'removed') merged.delete(change.path);
    else merged.set(change.path, { oid: change.newOid!, mode: '100644' });
  }
  const treeOid = treeOidOfFiles(repo, merged);
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const commitData = buildCommit({ tree: treeOid, parents: [baseTip], message });
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  repo.branchFiles.set(pull.baseRef, new Map(merged));
  pull.merged = true;
  pull.state = 'closed';
  pull.merged_at = FIXED_TIME;
  pull.merge_commit_sha = mergeSha;
  pull.updated_at = FIXED_TIME;
  return { mergeSha };
}

// --------------------------------------------------------------------------- tags / refs

/** Create an annotated tag object and point refs/tags/<name> at it. */
export function createTag(repo: Repo, name: string, targetOid: string, targetType: GitObjectType, message: string): string {
  const tagData = buildTag({ object: targetOid, type: targetType, tag: name, message });
  const tagOid = putObject(repo, 'tag', tagData);
  repo.refs.set(`refs/tags/${name}`, tagOid);
  return tagOid;
}

/** True when `ancestor` is reachable from `descendant` following commit parents only (no trees). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** Peel a ref to its commit: a tag ref peels to the tag's target, a branch ref is itself. */
export function peelToCommit(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object) return oid;
  if (object.type === 'tag') return parseTag(object.data).object;
  return oid;
}

/** The objects reachable from a set of wanted oids, minus the objects reachable from haves. */
export function fetchObjects(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  options: { depth?: number; shallowBoundaries?: readonly string[] } = {},
): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // What the client already holds: the full closure of its haves, except a shallow
  // boundary is a root whose parents the client does NOT have (it holds only the tip).
  const cutoff = new Set<string>(options.shallowBoundaries ?? []);
  const haveReachable = collectReachable(haves, lookup, { allowMissing: true, cutoff });
  const objects = new Map<string, GitObject>();
  const shallow: string[] = [];
  const unshallow: string[] = [];

  if (options.depth !== undefined) {
    // Shallow: include commits at depth 0..D-1 from each want (their tree closures too);
    // the commits at depth D-1 are the new shallow boundaries (their parents are cut off).
    const depth = options.depth;
    const boundary = new Set<string>();
    const visited = new Set<string>();
    const queue: Array<[string, number]> = wants.map((w) => [w, 0]);
    while (queue.length > 0) {
      const [oid, d] = queue.shift()!;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      objects.set(oid, object);
      if (object.type === 'tag') {
        // A tag want pulls its target at the same depth.
        const target = parseTag(object.data).object;
        if (target !== ZERO_OID && !visited.has(target)) queue.push([target, d]);
      } else if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        const treeClosure = collectReachable([commit.tree], lookup, { allowMissing: true });
        for (const treeOid of treeClosure) {
          const treeObject = lookup(treeOid);
          if (treeObject) objects.set(treeOid, treeObject);
        }
        if (d + 1 < depth) {
          for (const parent of commit.parents) queue.push([parent, d + 1]);
        } else {
          // d + 1 === depth: this commit is the shallow boundary.
          boundary.add(oid);
        }
      }
    }
    for (const oid of boundary) shallow.push(oid);
    // Old shallow boundaries that are now fully included become unshallow.
    for (const old of options.shallowBoundaries ?? []) {
      if (!boundary.has(old) && objects.has(old)) unshallow.push(old);
    }
    // Remove anything the client already has.
    for (const oid of [...objects.keys()]) if (haveReachable.has(oid)) objects.delete(oid);
    return { objects, shallow, unshallow };
  }

  const wantReachable = collectReachable(wants, lookup, { allowMissing: true });
  for (const oid of wantReachable) {
    if (haveReachable.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.set(oid, object);
  }
  return { objects, shallow, unshallow };
}

export { isObjectId, ZERO_OID };
