/*---------------------------------------------------------------------------------------------
 *  Git Service
 *  Handles all Git-related operations
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import type { API, GitExtension, Repository } from '../types/git';
import {
    NoChangesDetectedError,
    NoRepositoriesFoundError,
    NoRepositorySelectedError,
    GitExtensionNotFoundError
} from './types';
import { DiffSnippetService } from './diffSnippetService';
import { Logger } from '../utils';

function throwIfCancelled(token?: vscode.CancellationToken): void {
    if (token?.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}

export interface GitDiffSection {
    /** File corresponding to each diff item (same index). */
    uri: vscode.Uri[];
    /** Unified diff for each file (same index as uri). */
    diff: string[];
}

export interface GitDiffParts {
    staged: GitDiffSection;
    /** Changes for working tree tracked files (unstaged). */
    tracked: GitDiffSection;
    untracked: GitDiffSection;
}

/**
 * Check Git availability and set context variable
 * Used to control the display of Commit message generation button
 *
 * @returns vscode.Disposable Returns a Disposable for cleaning up listeners
 */
export function checkGitAvailability(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];

    // Listen for extension enablement status changes
    const onDidChangeGitExtensionEnablement = (enabled: boolean) => {
        if (enabled) {
            vscode.commands.executeCommand('setContext', 'ccmp.gitAvailable', true);
            Logger.debug('[Git] vscode.git extension enabled, Commit message generation feature enabled');
        } else {
            vscode.commands.executeCommand('setContext', 'ccmp.gitAvailable', false);
            Logger.warn('[Git] vscode.git extension disabled, Commit message generation feature will be hidden');
        }
    };

    // Initialize Git extension
    const initialize = () => {
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');

        if (!gitExtension) {
            // vscode.git extension does not exist (may be disabled or not installed)
            vscode.commands.executeCommand('setContext', 'ccmp.gitAvailable', false);
            Logger.warn('[Git] vscode.git extension not found, Commit message generation feature will be hidden');
            return;
        }

        // Activate extension and listen for enablement status changes
        gitExtension.activate().then(
            extension => {
                // Listen for extension enablement status changes
                disposables.push(extension.onDidChangeEnablement(onDidChangeGitExtensionEnablement));

                // Set initial status
                onDidChangeGitExtensionEnablement(extension.enabled);
            },
            (error: unknown) => {
                // Error occurred, consider Git unavailable
                vscode.commands.executeCommand('setContext', 'ccmp.gitAvailable', false);
                Logger.warn('[Git] Error checking Git availability:', error);
            }
        );
    };

    // Try to initialize immediately
    initialize();

    // Listen for extension install/enable events
    const listener = vscode.extensions.onDidChange(() => {
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (gitExtension) {
            // vscode.git extension installed, initialize and remove listener
            initialize();
            listener.dispose();
        }
    });
    disposables.push(listener);

    // Return a Disposable for cleaning up all listeners
    return {
        dispose: () => {
            for (const disposable of disposables) {
                disposable.dispose();
            }
            disposables.length = 0;
        }
    };
}

/**
 * Git Service class
 * Responsible for executing Git commands and managing repositories
 */
export class GitService {
    private static gitApi: API | null = null;
    private static execFileAsync = promisify(execFile);

    /**
     * Validate Git extension availability
     */
    static async validateGitExtension(): Promise<void> {
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!gitExtension) {
            throw new GitExtensionNotFoundError();
        }

        if (!gitExtension.isActive) {
            await gitExtension.activate();
        }

        const gitApi = gitExtension.exports.getAPI(1);
        if (!gitApi) {
            throw new GitExtensionNotFoundError();
        }

        this.gitApi = gitApi;
    }

    private static async getRepositoryByPath(repoPath: string): Promise<Repository> {
        const repos = await this.getRepositories();
        const normalized = vscode.Uri.file(repoPath).fsPath;
        const found = repos.find(r => r.rootUri.fsPath === normalized);
        return found ?? repos[0];
    }

    /**
     * Get all repositories
     */
    static async getRepositories(): Promise<Repository[]> {
        if (!this.gitApi) {
            await this.validateGitExtension();
        }

        const repositories = this.gitApi?.repositories;
        if (!repositories || repositories.length === 0) {
            throw new NoRepositoriesFoundError();
        }

        return repositories;
    }

    /**
     * Let user select repository
     */
    static async selectRepository(repos: Repository[]): Promise<Repository> {
        const items = repos.map(repo => ({
            label: repo.rootUri.fsPath,
            description: repo.rootUri.fsPath,
            repository: repo
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a Git repository'
        });

        if (!selected) {
            throw new NoRepositorySelectedError();
        }

        return selected.repository;
    }

    /**
     * Get code diff (returned in parts)
     * - staged: staged changes
     * - tracked: unstaged changes for working tree tracked files
     * - untracked: untracked new files (pasted in "new file" unified diff format)
     *
     * Each part returns { uri: [], diff: [] }, two arrays aligned by index.
     */
    static async getDiff(
        repoPath: string,
        onlyStagedChanges: boolean,
        token?: vscode.CancellationToken
    ): Promise<GitDiffParts> {
        try {
            throwIfCancelled(token);

            const repo = await this.getRepositoryByPath(repoPath);
            await repo.status();
            throwIfCancelled(token);

            const maxDiffCharsPerFile = 12000;

            const stagedUnified = await repo.diff(true);
            throwIfCancelled(token);
            const staged = this.unifiedDiffToSection(repoPath, stagedUnified, maxDiffCharsPerFile);

            if (onlyStagedChanges) {
                if (staged.diff.length === 0 || staged.diff.join('\n').trim() === '') {
                    throw new NoChangesDetectedError();
                }
                return { staged, tracked: { uri: [], diff: [] }, untracked: { uri: [], diff: [] } };
            }

            const trackedUnified = await repo.diff(false);
            throwIfCancelled(token);
            const tracked = this.unifiedDiffToSection(repoPath, trackedUnified, maxDiffCharsPerFile);

            const untracked = await this.getUntrackedSection(repoPath, repo, maxDiffCharsPerFile, token);

            if (staged.diff.length === 0 && tracked.diff.length === 0 && untracked.diff.length === 0) {
                throw new NoChangesDetectedError();
            }

            return { staged, tracked, untracked };
        } catch (error) {
            Logger.error('[GitService] Failed to get diff:', error);
            throw error;
        }
    }

    private static unifiedDiffToSection(
        repoPath: string,
        unifiedDiff: string,
        maxCharsPerFile: number
    ): GitDiffSection {
        const snippets = DiffSnippetService.buildSnippets(unifiedDiff ?? '', {
            maxExcerptCharsPerFile: maxCharsPerFile,
            maxFiles: Number.MAX_SAFE_INTEGER
        });

        const uri: vscode.Uri[] = [];
        const diff: string[] = [];

        for (const snip of snippets) {
            const filePath = (snip.filePath ?? '').trim();
            if (!filePath || filePath === '(unknown-file)') {
                continue;
            }
            // filePath is a path relative to the repository, using forward slashes.
            const fsPath = path.join(repoPath, filePath);
            uri.push(vscode.Uri.file(fsPath));
            diff.push(snip.excerpt);
        }

        return { uri, diff };
    }

    private static toGitPath(repoPath: string, fileFsPath: string): string {
        // git diff headers use forward slashes and paths relative to the repository.
        const rel = path.relative(repoPath, fileFsPath);
        return rel.split(path.sep).join('/');
    }

    private static looksBinary(buf: Uint8Array): boolean {
        // Heuristic check: NUL bytes almost always indicate binary files.
        return buf.includes(0);
    }

    private static buildNewFileUnifiedDiff(repoRelativePath: string, content: string): string {
        const normalized = content.replace(/\r\n/g, '\n');
        const lines = normalized.length === 0 ? [] : normalized.split('\n');
        const plusLines = lines.map(l => `+${l}`);

        const header: string[] = [];
        header.push(`diff --git a/${repoRelativePath} b/${repoRelativePath}`);
        header.push('new file mode 100644');
        header.push('--- /dev/null');
        header.push(`+++ b/${repoRelativePath}`);

        if (plusLines.length === 0) {
            return header.join('\n');
        }

        header.push(`@@ -0,0 +1,${plusLines.length} @@`);
        header.push(...plusLines);
        return header.join('\n');
    }

    private static async getUntrackedSection(
        repoPath: string,
        repo: Repository,
        maxCharsPerFile: number,
        token?: vscode.CancellationToken
    ): Promise<GitDiffSection> {
        throwIfCancelled(token);

        const untrackedUris = await this.getUntrackedUris(repoPath, repo, token);
        if (untrackedUris.length === 0) {
            return { uri: [], diff: [] };
        }

        // Stable sort
        untrackedUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

        const uri: vscode.Uri[] = [];
        const diff: string[] = [];

        for (const fileUri of untrackedUris) {
            throwIfCancelled(token);

            const repoRelativePath = this.toGitPath(repoPath, fileUri.fsPath);
            if (!repoRelativePath || repoRelativePath.startsWith('..')) {
                continue;
            }

            try {
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                let patch = '';

                if (this.looksBinary(bytes)) {
                    patch = [
                        `diff --git a/${repoRelativePath} b/${repoRelativePath}`,
                        'new file mode 100644',
                        '--- /dev/null',
                        `+++ b/${repoRelativePath}`,
                        'Binary files /dev/null and b/' + repoRelativePath + ' differ'
                    ].join('\n');
                } else {
                    let text = Buffer.from(bytes).toString('utf8');
                    if (text.length > maxCharsPerFile) {
                        text = text.slice(0, maxCharsPerFile) + '\n... [untracked file truncated]';
                    }
                    patch = this.buildNewFileUnifiedDiff(repoRelativePath, text);
                }

                // Ensure each file's patch does not exceed the limit.
                if (patch.length > maxCharsPerFile) {
                    patch = patch.slice(0, maxCharsPerFile) + '\n... [file excerpt truncated]';
                }

                uri.push(fileUri);
                diff.push(patch);
            } catch (e) {
                Logger.warn('[GitService] Failed to read untracked file:', fileUri.fsPath, e);
            }
        }

        return { uri, diff };
    }

    private static async getUntrackedUris(
        repoPath: string,
        repo: Repository,
        token?: vscode.CancellationToken
    ): Promise<vscode.Uri[]> {
        throwIfCancelled(token);

        const out = new Map<string, vscode.Uri>();

        // 1) Primary source: VS Code Git API status
        const untracked = repo.state.untrackedChanges ?? [];
        for (const ch of untracked) {
            out.set(ch.uri.fsPath, ch.uri);
        }

        // 2) Fallback: some environments do not fill `untrackedChanges`, but will
        // mark untracked files in workingTreeChanges.
        // Note: Status is an enum in VS Code git API, but we do not import it at runtime.
        // According to the order in src/types/git.d.ts:
        // - UNTRACKED = 7
        // - INTENT_TO_ADD = 9
        if (out.size === 0) {
            const UNTRACKED = 7;
            const INTENT_TO_ADD = 9;
            const working = repo.state.workingTreeChanges ?? [];
            for (const ch of working) {
                if (ch.status === UNTRACKED || ch.status === INTENT_TO_ADD) {
                    out.set(ch.uri.fsPath, ch.uri);
                }
            }
        }

        // 3) Hard fallback: query git directly (most reliable)
        if (out.size === 0) {
            try {
                if (!this.gitApi) {
                    await this.validateGitExtension();
                }
                const gitPath = this.gitApi?.git.path;
                if (gitPath) {
                    // Use -z to avoid path quoting issues; parse NUL-separated output.
                    const { stdout } = await this.execFileAsync(
                        gitPath,
                        ['ls-files', '--others', '--exclude-standard', '-z'],
                        // Request Buffer to avoid encoding/type edge cases.
                        { cwd: repoPath, windowsHide: true, encoding: null }
                    );
                    const buf = stdout as Buffer;
                    const parts = buf
                        .toString('utf8')
                        .split('\0')
                        .map(p => p.trim())
                        .filter(Boolean);
                    for (const p of parts) {
                        const fsPath = path.join(repoPath, p);
                        out.set(fsPath, vscode.Uri.file(fsPath));
                    }
                }
            } catch (e) {
                Logger.warn('[GitService] git ls-files failed to get untracked:', e);
            }
        }

        return [...out.values()];
    }

    /**
     * Get recent commit history for specified files (for context in generating commit messages).
     * Description: Here we use git log instead of line-by-line git blame, because blame has complex
     * line number mapping and high overhead when not committed/large changes; log information is more direct for "writing this commit info".
     */
    static async getRecentCommitsForFiles(
        repoPath: string,
        files: string[],
        token?: vscode.CancellationToken
    ): Promise<string> {
        throwIfCancelled(token);

        const repo = await this.getRepositoryByPath(repoPath);

        const uniqueFiles = [...new Set(files.map(f => f.trim()).filter(Boolean))];
        const maxFiles = 10;
        const maxCommitsPerFile = 3;
        const selectedFiles = uniqueFiles.slice(0, maxFiles);

        // Deduplicate across paths (renamed old path/new path often share the same commit history).
        const commitMap = new Map<
            string,
            {
                hash: string;
                authorDate?: Date;
                authorName?: string;
                message?: string;
                paths: Set<string>;
            }
        >();

        for (const file of selectedFiles) {
            throwIfCancelled(token);
            const commits = await repo.log({ maxEntries: maxCommitsPerFile, path: file });
            for (const c of commits) {
                const existing = commitMap.get(c.hash);
                if (existing) {
                    existing.paths.add(file);
                    continue;
                }
                commitMap.set(c.hash, {
                    hash: c.hash,
                    authorDate: c.authorDate,
                    authorName: c.authorName,
                    message: c.message,
                    paths: new Set([file])
                });
            }
        }

        const uniqueCommits = [...commitMap.values()].sort((a, b) => {
            const at = a.authorDate?.getTime() ?? 0;
            const bt = b.authorDate?.getTime() ?? 0;
            return bt - at;
        });

        const maxUniqueCommits = maxFiles * maxCommitsPerFile;
        const displayed = uniqueCommits.slice(0, maxUniqueCommits);
        const lines: string[] = [];

        lines.push('Selected files:');
        for (const f of selectedFiles) {
            lines.push(`- ${f}`);
        }
        if (uniqueFiles.length > maxFiles) {
            lines.push(`(and ${uniqueFiles.length - maxFiles} more files...)`);
        }
        lines.push('');

        if (displayed.length === 0) {
            lines.push('Recent commits: (no history found)');
            return lines.join('\n');
        }

        lines.push('Recent commits (touching selected files):');
        for (const c of displayed) {
            const date = c.authorDate ? c.authorDate.toISOString().slice(0, 10) : '';
            const author = c.authorName ?? '';
            const paths = [...c.paths];
            const shownPaths = paths.slice(0, 3);
            const pathSuffix =
                paths.length <= 3 ? shownPaths.join(', ') : `${shownPaths.join(', ')} (+${paths.length - 3} more)`;
            lines.push(`${c.hash.slice(0, 7)} ${date} ${author} | ${c.message ?? ''} [paths: ${pathSuffix}]`.trim());
        }

        if (uniqueCommits.length > maxUniqueCommits) {
            lines.push(`(and ${uniqueCommits.length - maxUniqueCommits} more commits...)`);
        }

        return lines.join('\n');
    }

    /**
     * Get repository recent commit history (unrelated to files, used to let the model infer the repository's commit conventions).
     */
    static async getRecentCommits(
        repoPath: string,
        token?: vscode.CancellationToken,
        options?: { maxEntries?: number; format?: 'subject' | 'detailed' }
    ): Promise<string> {
        throwIfCancelled(token);

        const repo = await this.getRepositoryByPath(repoPath);
        const maxEntries = Math.max(1, Math.min(options?.maxEntries ?? 20, 50));
        const format = options?.format ?? 'detailed';

        const commits = await repo.log({ maxEntries });
        const lines: string[] = [];

        if (!commits || commits.length === 0) {
            return 'Recent commits (HEAD): (no history found)';
        }

        // For style inference, provide clean subject lines so the model can reliably see
        // leading emojis/prefixes without extra metadata (hash/date/author).
        if (format === 'subject') {
            for (const c of commits) {
                const firstLine = (c.message ?? '').split(/\r?\n/, 1)[0].trim();
                if (firstLine) {
                    // Do not add any prefix here; some repos use leading emoji as a semantic prefix.
                    lines.push(firstLine);
                }
            }
            return lines.join('\n');
        }

        lines.push(`Recent commits (HEAD, latest ${commits.length}/${maxEntries}):`);
        for (const c of commits) {
            const date = c.authorDate ? c.authorDate.toISOString().slice(0, 10) : '';
            const author = c.authorName ?? '';
            lines.push(`${c.hash.slice(0, 7)} ${date} ${author} | ${c.message ?? ''}`.trim());
        }

        return lines.join('\n');
    }
}
