/*---------------------------------------------------------------------------------------------
 *  Dashscope (Alibaba Cloud Bailian) Dedicated Provider
 *  Provides multi-key management and configuration wizard functionality for Dashscope provider
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
import { Logger, ApiKeyManager, DashscopeWizard } from '../utils';
import { TokenUsagesManager } from '../usages/usagesManager';

export class DashscopeProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: DashscopeProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} Dedicated Model Extension Activated!`);

        const provider = new DashscopeProvider(context, providerKey, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`ccmp.${providerKey}`, provider);

        // Normal API Key
        const setApiKeyCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.setApiKey`, async () => {
            await DashscopeWizard.setNormalApiKey(providerConfig.displayName, providerConfig.apiKeyTemplate);
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // Coding Plan Dedicated API Key
        const setCodingPlanApiKeyCommand = vscode.commands.registerCommand(
            `ccmp.${providerKey}.setCodingPlanApiKey`,
            async () => {
                await DashscopeWizard.setCodingPlanApiKey(providerConfig.displayName, providerConfig.codingKeyTemplate);
                await provider.modelInfoCache?.invalidateCache('dashscope-coding');
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        // Token Plan Dedicated API Key
        const setTokenPlanApiKeyCommand = vscode.commands.registerCommand(
            `ccmp.${providerKey}.setTokenPlanApiKey`,
            async () => {
                await DashscopeWizard.setTokenPlanApiKey(providerConfig.displayName, providerConfig.tokenKeyTemplate);
                await provider.modelInfoCache?.invalidateCache('dashscope-token');
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const configWizardCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} Configuration Wizard`);
            await DashscopeWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.codingKeyTemplate,
                providerConfig.tokenKeyTemplate
            );
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [
            providerDisposable,
            setApiKeyCommand,
            setCodingPlanApiKeyCommand,
            setTokenPlanApiKeyCommand,
            configWizardCommand
        ];
        disposables.forEach(d => context.subscriptions.push(d));
        return { provider, disposables };
    }

    private getProviderKeyForModel(modelConfig: ModelConfig): string {
        // Return model-specific provider or use default
        return modelConfig.provider || this.providerKey;
    }

    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const isCodingPlan = providerKey === 'dashscope-coding';
        const isTokenPlan = providerKey === 'dashscope-token';
        const keyType =
            isCodingPlan ? 'Coding Plan Dedicated'
                : isTokenPlan ? 'Token Plan Dedicated'
                    : 'Normal';

        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        Logger.warn(`Model ${modelConfig.name} missing ${keyType} API key, entering setup flow`);

        if (isCodingPlan) {
            await DashscopeWizard.setCodingPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.codingKeyTemplate
            );
        } else if (isTokenPlan) {
            await DashscopeWizard.setTokenPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.tokenKeyTemplate
            );
        } else {
            await DashscopeWizard.setNormalApiKey(this.providerConfig.displayName, this.providerConfig.apiKeyTemplate);
        }

        const apiKey = await ApiKeyManager.getApiKey(providerKey);
        if (apiKey) {
            Logger.info(`${keyType} key set successfully`);
            return apiKey;
        }

        throw new Error(`${this.providerConfig.displayName}: User has not set ${keyType} API key`);
    }

    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) {
            // If request contains configuration, do not return model list
            return [];
        }

        const hasNormalKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        const hasCodingKey = await ApiKeyManager.hasValidApiKey('dashscope-coding');
        const hasTokenPlanKey = await ApiKeyManager.hasValidApiKey('dashscope-token');
        const hasAnyKey = hasNormalKey || hasCodingKey || hasTokenPlanKey;

        if (options.silent && !hasAnyKey) {
            Logger.debug(`${this.providerConfig.displayName}: In silent mode, no keys detected, returning empty model list`);
            return [];
        }

        if (!options.silent) {
            await DashscopeWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.codingKeyTemplate,
                this.providerConfig.tokenKeyTemplate
            );

            const normalKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const codingKeyValid = await ApiKeyManager.hasValidApiKey('dashscope-coding');
            const tokenPlanKeyValid = await ApiKeyManager.hasValidApiKey('dashscope-token');
            if (!normalKeyValid && !codingKeyValid && !tokenPlanKeyValid) {
                Logger.warn(`${this.providerConfig.displayName}: User has not set any keys, returning empty model list`);
                return [];
            }
        }

        const models = this.providerConfig.models.map(m => this.modelConfigToInfo(m));

        return models;
    }

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

        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);
        if (!apiKey) {
            const keyType =
                providerKey === 'dashscope-coding' ? 'Coding Plan Dedicated'
                    : providerKey === 'dashscope-token' ? 'Token Plan Dedicated'
                        : 'Normal';
            throw new Error(`${this.providerConfig.displayName}: Invalid ${keyType} API key`);
        }

        const keyLabel =
            providerKey === 'dashscope-coding' ? 'Coding Plan'
                : providerKey === 'dashscope-token' ? 'Token Plan'
                    : 'Normal';
        Logger.debug(
            `${this.providerConfig.displayName}: About to process request, using ${keyLabel} key - Model: ${modelConfig.name}`
        );

        const totalInputTokens = await this.updateContextUsageStatusBar(model, messages, modelConfig, options);

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
                _token,
                requestId,
                providerKey
            );
        } catch (error) {
            if (requestId) {
                try {
                    await usagesManager.updateActualTokens({ requestId, status: 'failed' });
                } catch (err) {
                    Logger.warn('Failed to update Token statistics status:', err);
                }
            }
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} request completed`);
        }
    }
}
