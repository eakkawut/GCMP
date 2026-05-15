/*---------------------------------------------------------------------------------------------
 *  Tencent Cloud Dedicated Provider
 *  Provides multi-key management and protocol switching for Tencent Cloud paid models, Coding Plan, Token Plan, and DeepSeek
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
import { Logger, ApiKeyManager, TencentWizard } from '../utils';
import { TokenUsagesManager } from '../usages/usagesManager';

export class TencentProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: TencentProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} Dedicated Model Extension Activated!`);

        const provider = new TencentProvider(context, providerKey, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`ccmp.${providerKey}`, provider);

        const setApiKeyCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.setApiKey`, async () => {
            await TencentWizard.setApiKey(providerConfig.apiKeyTemplate);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const setCodingPlanApiKeyCommand = vscode.commands.registerCommand(
            `ccmp.${providerKey}.setCodingPlanApiKey`,
            async () => {
                await TencentWizard.setCodingPlanApiKey(providerConfig.codingKeyTemplate);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const setTokenPlanApiKeyCommand = vscode.commands.registerCommand(
            `ccmp.${providerKey}.setTokenPlanApiKey`,
            async () => {
                await TencentWizard.setTokenPlanApiKey(providerConfig.tokenKeyTemplate);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const setDeepSeekApiKeyCommand = vscode.commands.registerCommand(
            `ccmp.${providerKey}.setDeepSeekApiKey`,
            async () => {
                await TencentWizard.setDeepSeekApiKey(providerConfig.apiKeyTemplate);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const setTokenHubApiKeyCommand = vscode.commands.registerCommand(
            `ccmp.${providerKey}.setTokenHubApiKey`,
            async () => {
                await TencentWizard.setTokenHubApiKey(providerConfig.apiKeyTemplate);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const configWizardCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} Configuration Wizard`);
            await TencentWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.codingKeyTemplate,
                providerConfig.tokenKeyTemplate
            );
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [
            providerDisposable,
            setApiKeyCommand,
            setCodingPlanApiKeyCommand,
            setTokenPlanApiKeyCommand,
            setDeepSeekApiKeyCommand,
            setTokenHubApiKeyCommand,
            configWizardCommand
        ];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    protected override modelConfigToInfo(model: ModelConfig): LanguageModelChatInformation {
        return super.modelConfigToInfo(model);
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
        const hasCodingKey = await ApiKeyManager.hasValidApiKey('tencent-coding');
        const hasTokenPlanKey = await ApiKeyManager.hasValidApiKey('tencent-token');
        const hasDeepSeekKey = await ApiKeyManager.hasValidApiKey('tencent-deepseek');
        const hasTokenHubKey = await ApiKeyManager.hasValidApiKey('tencent-tokenhub');
        const hasAnyKey = hasNormalKey || hasCodingKey || hasTokenPlanKey || hasDeepSeekKey || hasTokenHubKey;

        if (options.silent && !hasAnyKey) {
            Logger.debug(`${this.providerConfig.displayName}: In silent mode, no keys detected, returning empty model list`);
            return [];
        }

        if (!options.silent) {
            await TencentWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.codingKeyTemplate,
                this.providerConfig.tokenKeyTemplate
            );

            const normalKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const codingKeyValid = await ApiKeyManager.hasValidApiKey('tencent-coding');
            const tokenPlanKeyValid = await ApiKeyManager.hasValidApiKey('tencent-token');
            const deepSeekKeyValid = await ApiKeyManager.hasValidApiKey('tencent-deepseek');
            const tokenHubKeyValid = await ApiKeyManager.hasValidApiKey('tencent-tokenhub');
            if (!normalKeyValid && !codingKeyValid && !tokenPlanKeyValid && !deepSeekKeyValid && !tokenHubKeyValid) {
                Logger.warn(`${this.providerConfig.displayName}: User has not set any keys, returning empty model list`);
                return [];
            }
        }

        return this.providerConfig.models.map(model => this.modelConfigToInfo(model));
    }

    async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        _token: CancellationToken
    ): Promise<void> {
        // Find corresponding model configuration
        const rawModelConfig = this.findModelConfigById(model);
        if (!rawModelConfig) {
            const errorMessage = `Model not found: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        const modelConfig = rawModelConfig;
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);
        if (!apiKey) {
            throw new Error(`${this.providerConfig.displayName}: Invalid ${this.getKeyLabel(providerKey)} API key`);
        }

        Logger.debug(
            `${this.providerConfig.displayName}: About to process request, using ${providerKey} key - Model: ${modelConfig.name}`
        );

        const totalInputTokens = await this.updateContextUsageStatusBar(model, messages, modelConfig, options);

        const usagesManager = TokenUsagesManager.instance;
        let requestId: string | null = null;
        try {
            requestId = await usagesManager.recordEstimatedTokens({
                providerKey,
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

    private getProviderKeyForModel(modelConfig: ModelConfig): string {
        return modelConfig.provider || this.providerKey;
    }

    private getKeyLabel(providerKey: string): string {
        switch (providerKey) {
            case 'tencent-coding':
                return 'Coding Plan Dedicated';
            case 'tencent-token':
                return 'Token Plan Dedicated';
            case 'tencent-deepseek':
                return 'DeepSeek Dedicated';
            case 'tencent-tokenhub':
                return 'TokenHub Dedicated';
            default:
                return 'Paid Model';
        }
    }

    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        Logger.warn(`Model ${modelConfig.name} missing ${this.getKeyLabel(providerKey)} API key, entering setup flow`);

        if (providerKey === 'tencent-coding') {
            await TencentWizard.setCodingPlanApiKey(this.providerConfig.codingKeyTemplate);
        } else if (providerKey === 'tencent-token') {
            await TencentWizard.setTokenPlanApiKey(this.providerConfig.tokenKeyTemplate);
        } else if (providerKey === 'tencent-deepseek') {
            await TencentWizard.setDeepSeekApiKey(this.providerConfig.apiKeyTemplate);
        } else if (providerKey === 'tencent-tokenhub') {
            await TencentWizard.setTokenHubApiKey(this.providerConfig.apiKeyTemplate);
        } else {
            await TencentWizard.setApiKey(this.providerConfig.apiKeyTemplate);
        }

        const apiKey = await ApiKeyManager.getApiKey(providerKey);
        if (apiKey) {
            Logger.info(`${this.getKeyLabel(providerKey)} key set successfully`);
            return apiKey;
        }

        throw new Error(`${this.providerConfig.displayName}: User has not set ${this.getKeyLabel(providerKey)} API key`);
    }
}
