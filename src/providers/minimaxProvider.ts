/*---------------------------------------------------------------------------------------------
 *  MiniMax Dedicated Provider
 *  Provides multi-key management and dedicated configuration wizard functionality for MiniMax provider
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
import { GenericModelProvider } from './genericModelProvider';
import { ProviderConfig, ModelConfig } from '../types/sharedTypes';
import { Logger, ApiKeyManager, MiniMaxWizard } from '../utils';
import { StatusBarManager } from '../status';
import { TokenUsagesManager } from '../usages/usagesManager';
import { MiniMaxVisionBridge } from '../handlers/visionBridge/minimaxVisionBridge';

/**
 * MiniMax Dedicated Model Provider Class
 * Extends GenericModelProvider with multi-key management and configuration wizard functionality
 */
export class MiniMaxProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * Static Factory Method - Create and Activate MiniMax Provider
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: MiniMaxProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} Dedicated Model Extension Activated!`);
        // Create provider instance
        const provider = new MiniMaxProvider(context, providerKey, providerConfig);
        // Register language model chat provider
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`ccmp.${providerKey}`, provider);

        // Register command to set normal API key
        const setApiKeyCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.setApiKey`, async () => {
            await MiniMaxWizard.setNormalApiKey(providerConfig.displayName, providerConfig.apiKeyTemplate);
            // Clear cache after API key change
            await provider.modelInfoCache?.invalidateCache(providerKey);
            // Trigger model information change event
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // Register command to set Coding Plan dedicated key
        const setCodingKeyCommand = vscode.commands.registerCommand(
            `ccmp.${providerKey}.setCodingPlanApiKey`,
            async () => {
                await MiniMaxWizard.setCodingPlanApiKey(providerConfig.displayName, providerConfig.codingKeyTemplate);
                // Clear cache after API key change
                await provider.modelInfoCache?.invalidateCache('minimax-coding');
                // Trigger model information change event
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        // Register command to set Coding Plan endpoint
        const setCodingPlanEndpointCommand = vscode.commands.registerCommand(
            `ccmp.${providerKey}.setCodingPlanEndpoint`,
            async () => {
                Logger.info(`User manually opened ${providerConfig.displayName} Coding Plan endpoint selection`);
                await MiniMaxWizard.setCodingPlanEndpoint(providerConfig.displayName);
            }
        );

        // Register configuration wizard command
        const configWizardCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} Configuration Wizard`);
            await MiniMaxWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.codingKeyTemplate
            );
        });

        const disposables = [
            providerDisposable,
            setApiKeyCommand,
            setCodingKeyCommand,
            setCodingPlanEndpointCommand,
            configWizardCommand
        ];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * Get MiniMax status bar instance (for delayedUpdate call)
     */
    static getMiniMaxStatusBar() {
        return StatusBarManager.minimax;
    }

    /**
     * Get provider key for model (considering provider field and defaults)
     */
    private getProviderKeyForModel(modelConfig: ModelConfig): string {
        // Prefer model-specific provider field
        if (modelConfig.provider) {
            return modelConfig.provider;
        }
        // Otherwise use provider's default provider key
        return this.providerKey;
    }

    /**
     * Get the key corresponding to the model, ensuring a valid key exists
     * @param modelConfig Model configuration
     * @returns Returns the available API key
     */
    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const isCodingPlan = providerKey === 'minimax-coding';
        const keyType = isCodingPlan ? 'Coding Plan Dedicated' : 'Normal';

        // Check if key already exists
        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        // Key does not exist, directly enter setup flow (no confirmation dialog)
        Logger.warn(`Model ${modelConfig.name} missing ${keyType} API key, entering setup flow`);

        if (isCodingPlan) {
            // Coding Plan model directly enters dedicated key setup
            await MiniMaxWizard.setCodingPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.codingKeyTemplate
            );
        } else {
            // Normal model directly enters normal key setup
            await MiniMaxWizard.setNormalApiKey(this.providerConfig.displayName, this.providerConfig.apiKeyTemplate);
        }

        // Re-check if key was set successfully
        const apiKey = await ApiKeyManager.getApiKey(providerKey);
        if (apiKey) {
            Logger.info(`${keyType} key set successfully`);
            return apiKey;
        }

        // User did not set or setup failed
        throw new Error(`${this.providerConfig.displayName}: User has not set ${keyType} API key`);
    }

    /**
     * Override: Get model information - Add key check
     * Return all models as long as any key exists, without filtering
     * Specific key validation is performed when actually in use (provideLanguageModelChatResponse)
     */
    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) {
            // If request contains configuration, do not return model list
            return [];
        }

        // Check if any key exists
        const hasNormalKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        const hasCodingKey = await ApiKeyManager.hasValidApiKey('minimax-coding');
        const hasAnyKey = hasNormalKey || hasCodingKey;

        // If in silent mode and no keys exist, directly return empty list
        if (options.silent && !hasAnyKey) {
            Logger.debug(`${this.providerConfig.displayName}: In silent mode, no keys detected, returning empty model list`);
            return [];
        }

        // Non-silent mode: Start configuration wizard
        if (!options.silent) {
            await MiniMaxWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.codingKeyTemplate
            );

            // Re-check if keys were set
            const normalKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const codingKeyValid = await ApiKeyManager.hasValidApiKey('minimax-coding');

            // If user still hasn't set any keys, return empty list
            if (!normalKeyValid && !codingKeyValid) {
                Logger.warn(`${this.providerConfig.displayName}: User has not set any keys, returning empty model list`);
                return [];
            }
        }

        // Return all models without filtering
        // Specific key validation will be performed in provideLanguageModelChatResponse after user selects a model
        Logger.debug(`${this.providerConfig.displayName}: Returning all ${this.providerConfig.models.length} models`);

        // Convert models in configuration to VS Code required format
        const models = this.providerConfig.models.map(model => this.modelConfigToInfo(model));

        return models;
    }

    /**
     * Override: Provide language model chat response - Add pre-request key assurance mechanism
     * Ensure corresponding key exists before processing request
     */
    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        _token: CancellationToken
    ): Promise<void> {
        // Find corresponding model configuration
        const modelConfig = this.findModelConfigById(model);
        if (!modelConfig) {
            const errorMessage = `Model not found: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        // Pre-request: Ensure key corresponding to model exists
        // This will show setup dialog when no key is available
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);

        if (!apiKey) {
            const keyType = providerKey === 'minimax-coding' ? 'Coding Plan Dedicated' : 'Normal';
            throw new Error(`${this.providerConfig.displayName}: Invalid ${keyType} API key`);
        }

        Logger.debug(
            `${this.providerConfig.displayName}: About to process request, using ${providerKey === 'minimax-coding' ? 'Coding Plan' : 'Normal'} key - Model: ${modelConfig.name}`
        );

        // Image bridge: Preprocess images in messages
        // Note: After MiniMax models support visual recognition, remove this bridge call and minimaxVisionBridge.ts
        const visionBridgeResult = await MiniMaxVisionBridge.preprocessImages(
            messages,
            modelConfig,
            providerKey,
            _token
        );
        const processedMessages = visionBridgeResult.messages;

        // Calculate input token count and update status bar (using bridged messages, images have been replaced with text descriptions)
        const totalInputTokens = await this.updateContextUsageStatusBar(model, processedMessages, modelConfig, options);

        // === Token Statistics: Record estimated input token ===
        const usagesManager = TokenUsagesManager.instance;
        let requestId: string | null = null;
        try {
            requestId = await usagesManager.recordEstimatedTokens({
                providerKey: providerKey,
                displayName: this.providerConfig.displayName,
                modelId: model.id,
                modelName: model.name || modelConfig.name,
                estimatedInputTokens: totalInputTokens
            });
        } catch (err) {
            Logger.warn('Failed to record estimated Token, continuing with request:', err);
        }

        // Select handler based on model's sdkMode
        // Note: Do not call super.provideLanguageModelChatResponse here, handle directly instead
        // Avoid double key check, as we have already checked in ensureApiKeyForModel
        const sdkMode = modelConfig.sdkMode || 'openai';
        const sdkName = this.getSdkDisplayName(sdkMode);
        Logger.info(`${this.providerConfig.displayName} Provider starting to process request (${sdkName}): ${modelConfig.name}`);

        try {
            await this.executeModelRequest(
                model,
                modelConfig,
                processedMessages,
                options,
                progress,
                _token,
                requestId,
                providerKey
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

            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} request completed`);

            // If using Coding Plan key, delayed update status bar usage
            if (providerKey === 'minimax-coding') {
                const statusBar = MiniMaxProvider.getMiniMaxStatusBar();
                statusBar?.delayedUpdate();
            }
        }
    }
}
