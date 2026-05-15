/*---------------------------------------------------------------------------------------------
 *  Generic Provider Class
 *  Dynamically creates provider implementation based on configuration file
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    CancellationToken,
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatProvider,
    PrepareLanguageModelChatModelOptions,
    ProvideLanguageModelChatResponseOptions,
    Progress
} from 'vscode';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import {
    ApiKeyManager,
    ConfigManager,
    filterAbortedAssistantMessages,
    Logger,
    ModelInfoCache,
    PromptAnalyzer,
    RetryManager,
    TokenCounter
} from '../utils';
import type { RetryableError } from '../utils';
import { OpenAIHandler } from '../handlers/openaiHandler';
import { OpenAICustomHandler } from '../handlers/openaiCustomHandler';
import { AnthropicHandler } from '../handlers/anthropicHandler';
import { GeminiHandler } from '../handlers/geminiHandler';
import { ContextUsageStatusBar } from '../status/contextUsageStatusBar';
import { TokenUsagesManager } from '../usages/usagesManager';
import { OpenAIResponsesHandler } from '../handlers/openaiResponsesHandler';
import { JSONSchema7 } from 'json-schema';

/**
 * Generic Model Provider Class
 * Dynamically creates provider implementation based on configuration file
 */
export class GenericModelProvider implements LanguageModelChatProvider {
    protected readonly openaiHandler: OpenAIHandler;
    protected readonly openaiCustomHandler: OpenAICustomHandler;
    protected readonly openaiResponsesHandler: OpenAIResponsesHandler;
    protected readonly anthropicHandler: AnthropicHandler;
    protected readonly geminiHandler: GeminiHandler;
    protected readonly providerKey: string;
    protected baseProviderConfig: ProviderConfig; // protected to support subclass access
    protected cachedProviderConfig: ProviderConfig; // Cached configuration
    protected configListener?: vscode.Disposable; // Configuration listener
    protected modelInfoCache?: ModelInfoCache; // Model information cache

    // Model information change event
    protected _onDidChangeLanguageModelChatInformation = new vscode.EventEmitter<void>();
    readonly onDidChangeLanguageModelChatInformation = this._onDidChangeLanguageModelChatInformation.event;

    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        this.providerKey = providerKey;
        // Save original configuration (without applying overrides)
        this.baseProviderConfig = providerConfig;
        // Initialize cached configuration (apply overrides)
        this.cachedProviderConfig = ConfigManager.applyProviderOverrides(this.providerKey, this.baseProviderConfig);
        // Initialize model information cache
        this.modelInfoCache = new ModelInfoCache(context);

        // Listen to configuration changes
        this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
            // Check if providerOverrides changed
            if (e.affectsConfiguration('ccmp.providerOverrides') && providerKey !== 'compatible') {
                // Recalculate configuration
                this.cachedProviderConfig = ConfigManager.applyProviderOverrides(
                    this.providerKey,
                    this.baseProviderConfig
                );
                // Clear cache
                this.modelInfoCache
                    ?.invalidateCache(this.providerKey)
                    .catch(err => Logger.warn(`[${this.providerKey}] Failed to clear cache:`, err));
                Logger.trace(`${this.providerKey} configuration updated`);
                this._onDidChangeLanguageModelChatInformation.fire();
            }
            // Check if autoPrefixModelId changed
            if (e.affectsConfiguration('ccmp.autoPrefixModelId')) {
                Logger.trace(`[${this.providerKey}] autoPrefixModelId configuration updated, refreshing model list`);
                this._onDidChangeLanguageModelChatInformation.fire();
            }
        });

        // Create OpenAI SDK handler
        this.openaiHandler = new OpenAIHandler(this);
        // Create OpenAI custom SSE handler
        this.openaiCustomHandler = new OpenAICustomHandler(this, this.openaiHandler);
        // Create OpenAI Responses API handler
        this.openaiResponsesHandler = new OpenAIResponsesHandler(this, this.openaiHandler);
        // Create Anthropic SDK handler
        this.anthropicHandler = new AnthropicHandler(this);
        // Create Gemini HTTP SSE handler
        this.geminiHandler = new GeminiHandler(this);
    }

    /**
     * Release resources
     */
    dispose(): void {
        // Release configuration listener
        this.configListener?.dispose();
        // Release event emitter
        this._onDidChangeLanguageModelChatInformation.dispose();
        Logger.info(`🧹 ${this.providerConfig.displayName}: Extension destroyed`);
    }

    /** Get providerKey */
    get provider(): string {
        return this.providerKey;
    }
    /** Get currently valid provider configuration */
    get providerConfig(): ProviderConfig {
        return this.cachedProviderConfig;
    }

    /**
     * Static Factory Method - Create and Activate Provider Based on Configuration
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: GenericModelProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} Model Extension Activated!`);
        // Create provider instance
        const provider = new GenericModelProvider(context, providerKey, providerConfig);
        // Register language model chat provider
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`ccmp.${providerKey}`, provider);
        // Register set API key command
        const setApiKeyCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.setApiKey`, async () => {
            await ApiKeyManager.promptAndSetApiKey(
                providerKey,
                providerConfig.displayName,
                providerConfig.apiKeyTemplate
            );
            // Clear cache after API key change
            await provider.modelInfoCache?.invalidateCache(providerKey);
            // Trigger model information change event
            provider._onDidChangeLanguageModelChatInformation.fire();
        });
        const disposables = [providerDisposable, setApiKeyCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * Convert ModelConfig to LanguageModelChatInformation
     */
    protected modelConfigToInfo(model: ModelConfig): LanguageModelChatInformation {
        // Determine family: prefer model config's family field, otherwise auto-infer based on sdkMode
        const family = this.resolveFamily(model);
        let modelId = model.id;
        if (ConfigManager.getAutoPrefixModelId()) {
            modelId = `${model.provider || this.providerKey}:::${modelId}`;
        }

        // Dynamically build configurationSchema
        type PropertySchema = JSONSchema7 & NonNullable<vscode.LanguageModelConfigurationSchema['properties']>[string];
        const properties: Record<string, PropertySchema> = {};
        // Add thinking option based on model configuration
        if (model.thinking && model.thinking.length > 0) {
            const schema: PropertySchema = {
                type: 'string',
                title: 'Thinking Mode',
                enum: model.thinking,
                enumItemLabels: model.thinking.map(
                    t => ({ disabled: 'Non-Thinking', enabled: 'Thinking', auto: 'Auto', adaptive: 'Adaptive' })[t] || t
                ),
                enumDescriptions: model.thinking.map(
                    t =>
                        ({
                            disabled: 'Disable Thinking Mode',
                            enabled: 'Enable Thinking Mode',
                            auto: 'Model decides automatically',
                            adaptive: 'Context adaptive'
                        })[t] || t
                ),
                default: model.thinking[0],
                group: 'navigation'
            };
            if (model.thinking?.includes('auto')) {
                schema.default = 'auto';
            } else if (model.thinking?.includes('adaptive')) {
                schema.default = 'adaptive';
            }
            properties.thinking = schema;
        }
        // Add reasoningEffort option based on model configuration
        if (model.reasoningEffort && model.reasoningEffort.length > 0) {
            delete properties.thinking; // Conflicts with thinking option
            const schema: PropertySchema = {
                type: 'string',
                title: 'Thinking Length',
                enum: model.reasoningEffort,
                enumItemLabels: model.reasoningEffort.map(
                    level =>
                        ({
                            none: 'None',
                            minimal: 'Minimal',
                            low: 'Low',
                            medium: 'Medium',
                            high: 'High',
                            xhigh: 'XHigh',
                            max: 'Max'
                        })[level] || level
                ),
                enumDescriptions: model.reasoningEffort.map(
                    level =>
                        ({
                            none: 'Disable thinking, answer directly',
                            minimal: 'Disable thinking, answer directly',
                            low: 'Lightweight thinking, fast response',
                            medium: 'Balanced mode, balancing speed and depth',
                            high: 'Deep analysis, handle complex problems',
                            xhigh: 'Maximum reasoning depth, slower speed',
                            max: 'Absolute highest capability, no consumption limits'
                        })[level] || level
                ),
                default: model.reasoningEffort[0],
                group: 'navigation'
            };
            if (model.reasoningEffort?.includes('medium')) {
                schema.default = 'medium';
            }
            properties.reasoningEffort = schema;
        }

        // let multiplier = this.providerConfig.displayName;
        // if (model.provider?.endsWith('coding')) {
        //     multiplier += 'CP';
        // } else if (model.provider?.endsWith('token')) {
        //     multiplier += 'TP';
        // } else if (model.id?.endsWith('billing') || model.name?.includes('pay-per-use')) {
        //     multiplier += 'PG';
        // }

        const info: LanguageModelChatInformation = {
            id: modelId,
            name: model.name,
            detail: this.providerConfig.displayName,
            tooltip: model.tooltip,
            family: family,
            maxInputTokens: model.maxInputTokens,
            maxOutputTokens: model.maxOutputTokens,
            version: model.id,
            category: { label: this.providerConfig.displayName, order: 3 },
            capabilities: model.capabilities,
            // multiplier: multiplier,
            isUserSelectable: true, // VsCode 1.120.0 version only recognizes this value
            configurationSchema: Object.keys(properties).length > 0 ? { properties } : undefined
        };
        return info;
    }

    /**
     * Find corresponding ModelConfig based on LanguageModelChatInformation
     * Adapted for autoPrefixModelId mode: supports prefixed model ID parsing (e.g., zhipu:::glm-4.6)
     * @param model Model information obtained from VS Code model selector (model.id may have prefix)
     * @returns Found ModelConfig, returns undefined if not found
     */
    protected findModelConfigById(model: LanguageModelChatInformation): ModelConfig | undefined {
        // Prefix format: ${provider}:::${modelId}
        // Use three colons as separator to avoid conflict with user-input model IDs
        const prefixSeparator = ':::';
        const prefixRegex = /^([a-zA-Z0-9_-]+):::(.+)$/;

        if (!model.id.includes(prefixSeparator)) {
            return this.providerConfig.models.find(m => m.id === model.id);
        }

        // Parse prefixed ID
        const match = model.id.match(prefixRegex);
        if (match) {
            const [, modelProvider, rawModelId] = match;
            // Check if prefix is current provider
            if (modelProvider === this.providerKey) {
                return this.providerConfig.models.find(m => m.id === rawModelId);
            }
            // If model's own provider field is set, also check for match
            const matchedModel = this.providerConfig.models.find(m => {
                if (m.provider && m.provider !== modelProvider) {
                    return false;
                }
                return m.id === rawModelId;
            });
            return matchedModel;
        }

        // Cannot parse prefix, treat as normal ID
        return this.providerConfig.models.find(m => m.id === model.id);
    }

    /**
     * Resolve model's family identifier
     * Priority: model config's family field > auto-infer based on sdkMode and model ID
     */
    protected resolveFamily(model: ModelConfig): string {
        // Prefer model config's family field
        if (model.family) {
            return model.family;
        }

        // Auto-infer default value based on sdkMode
        const sdkMode = model.sdkMode || 'openai';
        switch (sdkMode) {
            case 'gemini-sse':
                return 'gemini-3-pro';
            // Default all to claude-sonnet-4.6 series, users can override via family field
            case 'anthropic':
            default:
                return 'claude-sonnet-4.6';
        }
    }

    static configedProviders = new Set<string>();

    async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        // Logger.trace(`[${this.providerKey}] Provide model list request, options: ` + JSON.stringify(options));

        if (options.configuration) {
            // If request contains configuration, do not return model list
            return [];
        }

        // Check API key
        const hasApiKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        if (!options.silent || !hasApiKey) {
            Logger.debug(`[${this.providerKey}] Checking API key: ${hasApiKey ? 'configured' : 'not configured'}`);

            // If in silent mode (e.g., extension startup), do not trigger user interaction, directly return empty list
            if (!hasApiKey && options.silent) {
                return [];
            }

            Logger.info(`[${this.providerKey}] API key needs to be configured`);

            // In non-silent mode, directly trigger API key setup
            await vscode.commands.executeCommand(`ccmp.${this.providerKey}.setApiKey`);
            // Re-check API key
            const hasApiKeyAfterSet = await ApiKeyManager.hasValidApiKey(this.providerKey);
            if (!hasApiKeyAfterSet) {
                // If user cancelled setup or setup failed, return empty list
                return [];
            }
        }

        // Fast path: Check cache
        try {
            const apiKeyHash = await this.getApiKeyHash();
            const cachedModels = await this.modelInfoCache?.getCachedModels(this.providerKey, apiKeyHash);

            if (cachedModels) {
                Logger.trace(`✓ [${this.providerKey}] Returning model list from cache ` + `(${cachedModels.length} models)`);

                return cachedModels;
            }
        } catch (err) {
            Logger.warn(
                `[${this.providerKey}] Cache query failed, falling back to original logic:`,
                err instanceof Error ? err.message : String(err)
            );
        }

        // Convert models in configuration to VS Code required format
        const models = this.providerConfig.models.map(model => this.modelConfigToInfo(model));

        // Asynchronously cache results (do not block return)
        try {
            const apiKeyHash = await this.getApiKeyHash();
            this.updateModelCacheAsync(apiKeyHash);
        } catch (err) {
            Logger.warn(`[${this.providerKey}] Cache save failed:`, err);
        }

        return models;
    }

    /**
     * Asynchronously update model cache (does not block caller)
     */
    protected updateModelCacheAsync(apiKeyHash: string): void {
        // Use Promise to execute in background, without waiting for result
        (async () => {
            try {
                const models = this.providerConfig.models.map(model => this.modelConfigToInfo(model));

                await this.modelInfoCache?.cacheModels(this.providerKey, models, apiKeyHash);
            } catch (err) {
                // Background update failure should not affect extension operation
                Logger.trace(
                    `[${this.providerKey}] Background cache update failed:`,
                    err instanceof Error ? err.message : String(err)
                );
            }
        })();
    }

    /**
     * Calculate API key hash (for cache checking)
     */
    protected async getApiKeyHash(): Promise<string> {
        try {
            const apiKey = await ApiKeyManager.getApiKey(this.providerKey);
            if (!apiKey) {
                return 'no-key';
            }
            return await ModelInfoCache.computeApiKeyHash(apiKey);
        } catch (err) {
            Logger.warn(
                `[${this.providerKey}] Failed to calculate API key hash:`,
                err instanceof Error ? err.message : String(err)
            );
            return 'hash-error';
        }
    }

    /**
     * Get retry configuration for current request
     */
    protected getRequestRetryConfig() {
        return {
            maxAttempts: ConfigManager.getRetryMaxAttempts(),
            initialDelayMs: 1000,
            maxDelayMs: 30000
        };
    }

    /**
     * Get SDK display name
     */
    protected getSdkDisplayName(sdkMode: NonNullable<ModelConfig['sdkMode']> | 'openai'): string {
        if (sdkMode === 'anthropic') {
            return 'Anthropic SDK';
        }
        if (sdkMode === 'openai-sse') {
            return 'OpenAI SSE';
        }
        if (sdkMode === 'openai-responses') {
            return 'OpenAI Responses API';
        }
        if (sdkMode === 'gemini-sse') {
            return 'Gemini SSE';
        }
        return 'OpenAI SDK';
    }

    /**
     * Determine if request error allows retry
     */
    protected shouldRetryRequest(error: RetryableError): boolean {
        return RetryManager.isRateLimitError(error);
    }

    /**
     * Execute model request, and uniformly apply retry mechanism
     */
    protected async executeModelRequest(
        model: LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken,
        requestId: string | null,
        effectiveProviderKey = modelConfig.provider || this.providerKey
    ): Promise<void> {
        const sdkMode = modelConfig.sdkMode || 'openai';
        const requestMessages = filterAbortedAssistantMessages(messages);

        if (requestMessages.length !== messages.length) {
            Logger.info(
                `[${effectiveProviderKey}] Filtered ${messages.length - requestMessages.length} empty assistant messages left by aborted requests`
            );
        }

        const retryManager = new RetryManager(this.getRequestRetryConfig());

        await retryManager.executeWithRetry(
            async () => {
                if (sdkMode === 'anthropic') {
                    await this.anthropicHandler.handleRequest(
                        model,
                        modelConfig,
                        requestMessages,
                        options,
                        progress,
                        token,
                        requestId
                    );
                } else if (sdkMode === 'gemini-sse') {
                    await this.geminiHandler.handleRequest(
                        model,
                        modelConfig,
                        requestMessages,
                        options,
                        progress,
                        token,
                        requestId
                    );
                } else if (sdkMode === 'openai-sse') {
                    await this.openaiCustomHandler.handleRequest(
                        model,
                        modelConfig,
                        requestMessages,
                        options,
                        progress,
                        token,
                        requestId
                    );
                } else if (sdkMode === 'openai-responses') {
                    await this.openaiResponsesHandler.handleResponsesRequest(
                        model,
                        { ...modelConfig, provider: effectiveProviderKey },
                        requestMessages,
                        options,
                        progress,
                        token,
                        requestId
                    );
                } else {
                    await this.openaiHandler.handleRequest(
                        model,
                        modelConfig,
                        requestMessages,
                        options,
                        progress,
                        token,
                        requestId
                    );
                }
            },
            error => this.shouldRetryRequest(error),
            this.providerConfig.displayName
        );
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        // Find corresponding model configuration
        const modelConfig = this.findModelConfigById(model);
        if (!modelConfig) {
            const errorMessage = `Model not found: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        // Determine actual provider used based on provider field in model configuration
        // This correctly handles cases where different models under the same provider use different keys
        const effectiveProviderKey = modelConfig.provider || this.providerKey;

        // Calculate input token count and update status bar
        const totalInputTokens = await this.updateContextUsageStatusBar(model, messages, modelConfig, options);

        // === Token Statistics: Record estimated input token ===
        const usagesManager = TokenUsagesManager.instance;
        let requestId: string | null = null;
        try {
            requestId = await usagesManager.recordEstimatedTokens({
                providerKey: effectiveProviderKey,
                displayName: this.providerConfig.displayName,
                modelId: model.id,
                modelName: model.name || modelConfig.name,
                estimatedInputTokens: totalInputTokens
            });
        } catch (err) {
            Logger.warn('Failed to record estimated Token, continuing with request:', err);
        }

        // Ensure corresponding provider's API key exists
        await ApiKeyManager.ensureApiKey(effectiveProviderKey, this.providerConfig.displayName);

        // Select handler based on model's sdkMode
        const sdkMode = modelConfig.sdkMode || 'openai';
        const sdkName = this.getSdkDisplayName(sdkMode);
        Logger.info(`${this.providerConfig.displayName} Provider starting to process request (${sdkName}): ${modelConfig.name}`);

        try {
            await this.executeModelRequest(
                model,
                modelConfig,
                messages,
                options,
                progress,
                token,
                requestId,
                effectiveProviderKey
            );
        } catch (error) {
            const errorMessage = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;
            Logger.error(errorMessage);

            // === Token Statistics: Update failed status ===
            if (requestId) {
                try {
                    await usagesManager.updateActualTokens({
                        requestId,
                        status: 'failed'
                    });
                } catch (err) {
                    Logger.warn('Failed to update Token statistics status:', err);
                }
            }

            // Directly throw error, let VS Code handle retry
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} request completed`);
        }
    }

    async provideTokenCount(
        model: LanguageModelChatInformation,
        text: string | LanguageModelChatMessage,
        _token: CancellationToken
    ): Promise<number> {
        return TokenCounter.getInstance().countTokens(model, text);
    }

    /**
     * Update context usage status bar
     * Calculate input token count and usage percentage, update status bar display
     * For reuse by subclasses
     * @returns totalInputTokens - Returns calculated input token count, for Token statistics use
     */
    protected async updateContextUsageStatusBar(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        modelConfig: ModelConfig,
        options?: ProvideLanguageModelChatResponseOptions
    ): Promise<number> {
        try {
            const requestMessages = filterAbortedAssistantMessages(messages);

            const promptParts = await PromptAnalyzer.analyzePromptParts(
                this.providerKey,
                model,
                requestMessages,
                modelConfig,
                options
            );

            // Use promptParts.context as total token usage
            const totalInputTokens = promptParts.context || 0;
            const maxInputTokens = model.maxInputTokens || modelConfig.maxInputTokens;
            const percentage = (totalInputTokens / maxInputTokens) * 100;

            // const countMessagesTokens = await TokenCounter.getInstance().countMessagesTokens(
            //     model,
            //     messages,
            //     modelConfig,
            //     options
            // );
            // Logger.debug(
            //     `[${this.providerKey}] Detailed Token calculation: Total messages ${countMessagesTokens},` +
            //         `Prompt parts: ${JSON.stringify(promptParts)}`
            // );

            // Update context usage status bar
            const contextUsageStatusBar = ContextUsageStatusBar.getInstance();
            if (contextUsageStatusBar) {
                contextUsageStatusBar.updateWithPromptParts(
                    model.name || modelConfig.name,
                    maxInputTokens,
                    promptParts
                );
            }

            Logger.debug(
                `[${this.providerKey}] Token calculation: ${totalInputTokens}/${maxInputTokens} (${percentage.toFixed(1)}%)`
            );
            return totalInputTokens;
        } catch (error) {
            // Token calculation failure should not prevent request, only log warning
            Logger.warn(`[${this.providerKey}] Token calculation failed:`, error);
            return 0;
        }
    }
}
