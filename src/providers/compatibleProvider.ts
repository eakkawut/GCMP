/*---------------------------------------------------------------------------------------------
 *  Standalone Compatible Provider
 *  Extends GenericModelProvider, overriding necessary methods to support fully user-configurable
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    ProvideLanguageModelChatResponseOptions,
    Progress
} from 'vscode';
import { ProviderConfig, ModelConfig, ModelOverride } from '../types/sharedTypes';
import { Logger, ApiKeyManager, CompatibleModelManager } from '../utils';
import { TokenUsagesManager } from '../usages/usagesManager';
import { GenericModelProvider } from './genericModelProvider';
import { StatusBarManager } from '../status';
import { KnownProviders } from '../utils';
import { configProviders } from './config';

/**
 * Standalone Compatible Model Provider Class
 * Extends GenericModelProvider, overriding model configuration retrieval method
 */
export class CompatibleProvider extends GenericModelProvider {
    private static readonly PROVIDER_KEY = 'compatible';
    private modelsChangeListener?: vscode.Disposable;

    constructor(context: vscode.ExtensionContext) {
        // Create a virtual ProviderConfig, actual model configuration is retrieved from CompatibleModelManager
        const virtualConfig: ProviderConfig = {
            displayName: 'Compatible',
            baseUrl: 'https://api.openai.com/v1', // Default value, will be overridden in actual use
            apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            models: [] // Empty model list, actually retrieved from CompatibleModelManager
        };
        super(context, CompatibleProvider.PROVIDER_KEY, virtualConfig);

        this.getProviderConfig(); // Initialize configuration cache
        // Listen to CompatibleModelManager change events
        this.modelsChangeListener = CompatibleModelManager.onDidChangeModels(() => {
            Logger.debug('[compatible] Received model change event, refreshing configuration and cache');
            this.getProviderConfig(); // Refresh configuration cache
            // Clear model cache
            this.modelInfoCache
                ?.invalidateCache(CompatibleProvider.PROVIDER_KEY)
                .catch(err => Logger.warn('[compatible] Failed to clear cache:', err));
            this._onDidChangeLanguageModelChatInformation.fire();
            Logger.debug('[compatible] Language model information change event triggered');
        });
    }

    override dispose(): void {
        this.modelsChangeListener?.dispose();
        super.dispose();
    }

    /**
     * Override: Get dynamic provider configuration
     * Retrieve user-configured models from CompatibleModelManager
     */
    getProviderConfig(): ProviderConfig {
        try {
            const models = CompatibleModelManager.getModels();
            // Convert CompatibleModelManager's models to ModelConfig format
            const modelConfigs: ModelConfig[] = models.map(model => {
                let customHeader = model.customHeader;
                if (model.provider) {
                    const provider = KnownProviders[model.provider];
                    if (provider?.customHeader) {
                        const existingHeaders = model.customHeader || {};
                        customHeader = { ...existingHeaders, ...provider.customHeader };
                    }

                    let knownOverride: Omit<ModelOverride, 'id'> | undefined;
                    if (model.sdkMode === 'anthropic' && provider?.anthropic) {
                        knownOverride = provider.anthropic;
                    } else if (model.sdkMode !== 'anthropic' && provider?.openai) {
                        knownOverride = provider.openai.extraBody;
                    }

                    if (knownOverride) {
                        const extraBody = knownOverride.extraBody || {};
                        const modelBody = model.extraBody || {};
                        model.extraBody = { ...extraBody, ...modelBody };
                    }
                }
                return {
                    id: model.id,
                    name: model.name,
                    provider: model.provider,
                    tooltip: model.tooltip || `${model.name} (${model.sdkMode})`,
                    maxInputTokens: model.maxInputTokens,
                    maxOutputTokens: model.maxOutputTokens,
                    sdkMode: model.sdkMode,
                    capabilities: model.capabilities,
                    ...(model.baseUrl && { baseUrl: model.baseUrl }),
                    ...(model.endpoint && { endpoint: model.endpoint }),
                    ...(model.model && { model: model.model }),
                    ...(customHeader && { customHeader: customHeader }),
                    ...(model.extraBody && { extraBody: model.extraBody }),
                    ...(model.useInstructions !== undefined && { useInstructions: model.useInstructions }),
                    ...(model.webSearchTool !== undefined && { webSearchTool: model.webSearchTool }),
                    ...(model.family && { family: model.family }),
                    ...(model.thinking && { thinking: model.thinking }),
                    ...(model.thinkingFormat && { thinkingFormat: model.thinkingFormat }),
                    ...(model.reasoningEffort && { reasoningEffort: model.reasoningEffort })
                };
            });

            Logger.debug(`Compatible Provider loaded ${modelConfigs.length} user-configured models`);

            this.cachedProviderConfig = {
                displayName: 'Compatible',
                baseUrl: 'https://api.openai.com/v1', // Default value, model-level configuration will override
                apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                models: modelConfigs
            };
        } catch (error) {
            Logger.error('Failed to get Compatible Provider configuration:', error);
            // Return basic configuration as fallback
            this.cachedProviderConfig = {
                displayName: 'Compatible',
                baseUrl: 'https://api.openai.com/v1',
                apiKeyTemplate: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                models: []
            };
        }
        return this.cachedProviderConfig;
    }

    /**
     * Override: Provide language model chat information
     * Directly get the latest dynamic configuration, not dependent on configuration at construction
     * Check API Keys for all providers involved in all models
     * Integrate model caching mechanism to improve performance
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        try {
            // Get API key hash for cache validation
            const apiKeyHash = await this.getApiKeyHash();

            // Fast path: Check cache
            const cachedModels = await this.modelInfoCache?.getCachedModels(
                CompatibleProvider.PROVIDER_KEY,
                apiKeyHash
            );
            if (options.silent && cachedModels) {
                Logger.trace(`✓ Compatible Provider cache hit: ${cachedModels.length} models`);

                // Asynchronously update cache in background
                this.updateModelCacheAsync(apiKeyHash);
                return cachedModels;
            }

            // Get latest dynamic configuration
            const currentConfig = this.providerConfig;
            // If no models, directly return empty list
            if (currentConfig.models.length === 0) {
                // Asynchronously trigger add model flow, but do not block configuration retrieval
                if (!options.silent) {
                    setImmediate(async () => {
                        try {
                            await CompatibleModelManager.configureModelOrUpdateAPIKey();
                        } catch {
                            Logger.debug('Automatically triggered add model failed or was cancelled by user');
                        }
                    });
                }
                return [];
            } else if (options.silent === false) {
                await CompatibleModelManager.configureModelOrUpdateAPIKey();
            }

            // Convert models in latest configuration to VS Code required format
            const modelInfos = currentConfig.models.map(model => {
                const info = this.modelConfigToInfo(model);
                const sdkModeDisplay = CompatibleModelManager.getSdkModeLabel(model.sdkMode);

                if (model.provider) {
                    const knownProvider = KnownProviders[model.provider];
                    if (knownProvider?.displayName) {
                        return { ...info, detail: knownProvider.displayName };
                    }
                    const provider = configProviders[model.provider as keyof typeof configProviders];
                    if (provider?.displayName) {
                        return { ...info, detail: provider.displayName };
                    }
                }

                return { ...info, detail: `${sdkModeDisplay} Compatible` };
            });

            Logger.debug(`Compatible Provider provided ${modelInfos.length} model information`); // Asynchronously update cache in background
            this.updateModelCacheAsync(apiKeyHash);

            return modelInfos;
        } catch (error) {
            Logger.error('Failed to get Compatible Provider model information:', error);
            return [];
        }
    }

    /**
     * Override: Asynchronously update model cache
     * Need to correctly set detail field to display SDK mode
     */
    protected override updateModelCacheAsync(apiKeyHash: string): void {
        (async () => {
            try {
                const currentConfig = this.providerConfig;

                const models = currentConfig.models.map(model => {
                    const info = this.modelConfigToInfo(model);
                    const sdkModeDisplay = CompatibleModelManager.getSdkModeLabel(model.sdkMode);

                    if (model.provider) {
                        const knownProvider = KnownProviders[model.provider];
                        if (knownProvider?.displayName) {
                            return { ...info, detail: knownProvider.displayName };
                        }
                        const provider = configProviders[model.provider as keyof typeof configProviders];
                        if (provider?.displayName) {
                            return { ...info, detail: provider.displayName };
                        }
                    }

                    return { ...info, detail: `${sdkModeDisplay} Compatible` };
                });

                await this.modelInfoCache?.cacheModels(CompatibleProvider.PROVIDER_KEY, models, apiKeyHash);
            } catch (err) {
                Logger.trace('[compatible] Background cache update failed:', err instanceof Error ? err.message : String(err));
            }
        })();
    }

    /**
     * Get provider's display name
     * @param providerKey Provider's key
     * @returns Provider's display name, returns providerKey if not found
     */
    private getProviderDisplayName(providerKey: string): string {
        // First look up in KnownProviders
        const knownProvider = KnownProviders[providerKey];
        if (knownProvider?.displayName) {
            return knownProvider.displayName;
        }

        // Then look up in configProviders
        const provider = configProviders[providerKey as keyof typeof configProviders];
        if (provider?.displayName) {
            return provider.displayName;
        }

        // If not found, return the key itself
        return providerKey;
    }

    /**
     * Override: Provide language model chat response
     * Use latest dynamic configuration to process requests, and add failure retry mechanism
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        try {
            // Get latest dynamic configuration
            const currentConfig = this.providerConfig;

            // Find corresponding model configuration
            // Find corresponding model configuration
            const modelConfig = this.findModelConfigById(model);
            if (!modelConfig) {
                const errorMessage = `Compatible Provider model not found: ${model.id}`;
                Logger.error(errorMessage);
                throw new Error(errorMessage);
            }

            // Check API key (use throwError: false to allow silent failure)
            const hasValidKey = await ApiKeyManager.ensureApiKey(
                modelConfig.provider!,
                currentConfig.displayName,
                false
            );
            if (!hasValidKey) {
                throw new Error(`API key for model ${modelConfig.name} has not been set`);
            }

            // Select handler based on model's sdkMode
            const sdkMode = modelConfig.sdkMode || 'openai';
            const sdkName = this.getSdkDisplayName(sdkMode);
            Logger.info(`Compatible Provider starting to process request (${sdkName}): ${modelConfig.name}`);

            // Calculate input token count and update status bar
            const totalInputTokens = await this.updateContextUsageStatusBar(model, messages, modelConfig, options);

            // === Token Statistics: Record estimated token ===
            let requestId: string | null = null;
            try {
                const usagesManager = TokenUsagesManager.instance;

                // Get actual provider's key and display name
                const actualProviderKey = modelConfig.provider || this.providerKey;
                const actualDisplayName = modelConfig.provider
                    ? this.getProviderDisplayName(modelConfig.provider)
                    : currentConfig.displayName;

                requestId = await usagesManager.recordEstimatedTokens({
                    providerKey: actualProviderKey,
                    displayName: actualDisplayName,
                    modelId: model.id,
                    modelName: model.name,
                    estimatedInputTokens: totalInputTokens
                });
            } catch (err) {
                Logger.warn('Failed to record estimated Token:', err);
            }

            try {
                await this.executeModelRequest(
                    model,
                    modelConfig,
                    messages,
                    options,
                    progress,
                    token,
                    requestId,
                    modelConfig.provider || this.providerKey
                );
            } catch (error) {
                const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
                Logger.error(errorMessage);

                // === Token Statistics: Update failed status ===
                if (requestId) {
                    try {
                        const usagesManager = TokenUsagesManager.instance;
                        await usagesManager.updateActualTokens({
                            requestId,
                            status: 'failed'
                        });
                    } catch (err) {
                        Logger.warn('Failed to update Token statistics:', err);
                    }
                }

                throw error;
            } finally {
                Logger.info(`✅ Compatible Provider: ${model.name} request completed`);
                // Delayed update status bar to reflect latest balance
                StatusBarManager.compatible?.delayedUpdate(modelConfig.provider!, 2000);
            }
        } catch (error) {
            Logger.error('Compatible Provider failed to process request:', error);
            throw error;
        }
    }

    /**
     * Register commands
     */
    private static registerCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
        const disposables: vscode.Disposable[] = [];
        // Register manageModels command
        disposables.push(
            vscode.commands.registerCommand('ccmp.compatible.manageModels', async () => {
                try {
                    await CompatibleModelManager.configureModelOrUpdateAPIKey();
                } catch (error) {
                    Logger.error('Failed to manage Compatible models:', error);
                    vscode.window.showErrorMessage(
                        `Failed to manage models: ${error instanceof Error ? error.message : 'Unknown error'}`
                    );
                }
            })
        );
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        Logger.debug('Compatible Provider commands registered');
        return disposables;
    }

    /**
     * Static Factory Method - Create and Activate Provider
     */
    static createAndActivate(context: vscode.ExtensionContext): {
        provider: CompatibleProvider;
        disposables: vscode.Disposable[];
    } {
        Logger.trace('Compatible Provider Activated!');
        // Create provider instance
        const provider = new CompatibleProvider(context);
        // Register language model chat provider
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider('ccmp.compatible', provider);
        // Register commands
        const commandDisposables = this.registerCommands(context);
        const disposables = [providerDisposable, ...commandDisposables];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }
}
