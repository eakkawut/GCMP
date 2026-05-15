/*---------------------------------------------------------------------------------------------
 *  Xiaomi MiMo Dedicated Provider
 *  Provides multi-key management and Token Plan support for Xiaomi MiMo
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
import { Logger, ApiKeyManager, XiaomimimoWizard } from '../utils';
import { TokenUsagesManager } from '../usages/usagesManager';

export class XiaomimimoProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: XiaomimimoProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} Dedicated Model Extension Activated!`);

        const provider = new XiaomimimoProvider(context, providerKey, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`ccmp.${providerKey}`, provider);

        // Normal API Key
        const setApiKeyCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.setApiKey`, async () => {
            await XiaomimimoWizard.setNormalApiKey(providerConfig.displayName, providerConfig.apiKeyTemplate);
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // Token Plan Dedicated API Key
        const setTokenPlanApiKeyCommand = vscode.commands.registerCommand(
            `ccmp.${providerKey}.setTokenPlanApiKey`,
            async () => {
                await XiaomimimoWizard.setTokenPlanApiKey(providerConfig.displayName, providerConfig.tokenKeyTemplate);
                await provider.modelInfoCache?.invalidateCache('xiaomimimo-token');
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const setTokenPlanEndpointCommand = vscode.commands.registerCommand(
            `ccmp.${providerKey}.setTokenPlanEndpoint`,
            async () => {
                Logger.info(`User manually opened ${providerConfig.displayName} Token Plan endpoint selection`);
                await XiaomimimoWizard.setTokenPlanEndpoint(providerConfig.displayName);
            }
        );

        const configWizardCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} Configuration Wizard`);
            await XiaomimimoWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.tokenKeyTemplate
            );
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [
            providerDisposable,
            setApiKeyCommand,
            setTokenPlanApiKeyCommand,
            setTokenPlanEndpointCommand,
            configWizardCommand
        ];
        disposables.forEach(d => context.subscriptions.push(d));
        return { provider, disposables };
    }

    private getProviderKeyForModel(modelConfig: ModelConfig): string {
        return modelConfig.provider || this.providerKey;
    }

    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const isTokenPlan = providerKey === 'xiaomimimo-token';
        const keyType = isTokenPlan ? 'Token Plan Dedicated' : 'Normal';

        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        Logger.warn(`Model ${modelConfig.name} missing ${keyType} API key, entering setup flow`);

        if (isTokenPlan) {
            await XiaomimimoWizard.setTokenPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.tokenKeyTemplate
            );
        } else {
            await XiaomimimoWizard.setNormalApiKey(this.providerConfig.displayName, this.providerConfig.apiKeyTemplate);
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
        const hasTokenPlanKey = await ApiKeyManager.hasValidApiKey('xiaomimimo-token');
        const hasAnyKey = hasNormalKey || hasTokenPlanKey;

        if (options.silent && !hasAnyKey) {
            Logger.debug(`${this.providerConfig.displayName}: In silent mode, no keys detected, returning empty model list`);
            return [];
        }

        if (!options.silent) {
            await XiaomimimoWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.tokenKeyTemplate
            );

            const normalKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const tokenPlanKeyValid = await ApiKeyManager.hasValidApiKey('xiaomimimo-token');
            if (!normalKeyValid && !tokenPlanKeyValid) {
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
            const keyType = providerKey === 'xiaomimimo-token' ? 'Token Plan Dedicated' : 'Normal';
            throw new Error(`${this.providerConfig.displayName}: Invalid ${keyType} API key`);
        }

        Logger.debug(
            `${this.providerConfig.displayName}: About to process request, using ${providerKey === 'xiaomimimo-token' ? 'Token Plan' : 'Normal'} key - Model: ${modelConfig.name}`
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
