/*---------------------------------------------------------------------------------------------
 *  CommitMessage
 *  UI Coordinator: responsible for progress display, repository selection, writing to input box and feedback.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { GeneratorService } from './generatorService';
import {
    UserCancelledError,
    NoChangesDetectedError,
    NoRepositoriesFoundError,
    GitExtensionNotFoundError,
    ModelNotFoundError
} from './types';
import { ConfigManager, Logger } from '../utils';
import { Repository } from '../types/git';

/**
 * CommitMessage - UI coordinator for commit message generation.
 */
export class CommitMessage {
    private static isGenerating: boolean = false;

    private static normalizeFsPath(p: string): string {
        // On Windows, fsPath is case-insensitive, normalize for matching.
        const normalized = path
            .normalize(p)
            .replace(/[\\/]+/g, path.sep)
            .toLowerCase();

        // Remove trailing separator (preserve drive root like c:\)
        let out = normalized;
        while (out.length > 3 && out.endsWith(path.sep)) {
            out = out.slice(0, -1);
        }
        return out;
    }

    private static isSameOrChildPath(target: string, root: string): boolean {
        if (target === root) {
            return true;
        }
        if (!target.startsWith(root)) {
            return false;
        }
        const next = target.charAt(root.length);
        return next === path.sep;
    }

    private static throwIfCancelled(token: vscode.CancellationToken): void {
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
    }

    /**
     * Generate and set commit message (main entry point).
     *
     * Responsibilities:
     * - UI coordination: progress display, repository selection, writing to Git input box, feedback
     * - Business logic: completed within this class (diff/blame/generation), avoiding cross-file jumps
     *
     * Parameters:
     * - sourceControlRepository: Repository object passed from VS Code Git extension; if not provided, automatically selected (single repo used directly, multiple repos matched by resContext, otherwise popup selection).
     * - options.scope: Controls analysis scope
     *   - undefined (default): prioritize reading staged changes, fallback to unstaged working tree if no staged changes
     *   - 'staged': Only analyze staged changes, no fallback
     *   - 'workingTree': Only analyze working tree changes (tracked + untracked), excluding staged
     * - options.resContext: ResourceGroup often carried by SCM menu/button callbacks, used to infer current repository in multi-repository scenarios.
     *
     * Cancellation:
     * - Progress notification supports cancellation; cancellation throws vscode.CancellationError and is handled silently.
     */
    static async generateAndSetCommitMessage(
        sourceControlRepository?: Repository,
        options?: { scope?: 'staged' | 'workingTree'; resContext?: vscode.SourceControlResourceGroup }
    ): Promise<void> {
        if (this.isGenerating) {
            vscode.window.showInformationMessage('Generating commit message, please wait or click "Stop" to abort');
            return;
        }

        this.isGenerating = true;

        try {
            // Progress display should start early to avoid perceived delay of "unresponsive" after click
            await this.executeWithProgress(async (progress, token) => {
                // 1. Initialize and validate
                progress.report({ message: 'Initializing...', increment: 2 });
                await this.initializeAndValidate();
                this.throwIfCancelled(token);

                // 2. Select repository
                progress.report({ message: 'Selecting repository...', increment: 3 });
                if (!sourceControlRepository) {
                    const repos = await GitService.getRepositories();
                    this.throwIfCancelled(token);

                    // When there is only one repository, use it directly to avoid unnecessary path inference.
                    if (repos.length === 1) {
                        sourceControlRepository = repos[0];
                    } else {
                        // SCM menu (title/resourceGroup/title etc.) usually passes the current SourceControl/ResourceGroup as a parameter.
                        // SourceControlResourceGroup does not have rootUri/provider, but resourceStates has resourceUri.
                        // Infer the current repository through the first resource's resourceUri.fsPath.
                        const first = options?.resContext?.resourceStates?.[0];
                        const fsPath = first?.resourceUri?.fsPath;
                        const rootFsPath = typeof fsPath === 'string' && fsPath.trim() ? fsPath.trim() : undefined;
                        if (rootFsPath) {
                            const target = this.normalizeFsPath(rootFsPath);
                            const matched = repos
                                .map(r => ({ r, root: this.normalizeFsPath(r.rootUri.fsPath) }))
                                // rootFsPath could be either repo root or a path to a changed file.
                                .filter(x => this.isSameOrChildPath(target, x.root))
                                // For nested repositories, select the one with longer (more specific) path.
                                .sort((a, b) => b.root.length - a.root.length)[0]?.r;
                            if (matched) {
                                sourceControlRepository = matched;
                            }
                        }

                        if (!sourceControlRepository) {
                            sourceControlRepository = await GitService.selectRepository(repos);
                        }
                    }
                }

                this.throwIfCancelled(token);

                // 3. Generate commit message
                const commitMessage = await this.generateCommitMessage(
                    progress,
                    sourceControlRepository!,
                    token,
                    options?.scope
                );
                this.throwIfCancelled(token);

                // 4. Apply commit message
                progress.report({ message: 'Applying commit message...', increment: 10 });
                sourceControlRepository!.inputBox.value = commitMessage.message;
                const sourceLabel: Record<string, string> = {
                    staged: 'Staged',
                    workingTree: 'Working Tree'
                };
                vscode.window.showInformationMessage(`Commit message generated (based on ${sourceLabel[commitMessage.diffSource]})`);

                Logger.info(
                    `[CommitMessage] Commit message generated [${commitMessage.diffSource}]: ${commitMessage.message.substring(0, 50)}...`
                );
            });
        } catch (error: unknown) {
            await this.handleError(error);
        } finally {
            this.isGenerating = false;
        }
    }

    /**
     * Initialize and validate
     */
    private static async initializeAndValidate(): Promise<void> {
        if (!vscode.workspace.workspaceFolders) {
            throw new Error('No workspace opened');
        }
        // Validate Git extension
        await GitService.validateGitExtension();
    }

    /**
     * Business flow: generate commit message (diff/blame/generation).
     *
     * scope values:
     * - undefined (default): prioritize reading staged changes, auto fallback to unstaged working tree if no staged changes
     * - 'staged': Only analyze staged changes (no fallback)
     * - 'workingTree': Only analyze working tree changes (tracked + untracked), excluding staged
     */
    private static async generateCommitMessage(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        repository: Repository,
        token: vscode.CancellationToken,
        scope?: 'staged' | 'workingTree'
    ): Promise<{ message: string; model: string; diffSource: 'staged' | 'workingTree' }> {
        const repoPath = repository.rootUri.fsPath;
        const commitConfig = ConfigManager.getCommitConfig();

        // 1. Get Git changes
        progress.report({ message: 'Analyzing Git changes...', increment: 10 });
        let diffParts: Awaited<ReturnType<typeof GitService.getDiff>>;

        /** Actual diff source dimension used, for user notification */
        let diffSource: 'staged' | 'workingTree';

        if (scope === 'staged') {
            // Explicit staged only: no fallback
            diffParts = await GitService.getDiff(repoPath, true, token);
            diffSource = 'staged';
        } else if (scope === 'workingTree') {
            // Working tree only: tracked + untracked, excluding staged
            diffParts = await GitService.getDiff(repoPath, false, token);
            diffParts = {
                staged: { uri: [], diff: [] },
                tracked: diffParts.tracked,
                untracked: diffParts.untracked
            };
            diffSource = 'workingTree';
        } else {
            // Default: prioritize staged, auto fallback to unstaged working tree when no staged changes
            try {
                diffParts = await GitService.getDiff(repoPath, true, token);
                diffSource = 'staged';
            } catch (error) {
                if (error instanceof NoChangesDetectedError) {
                    Logger.info('[CommitMessage] No staged changes, auto fallback to unstaged working tree');
                    diffParts = await GitService.getDiff(repoPath, false, token);
                    diffSource = 'workingTree';
                } else {
                    throw error;
                }
            }
        }
        this.throwIfCancelled(token);

        // 2. File change related history (for understanding modification content; unrelated to "style inference")
        progress.report({ message: 'Analyzing file change history...', increment: 10 });
        const blameAnalysis = await this.analyzeChanges(repoPath, diffParts, token);
        this.throwIfCancelled(token);

        // 3. Repository level recent 50 commit history (unrelated to files; only used for auto inference of commit conventions)
        // auto uses subjects-only, to preserve possible "leading emoji" in repository style.
        let recentCommitHistory = '';
        if (commitConfig.format === 'auto') {
            progress.report({ message: 'Fetching recent repository commit history...', increment: 10 });
            recentCommitHistory = await GitService.getRecentCommits(repoPath, token, {
                maxEntries: 50,
                format: 'subject'
            });
            this.throwIfCancelled(token);
        }

        // 4. Generate commit message
        const commitMessage = await GeneratorService.generateCommitMessages(
            diffParts,
            blameAnalysis,
            recentCommitHistory,
            progress,
            token
        );
        this.throwIfCancelled(token);

        return { ...commitMessage, diffSource };
    }

    /**
     * Analyze history of code changes (for providing context).
     */
    private static async analyzeChanges(
        repoPath: string,
        diffParts: Awaited<ReturnType<typeof GitService.getDiff>>,
        token: vscode.CancellationToken
    ): Promise<string> {
        try {
            const toRepoRelative = (u: vscode.Uri): string => {
                const rel = path.relative(repoPath, u.fsPath);
                return rel.split(path.sep).join('/');
            };

            const trackedFiles = [...diffParts.staged.uri, ...diffParts.tracked.uri]
                .map(toRepoRelative)
                .map(p => p.trim())
                .filter(p => p && !p.startsWith('..'));

            const untrackedFiles = diffParts.untracked.uri
                .map(toRepoRelative)
                .map(p => p.trim())
                .filter(p => p && !p.startsWith('..'));

            const trackedUnique = [...new Set(trackedFiles)];
            const untrackedUnique = [...new Set(untrackedFiles)];

            if (trackedUnique.length === 0 && untrackedUnique.length === 0) {
                return 'No files to analyze';
            }

            // Separate "untracked new files" and "history context":
            // - untracked files have no HEAD history themselves, mixing them would cause context noise
            // - tracked files need to pull recent commit history
            const lines: string[] = [];
            if (trackedUnique.length > 0) {
                lines.push('Changed files (tracked):');
                lines.push(`- ${trackedUnique.join('\n- ')}`);
            }

            if (untrackedUnique.length > 0) {
                if (lines.length > 0) {
                    lines.push('');
                }
                lines.push('Untracked new files:');
                lines.push(`- ${untrackedUnique.join('\n- ')}`);
            }

            if (trackedUnique.length > 0) {
                const history = await GitService.getRecentCommitsForFiles(repoPath, trackedUnique, token);
                lines.push('');
                lines.push('Recent commits (HEAD, tracked files only):');
                lines.push(history);
            }

            return lines.join('\n').trim();
        } catch (error) {
            Logger.warn('[CommitMessage] Blame analysis failed:', error);
            return 'Blame analysis not available';
        }
    }

    /**
     * Execute operation with progress display
     */
    private static async executeWithProgress(
        action: (
            progress: vscode.Progress<{ message?: string; increment?: number }>,
            token: vscode.CancellationToken
        ) => Promise<void>
    ): Promise<void> {
        // Dual channel progress display:
        // - SCM view displays in-progress progress bar (does not support title/message/cancel)
        // - Notification popup displays cancellable detailed progress information
        await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, async () => {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'CCMP Commit',
                    cancellable: true
                },
                async (progress, token) => {
                    await action(progress, token);
                }
            );
        });
    }

    /**
     * Handle errors
     */
    private static async handleError(error: unknown): Promise<void> {
        // User cancelled - handle silently
        if (error instanceof UserCancelledError) {
            Logger.trace('[CommitMessage] User cancelled operation');
            return;
        }
        // VS Code cancellation
        if (error instanceof vscode.CancellationError) {
            Logger.trace('[CommitMessage] Operation cancelled');
            return;
        }
        // No changes
        if (error instanceof NoChangesDetectedError) {
            vscode.window.showWarningMessage('No changes detected that need to be committed');
            return;
        }
        // No repositories
        if (error instanceof NoRepositoriesFoundError) {
            vscode.window.showWarningMessage('No Git repository found');
            return;
        }
        // Git extension not found
        if (error instanceof GitExtensionNotFoundError) {
            vscode.window.showErrorMessage('Git extension not found or not activated');
            return;
        }
        // Model not found
        if (error instanceof ModelNotFoundError) {
            vscode.window.showErrorMessage(error.message);
            return;
        }
        // Other errors
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error('[CommitMessage] Generation failed:', error);
        vscode.window.showErrorMessage(`Failed to generate commit message: ${errorMessage}`);
    }
}
