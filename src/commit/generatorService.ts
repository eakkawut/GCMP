/*---------------------------------------------------------------------------------------------
 *  Commit Message Generation Service
 *  Calls models via VS Code Language Model API to generate commit messages
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    CommitMessage,
    ProgressReporter,
    ModelNotFoundError,
    EmptyCommitMessageError,
    UserCancelledError,
    CommitChatModelOptions
} from './types';
import { PromptService } from './promptService';
import type { GitDiffParts, GitDiffSection } from './gitService';
import { CompatibleModelManager, ConfigManager, Logger } from '../utils';
import { getRegisteredProvider } from '../utils/providerRegistry';

function throwIfCancelled(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}

/**
 * Commit message generation service class
 * Calls language models via VS Code Language Model API to generate commit messages
 */
export class GeneratorService {
    private static readonly MAX_CONTEXT_CHARS_PER_MESSAGE = 14000;

    private static getEffectiveProviderConfig(providerKey: string) {
        const registeredProvider = getRegisteredProvider(providerKey);
        if (registeredProvider) {
            return registeredProvider.providerConfig;
        }

        const providerConfigs = ConfigManager.getConfigProvider();
        const providerConfig = providerConfigs[providerKey as keyof typeof providerConfigs];
        return providerConfig ? ConfigManager.applyProviderOverrides(providerKey, providerConfig) : undefined;
    }

    /**
     * Get available Commit provider list (providerKey + display name + vendor).
     * Logic references JsonSchemaProvider#getCommitModelSchema:
     * - Built-in providers (provider) + providerOverrides merged
     * - Compatible providers (can include user-defined models)
     */
    static async getAvailableCommitProviders(): Promise<
        Array<{ providerKey: string; displayName: string; vendor: string }>
    > {
        const providerConfigs = ConfigManager.getConfigProvider();
        const results: Array<{ providerKey: string; displayName: string; vendor: string }> = [];

        for (const [providerKey, originalConfig] of Object.entries(providerConfigs)) {
            results.push({
                providerKey,
                displayName: originalConfig.displayName || providerKey,
                vendor: `ccmp.${providerKey}`
            });
        }

        // Compatible provider (providerKey = compatible)
        if (!results.some(p => p.providerKey === 'compatible')) {
            results.push({
                providerKey: 'compatible',
                displayName: 'OpenAI / Anthropic Compatible',
                vendor: 'ccmp.compatible'
            });
        }

        return results;
    }

    /**
     * Get available model list under a provider (for UI dropdown).
     * - Built-in providers (provider): use effectiveConfig.models after applyProviderOverrides
     * - compatible: use CompatibleModelManager.getModels()
     */
    static async getAvailableCommitModelsForProvider(
        providerKey: string
    ): Promise<Array<{ id: string; name: string }>> {
        const key = (providerKey || '').trim();
        if (!key) {
            return [];
        }

        if (key === 'compatible') {
            return CompatibleModelManager.getModels()
                .map(m => ({ id: m.id, name: m.name || m.id }))
                .filter(m => Boolean(m.id));
        }

        const effectiveConfig = this.getEffectiveProviderConfig(key);
        if (!effectiveConfig) {
            return [];
        }

        return (effectiveConfig.models ?? []).map(m => ({ id: m.id, name: m.name || m.id })).filter(m => Boolean(m.id));
    }

    /**
     * Generate commit messages (segmented diff):
     * One User message per file for staged/tracked/untracked.
     */
    static async generateCommitMessages(
        diffParts: GitDiffParts,
        blameAnalysis: string,
        recentCommitHistory: string,
        progress: ProgressReporter,
        token: vscode.CancellationToken
    ): Promise<CommitMessage> {
        // 1) Select model
        progress.report({ message: 'Selecting model...', increment: 8 });
        const model = await this.selectModel();
        throwIfCancelled(token);

        // 2) Assemble diff context (one message per file)
        progress.report({ message: 'Extracting key change snippets...', increment: 10 });
        const messages: vscode.LanguageModelChatMessage[] = [];

        // System Role message: some models require the first message to be system role
        messages.push(
            new vscode.LanguageModelChatMessage(
                vscode.LanguageModelChatMessageRole.System,
                PromptService.generateCommitSystemMessage()
            )
        );

        messages.push(...this.buildPerFileAttachmentMessages(diffParts.staged, 'staged'));
        messages.push(...this.buildPerFileAttachmentMessages(diffParts.tracked, 'tracked'));
        messages.push(...this.buildPerFileAttachmentMessages(diffParts.untracked, 'untracked'));

        const blameContext = (blameAnalysis ?? '').trim();
        if (blameContext) {
            // Separate user message: historical context related to file changes (for understanding modification content).
            messages.push(
                vscode.LanguageModelChatMessage.User(`Blame analysis (changed files reference):\n\n${blameContext}`)
            );
        }

        const commitConfig = ConfigManager.getCommitConfig();
        const repoHistory = (recentCommitHistory ?? '').trim();
        if (commitConfig.format === 'auto' && repoHistory) {
            // Separate user message: repository-level recent commit history (unrelated to files), used for auto inference of commit conventions.
            messages.push(
                vscode.LanguageModelChatMessage.User(
                    `Recent commit history (repository-wide, last 50, for style inference):\n\n${repoHistory}`
                )
            );
        }

        const finalPrompt = PromptService.generateCommitPrompt();

        const diffNoticeParts: string[] = [];
        if (diffParts.staged.diff.length > 0) {
            diffNoticeParts.push('Staged diff excerpts have been provided in previous messages. Please use them.');
        }
        if (diffParts.tracked.diff.length > 0) {
            diffNoticeParts.push('Tracked diff excerpts have been provided in previous messages. Please use them.');
        }
        if (diffParts.untracked.diff.length > 0) {
            diffNoticeParts.push(
                'Untracked new file excerpts have been provided in previous messages. Please use them.'
            );
        }
        if (diffNoticeParts.length === 0) {
            diffNoticeParts.push('No diff excerpts were provided.');
        }

        messages.push(
            vscode.LanguageModelChatMessage.User(
                `${diffNoticeParts.join('\n')}` +
                `${blameContext ? '\nBlame analysis has also been provided in a previous message. Please use it as context.' : ''}` +
                `${commitConfig.format === 'auto' && repoHistory ? '\nRepository-wide recent commit history has also been provided in a previous message. Please use it to infer the style.' : ''}` +
                `\n\n${finalPrompt}`
            )
        );

        // 3) Generate final commit message
        progress.report({ message: `Generating commit message using ${model.name}...`, increment: 20 });
        const message = await this.callModelWithMessages(model, messages, progress, token);

        // 4) Post-processing
        progress.report({ message: 'Processing results...', increment: 10 });
        const cleanedMessage = PromptService.normalizeCommitMessage(message);

        // 5) Validate message
        if (!cleanedMessage.trim()) {
            throw new EmptyCommitMessageError();
        }

        return {
            message: cleanedMessage,
            model: model.name
        };
    }

    private static buildPerFileAttachmentMessages(
        section: GitDiffSection,
        label: string
    ): vscode.LanguageModelChatMessage[] {
        const messages: vscode.LanguageModelChatMessage[] = [];

        const total = Math.max(section.diff.length, section.uri.length);
        for (let i = 0; i < total; i++) {
            const fileUri = section.uri[i];
            const diffText = section.diff[i] ?? '';

            if (!diffText.trim()) {
                continue;
            }

            const fileLine = fileUri ? `File: ${fileUri.fsPath}` : 'File: (unknown)';

            // Guardrail: ensure a single message doesn't exceed our context chunk budget.
            const overhead = 600;
            const maxExcerpt = Math.max(0, this.MAX_CONTEXT_CHARS_PER_MESSAGE - overhead);
            let excerpt = diffText;
            if (excerpt.length > maxExcerpt) {
                excerpt = excerpt.slice(0, maxExcerpt) + '\n... [message truncated]';
            }

            const text = [
                `Attachment ${i + 1}/${total}: diff excerpt (${label})`,
                fileLine,
                '```diff',
                excerpt,
                '```'
            ].join('\n');

            messages.push(vscode.LanguageModelChatMessage.User(text));
        }

        return messages;
    }

    /**
     * Select language model
     */
    private static async selectModel(): Promise<vscode.LanguageModelChat> {
        const resolveConfiguredModel = async (
            selection: { provider?: string; model?: string } | undefined
        ): Promise<vscode.LanguageModelChat | null> => {
            const provider = (selection?.provider ?? '').trim();
            const modelId = (selection?.model ?? '').trim();
            if (!provider || !modelId) {
                return null;
            }

            try {
                const candidates = await vscode.lm.selectChatModels({
                    id: modelId,
                    vendor: `ccmp.${provider}`
                });
                return candidates?.[0] ?? null;
            } catch {
                // Query failure treated as model unavailable
                return null;
            }
        };

        /**
         * Independent branch: handles special scenarios for autoPrefixModelId and compatible providers.
         * - When autoPrefixModelId is enabled, query ID needs to add `${provider}:::${modelId}` prefix
         * - Compatible providers: first get model list from CompatibleModelManager for matching, then construct query
         * Returns null when no special scenarios involved, handed to original process.
         */
        const resolveConfiguredModelCompat = async (
            selection: { provider?: string; model?: string } | undefined
        ): Promise<vscode.LanguageModelChat | null> => {
            const provider = (selection?.provider ?? '').trim();
            const modelId = (selection?.model ?? '').trim();
            if (!provider || !modelId) {
                return null;
            }

            const autoPrefix = ConfigManager.getAutoPrefixModelId();
            const isCompatible = provider === 'compatible';
            if (!autoPrefix && !isCompatible) {
                return null;
            }

            try {
                if (isCompatible) {
                    const models = CompatibleModelManager.getModels();
                    const matched = models.find(m => m.id === modelId);
                    if (!matched) {
                        return null;
                    }
                    const queryId = autoPrefix ? `${matched.provider || 'compatible'}:::${modelId}` : modelId;
                    const candidates = await vscode.lm.selectChatModels({
                        id: queryId,
                        vendor: 'ccmp.compatible'
                    });
                    return candidates?.[0] ?? null;
                }

                // autoPrefix enabled but not compatible: need to check if model has independent provider field
                const effectiveConfig = this.getEffectiveProviderConfig(provider);
                const matchedModel = effectiveConfig?.models.find(m => m.id === modelId);
                const actualProvider = matchedModel?.provider || provider;
                const queryId = `${actualProvider}:::${modelId}`;
                const candidates = await vscode.lm.selectChatModels({
                    id: queryId,
                    vendor: `ccmp.${provider}`
                });
                return candidates?.[0] ?? null;
            } catch {
                return null;
            }
        };

        /**
         * Comprehensive resolution: first try compat branch, fallback to original process on miss.
         */
        const resolveModel = async (
            selection: { provider?: string; model?: string } | undefined
        ): Promise<vscode.LanguageModelChat | null> => {
            return (await resolveConfiguredModelCompat(selection)) ?? (await resolveConfiguredModel(selection));
        };

        // 1) Prioritize using configured and available model
        const configuredSelection = ConfigManager.getCommitConfig().model;
        const configuredModel = await resolveModel(configuredSelection);
        if (configuredModel) {
            Logger.trace(`[GeneratorService] Using configured model: ${configuredModel.name}`);
            return configuredModel;
        }

        // 2) Model not configured or configuration invalid: popup model selection wizard, retry after successful selection
        const before = JSON.stringify(configuredSelection ?? {});
        await vscode.commands.executeCommand('ccmp.commit.selectModel');

        const afterSelection = ConfigManager.getCommitConfig().model;
        const after = JSON.stringify(afterSelection ?? {});
        if (after === before) {
            // User did not update configuration (usually indicates cancel/close wizard)
            throw new UserCancelledError();
        }

        const selectedModel = await resolveModel(afterSelection);
        if (selectedModel) {
            Logger.trace(`[GeneratorService] Using user-selected model: ${selectedModel.name}`);
            return selectedModel;
        }

        const providerKey =
            (afterSelection?.provider ?? configuredSelection?.provider ?? '(not specified)').trim() || '(not specified)';
        const modelId = (afterSelection?.model ?? configuredSelection?.model ?? '(not specified)').trim() || '(not specified)';
        throw new ModelNotFoundError(
            `Configured model "${providerKey}:${modelId}" is unavailable or not enabled.` +
            'Please run "CCMP: Select Commit Model" to reselect, or check if the corresponding provider model is enabled.'
        );
    }

    /**
     * Call language model
     */
    private static async callModelWithMessages(
        model: vscode.LanguageModelChat,
        messages: vscode.LanguageModelChatMessage[],
        progress: ProgressReporter,
        token: vscode.CancellationToken
    ): Promise<string> {
        try {
            // Send request
            const response = await model.sendRequest(
                messages,
                { modelOptions: { commit: true } as CommitChatModelOptions },
                token
            );

            // Collect response
            let result = '';
            for await (const chunk of response.text) {
                if (token.isCancellationRequested) {
                    throw new vscode.CancellationError();
                }
                result += chunk;
                // Update progress
                if (result.length % 100 === 0) {
                    progress.report({ message: `Generating... (${result.length} characters)`, increment: 1 });
                }
            }

            Logger.trace(`[GeneratorService] Model response length: ${result.length} characters`);
            return result;
        } catch (error) {
            Logger.error('[GeneratorService] Model call failed:', error);

            // Check if it is user cancellation
            if (error instanceof vscode.CancellationError) {
                throw error;
            }

            // Check if it is a permission issue
            if (error instanceof Error && error.message.includes('access')) {
                throw new Error('Unable to access language model. Please ensure you have permission to use this model, or try selecting another model.');
            }

            throw new Error(`Failed to generate commit message: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
