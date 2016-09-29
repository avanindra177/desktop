import * as Path from 'path'
import * as ChildProcess from 'child_process'

import { WorkingDirectoryStatus, WorkingDirectoryFileChange, FileChange, FileStatus } from '../models/status'
import { DiffSelectionType, DiffSelection, Diff } from '../models/diff'
import { Repository } from '../models/repository'

import { createPatchForModifiedFile, createPatchForNewFile, createPatchForDeletedFile } from './patch-formatter'
import { DiffParser } from './diff-parser'

import { GitProcess } from 'git-kitchen-sink'

import { User } from '../models/user'

const byline = require('byline')

interface IResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** The encapsulation of the result from 'git status' */
export class StatusResult {
  /** true if the repository exists at the given location */
  public readonly exists: boolean

  /** the absolute path to the repository's working directory */
  public readonly workingDirectory: WorkingDirectoryStatus

  /** factory method when 'git status' is unsuccessful */
  public static NotFound(): StatusResult {
    return new StatusResult(false, new WorkingDirectoryStatus(new Array<WorkingDirectoryFileChange>(), true))
  }

  /** factory method for a successful 'git status' result  */
  public static FromStatus(status: WorkingDirectoryStatus): StatusResult {
    return new StatusResult(true, status)
  }

  public constructor(exists: boolean, workingDirectory: WorkingDirectoryStatus) {
    this.exists = exists
    this.workingDirectory = workingDirectory
  }
}

/** A git commit. */
export class Commit {
  /** The commit's SHA. */
  public readonly sha: string

  /** The first line of the commit message. */
  public readonly summary: string

  /** The commit message without the first line and CR. */
  public readonly body: string
  public readonly authorName: string
  public readonly authorEmail: string
  public readonly authorDate: Date

  public constructor(sha: string, summary: string, body: string, authorName: string, authorEmail: string, authorDate: Date) {
    this.sha = sha
    this.summary = summary
    this.body = body
    this.authorName = authorName
    this.authorEmail = authorEmail
    this.authorDate = authorDate
  }
}

export enum BranchType {
  Local,
  Remote,
}

/** A branch as loaded from Git. */
export class Branch {
  /** The short name of the branch. E.g., `master`. */
  public readonly name: string

  /** The remote-prefixed upstream name. E.g., `origin/master`. */
  public readonly upstream: string | null

  /** The SHA for the tip of the branch. */
  public readonly sha: string

  /** The type of branch, e.g., local or remote. */
  public readonly type: BranchType

  public constructor(name: string, upstream: string | null, sha: string, type: BranchType) {
    this.name = name
    this.upstream = upstream
    this.sha = sha
    this.type = type
  }

  /** The name of the upstream's remote. */
  public get remote(): string | null {
    const upstream = this.upstream
    if (!upstream) { return null }

    const pieces = upstream.match(/(.*?)\/.*/)
    if (!pieces || pieces.length < 2) { return null }

    return pieces[1]
  }

  /**
   * The name of the branch without the remote prefix. If the branch is a local
   * branch, this is the same as its `name`.
   */
  public get nameWithoutRemote(): string {
    if (this.type === BranchType.Local) {
      return this.name
    } else {
      const pieces = this.name.match(/.*?\/(.*)/)
      if (!pieces || pieces.length < 2) {
         return this.name
      }

      return pieces[1]
    }
  }
}

/**
 * Interactions with a local Git repository
 */
export class LocalGitOperations {

  /**
   * map the raw status text from Git to an app-friendly value
   * shamelessly borrowed from GitHub Desktop (Windows)
   */
  private static mapStatus(rawStatus: string): FileStatus {

    const status = rawStatus.trim()

    if (status === 'M') { return FileStatus.Modified }      // modified
    if (status === 'A') { return FileStatus.New }           // added
    if (status === 'D') { return FileStatus.Deleted }       // deleted
    if (status === 'R') { return FileStatus.Renamed }       // renamed
    if (status === 'RM') { return FileStatus.Renamed }      // renamed in index, modified in working directory
    if (status === 'RD') { return FileStatus.Conflicted }   // renamed in index, deleted in working directory
    if (status === 'DD') { return FileStatus.Conflicted }   // Unmerged, both deleted
    if (status === 'AU') { return FileStatus.Conflicted }   // Unmerged, added by us
    if (status === 'UD') { return FileStatus.Conflicted }   // Unmerged, deleted by them
    if (status === 'UA') { return FileStatus.Conflicted }   // Unmerged, added by them
    if (status === 'DU') { return FileStatus.Conflicted }   // Unmerged, deleted by us
    if (status === 'AA') { return FileStatus.Conflicted }   // Unmerged, added by both
    if (status === 'UU') { return FileStatus.Conflicted }   // Unmerged, both modified
    if (status === '??') { return FileStatus.New }          // untracked

    return FileStatus.Modified
  }

  /**
   *  Retrieve the status for a given repository,
   *  and fail gracefully if the location is not a Git repository
   */
  public static async getStatus(repository: Repository): Promise<StatusResult> {
    const result = await git([ 'status', '--untracked-files=all', '--porcelain' ], repository.path)
    const output = result.stdout
    const lines = output.split('\n')

    const regex = /([\? \w]{2}) (.*)/
    const regexGroups = { mode: 1, path: 2 }

    const files = new Array<WorkingDirectoryFileChange>()

    for (const index in lines) {
      const line = lines[index]
      const result = regex.exec(line)

      if (result) {
        const modeText = result[regexGroups.mode]
        const path = result[regexGroups.path]

        const status = this.mapStatus(modeText)
        const diffSelection = new DiffSelection(DiffSelectionType.All, new Map<number, boolean>())
        files.push(new WorkingDirectoryFileChange(path, status, diffSelection))
      }
    }

    return StatusResult.FromStatus(new WorkingDirectoryStatus(files, true))
  }

  private static async resolveHEAD(repository: Repository): Promise<boolean> {
    const result = await git([ 'show', 'HEAD' ], repository.path)
    if (result.exitCode === 0) {
      return true
    } else {
      return false
    }
  }

  private static addFileToIndex(repository: Repository, file: WorkingDirectoryFileChange): Promise<void> {
    let addFileArgs: string[] = []

    if (file.status === FileStatus.New) {
      addFileArgs = [ 'add', file.path ]
    } else {
      addFileArgs = [ 'add', '-u', file.path ]
    }

    return git(addFileArgs, repository.path)
  }

  private static async applyPatchToIndex(repository: Repository, file: WorkingDirectoryFileChange): Promise<void> {
    const applyArgs: string[] = [ 'apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-' ]

    const diff = await LocalGitOperations.getDiff(repository, file, null)

    const write = (input: string) => {
      return (process: ChildProcess.ChildProcess) => {
        process.stdin.write(input)
        process.stdin.end()
      }
    }

    if (file.status === FileStatus.New) {
      const input = await createPatchForNewFile(file, diff)
      await git(applyArgs, repository.path, {}, write(input))
    }

    if (file.status === FileStatus.Modified) {
      const patch = await createPatchForModifiedFile(file, diff)
      await git(applyArgs, repository.path, {}, write(patch))
    }

    if (file.status === FileStatus.Deleted) {
      const patch = await createPatchForDeletedFile(file, diff)
      await git(applyArgs, repository.path, {}, write(patch))
    }

    return Promise.resolve()
  }

  public static createCommit(repository: Repository, summary: string, description: string, files: ReadonlyArray<WorkingDirectoryFileChange>) {
    return this.resolveHEAD(repository)
      .then(result => {
        let resetArgs = [ 'reset' ]
        if (result) {
          resetArgs = resetArgs.concat([ 'HEAD', '--mixed' ])
        }

        return resetArgs
      })
      .then(resetArgs => {
        // reset the index
        return git(resetArgs, repository.path)
          .then(_ => {
            // TODO: pipe standard input into this command
            return this.stageFiles(repository, files)
              .then(() => {
                let message = summary
                if (description.length > 0) {
                  message = `${summary}\n\n${description}`
                }

                return git([ 'commit', '-m',  message ] , repository.path)
              })
          })
        })
      .catch(error => {
        console.error('createCommit failed: ' + error)
      })
  }

  /**
   * Stage all the given files by either staging the entire path or by applying
   * a patch.
   */
  private static async stageFiles(repository: Repository, files: ReadonlyArray<WorkingDirectoryFileChange>): Promise<void> {
    for (const file of files) {
      if (file.selection.getSelectionType() === DiffSelectionType.All) {
        await this.addFileToIndex(repository, file)
      } else {
        await this.applyPatchToIndex(repository, file)
      }
    }
  }

  /**
   * Render the diff for a file within the repository
   *
   * A specific commit related to the file may be provided, otherwise the
   * working directory state will be used.
   */
  public static getDiff(repository: Repository, file: FileChange, commit: Commit | null): Promise<Diff> {

    let args: string[]

    if (commit) {
      args = [ 'log', commit.sha, '-m', '-1', '--first-parent', '--patch-with-raw', '-z', '--', file.path ]
    } else if (file.status === FileStatus.New) {
      args = [ 'diff', '--no-index', '--patch-with-raw', '-z', '--', '/dev/null', file.path ]
    } else {
      args = [ 'diff', 'HEAD', '--patch-with-raw', '-z', '--', file.path ]
    }

    return git(args, repository.path)
      .then(result => {
        const output = result.stdout
        const pieces = output.split('\0')
        const parser = new DiffParser()
        return parser.parse(pieces[pieces.length - 1])
      })
  }

  /**
   * Get the repository's history, starting from `start` and limited to `limit`
   */
  public static async getHistory(repository: Repository, start: string, limit: number): Promise<ReadonlyArray<Commit>> {
    const delimiter = '1F'
    const delimeterString = String.fromCharCode(parseInt(delimiter, 16))
    const prettyFormat = [
      '%H', // SHA
      '%s', // summary
      '%b', // body
      '%an', // author name
      '%ae', // author email
      '%aI', // author date, ISO-8601
    ].join(`%x${delimiter}`)

    const result = await git([ 'log', start, `--max-count=${limit}`, `--pretty=${prettyFormat}`, '-z', '--no-color' ], repository.path)
    const out = result.stdout
    const lines = out.split('\0')
    // Remove the trailing empty line
    lines.splice(-1, 1)

    const commits = lines.map(line => {
      const pieces = line.split(delimeterString)
      const sha = pieces[0]
      const summary = pieces[1]
      const body = pieces[2]
      const authorName = pieces[3]
      const authorEmail = pieces[4]
      const parsedDate = Date.parse(pieces[5])
      const authorDate = new Date(parsedDate)
      return new Commit(sha, summary, body, authorName, authorEmail, authorDate)
    })

    return commits
  }

  /** Get the files that were changed in the given commit. */
  public static async getChangedFiles(repository: Repository, sha: string): Promise<ReadonlyArray<FileChange>> {
    const result = await git([ 'log', sha, '-m', '-1', '--first-parent', '--name-status', '--format=format:', '-z' ], repository.path)
    const out = result.stdout
    const lines = out.split('\0')
    // Remove the trailing empty line
    lines.splice(-1, 1)

    const files: FileChange[] = []
    for (let i = 0; i < lines.length; i++) {
      const statusText = lines[i]
      const status = this.mapStatus(statusText)
      const name = lines[++i]
      files.push(new FileChange(name, status))
    }

    return files
  }

  /** Look up a config value by name in the repository. */
  public static async getConfigValue(repository: Repository, name: string): Promise<string | null> {
    const result = await git([ 'config', '-z', name ], repository.path)
    // Git exits with 1 if the value isn't found. That's OK.
    if (result.exitCode === 1) {
      return null
    }

    const output = result.stdout
    const pieces = output.split('\0')
    return pieces[0]
  }

  private static getAskPassTrampolinePath(): string {
    const extension = __WIN32__ ? 'bat' : 'sh'
    return Path.resolve(__dirname, 'static', `ask-pass-trampoline.${extension}`)
  }

  private static getAskPassScriptPath(): string {
    return Path.resolve(__dirname, 'ask-pass.js')
  }

  /** Get the environment for authenticating remote operations. */
  private static envForAuthentication(user: User | null): Object {
    if (!user) { return {} }

    return {
      'DESKTOP_PATH': process.execPath,
      'DESKTOP_ASKPASS_SCRIPT': LocalGitOperations.getAskPassScriptPath(),
      'DESKTOP_USERNAME': user.login,
      'DESKTOP_ENDPOINT': user.endpoint,
      'GIT_ASKPASS': LocalGitOperations.getAskPassTrampolinePath(),
    }
  }

  /** Pull from the remote to the branch. */
  public static pull(repository: Repository, user: User | null, remote: string, branch: string): Promise<void> {
    return git([ 'pull', remote, branch ], repository.path, LocalGitOperations.envForAuthentication(user))
  }

  /** Push from the remote to the branch, optionally setting the upstream. */
  public static push(repository: Repository, user: User | null, remote: string, branch: string, setUpstream: boolean): Promise<void> {
    const args = [ 'push', remote, branch ]
    if (setUpstream) {
      args.push('--set-upstream')
    }

    return git(args, repository.path, LocalGitOperations.envForAuthentication(user))
  }

  /** Get the remote names. */
  private static async getRemotes(repository: Repository): Promise<ReadonlyArray<string>> {
    const result = await git([ 'remote' ], repository.path)
    const lines = result.stdout
    return lines.split('\n')
  }

  /** Get the name of the default remote. */
  public static async getDefaultRemote(repository: Repository): Promise<string | null> {
    const remotes = await LocalGitOperations.getRemotes(repository)
    if (remotes.length === 0) {
      return null
    }

    const index = remotes.indexOf('origin')
    if (index > -1) {
      return remotes[index]
    } else {
      return remotes[0]
    }
  }

  /** Get the name of the current branch. */
  public static async getCurrentBranch(repository: Repository): Promise<Branch | null> {
    const revParseResult = await git([ 'rev-parse', '--abbrev-ref', 'HEAD' ], repository.path)
    if (revParseResult.exitCode === 1) {
      // Git exits with 1 if there's the branch is unborn. We should do more
      // specific error parsing than this, but for now it'll do.
      return null
    }

    const untrimmedName = revParseResult.stdout
    let name = untrimmedName.trim()
    // New branches have a `heads/` prefix.
    name = name.replace(/^heads\//, '')

    const format = [
      '%(upstream:short)',
      '%(objectname)', // SHA
    ].join('%00')

    const refResult = await git([ 'for-each-ref', `--format=${format}`, `refs/heads/${name}` ], repository.path)
    const line = refResult.stdout
    const pieces = line.split('\0')
    const upstream = pieces[0]
    const sha = pieces[1].trim()
    return new Branch(name, upstream.length > 0 ? upstream : null, sha, BranchType.Local)
  }

  /** Get the number of commits in HEAD. */
  public static async getCommitCount(repository: Repository): Promise<number> {
    const result = await git([ 'rev-list', '--count', 'HEAD' ], repository.path)
    // Git exits with 1 if there's the branch is unborn. We should do more
    // specific error parsing than this, but for now it'll do.
    if (result.exitCode === 1) {
      return 0
    }

    const count = result.stdout
    return parseInt(count.trim(), 10)
  }

  /** Get all the branches. */
  public static async getBranches(repository: Repository, prefix: string, type: BranchType): Promise<ReadonlyArray<Branch>> {
    const format = [
      '%(refname:short)',
      '%(upstream:short)',
      '%(objectname)', // SHA
    ].join('%00')
    const result = await git([ 'for-each-ref', `--format=${format}`, prefix ], repository.path)
    const names = result.stdout
    const lines = names.split('\n')

    // Remove the trailing newline
    lines.splice(-1, 1)

    const branches = lines.map(line => {
      const pieces = line.split('\0')
      const name = pieces[0]
      const upstream = pieces[1]
      const sha = pieces[2]
      return new Branch(name, upstream.length > 0 ? upstream : null, sha, type)
    })

    return branches
  }

  /** Create a new branch from the given start point. */
  public static createBranch(repository: Repository, name: string, startPoint: string): Promise<void> {
    return git([ 'branch', name, startPoint ], repository.path)
  }

  /** Check out the given branch. */
  public static checkoutBranch(repository: Repository, name: string): Promise<void> {
    return git([ 'checkout', name, '--' ], repository.path)
  }

  /** Get the `limit` most recently checked out branches. */
  public static async getRecentBranches(repository: Repository, branches: ReadonlyArray<Branch>, limit: number): Promise<ReadonlyArray<Branch>> {
    const branchesByName = branches.reduce((map, branch) => map.set(branch.name, branch), new Map<string, Branch>())

    // "git reflog show" is just an alias for "git log -g --abbrev-commit --pretty=oneline"
    // but by using log we can give it a max number which should prevent us from balling out
    // of control when there's ginormous reflogs around (as in e.g. github/github).
    const regex = new RegExp(/.*? checkout: moving from .*? to (.*?)$/i)
    const result = await git([ 'log', '-g', '--abbrev-commit', '--pretty=oneline', 'HEAD', '-n', '2500' ], repository.path)
    const output = result.stdout
    const lines = output.split('\n')
    const names = new Set<string>()
    for (const line of lines) {
      const result = regex.exec(line)
      if (result && result.length === 2) {
        const branchName = result[1]
        names.add(branchName)
      }

      if (names.size === limit) {
        break
      }
    }

    const recentBranches = new Array<Branch>()
    for (const name of names) {
      const branch = branchesByName.get(name)
      if (!branch) {
        // This means the recent branch has been deleted. That's fine.
        continue
      }

      recentBranches.push(branch)
    }

    return recentBranches
  }

  /** Get the commit for the given ref. */
  public static async getCommit(repository: Repository, ref: string): Promise<Commit | null> {
    const commits = await LocalGitOperations.getHistory(repository, ref, 1)
    if (commits.length < 1) { return null }

    return commits[0]
  }

  /** Get the git dir of the path. */
  public static async getGitDir(path: string): Promise<string | null> {
    const result = await git([ 'rev-parse', '--git-dir' ], path)
    if (result.exitCode > 0) {
      return null
    }

    const gitDir = result.stdout
    const trimmedDir = gitDir.trim()
    return Path.join(path, trimmedDir)
  }

  /** Is the path a git repository? */
  public static async isGitRepository(path: string): Promise<boolean> {
    const result = await this.getGitDir(path)
    return !!result
  }

  /** Init a new git repository in the given path. */
  public static initGitRepository(path: string): Promise<void> {
    return git([ 'init' ], path)
  }

  /** Clone the repository to the path. */
  public static clone(url: string, path: string, user: User | null, progress: (progress: string) => void): Promise<void> {
    const env = LocalGitOperations.envForAuthentication(user)
    return git([ 'clone', '--recursive', '--progress', '--', url, path ], __dirname, env, process => {
      byline(process.stderr).on('data', (chunk: string) => {
        progress(chunk)
      })
    })
  }

  /** Rename the given branch to a new name. */
  public static renameBranch(repository: Repository, branch: Branch, newName: string): Promise<void> {
    return git([ 'branch', '-m', branch.nameWithoutRemote, newName ], repository.path)
  }

  /**
   * Delete the branch. If the branch has a remote branch, it too will be
   * deleted.
   */
  public static async deleteBranch(repository: Repository, branch: Branch): Promise<void> {
    const deleteRemoteBranch = (branch: Branch, remote: string) => {
      return git([ 'push', remote, `:${branch.nameWithoutRemote}` ], repository.path)
    }

    if (branch.type === BranchType.Local) {
      await git([ 'branch', '-D', branch.name ], repository.path)
    }

    const remote = branch.remote
    if (remote) {
      await deleteRemoteBranch(branch, remote)
    }
  }

  /** Add a new remote with the given URL. */
  public static addRemote(path: string, name: string, url: string): Promise<void> {
    return git([ 'remote', 'add', name, url ], path)
  }

  /** Check out the paths at HEAD. */
  public static checkoutPaths(repository: Repository, paths: ReadonlyArray<string>): Promise<void> {
    return git([ 'checkout', '--', ...paths ], repository.path)
  }
}

async function git(args: string[], path: string, customEnv?: Object, processCb?: (process: ChildProcess.ChildProcess) => void): Promise<IResult> {
  const result = await GitProcess.execWithOutput(args, path, customEnv, processCb)
  if (result.exitCode > 0) {
    console.error(result.stderr)
  }

  return result
}
