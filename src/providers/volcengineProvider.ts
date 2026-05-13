/*---------------------------------------------------------------------------------------------
 *  Volcengine (火山方舟) 专用 Provider
 *  为火山方舟提供多密钥管理（Coding Plan / Agent Plan）和配置向导功能
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
import { Logger, ApiKeyManager, VolcengineWizard } from '../utils';
import { TokenUsagesManager } from '../usages/usagesManager';

export class VolcengineProvider extends GenericModelProvider implements LanguageModelChatProvider {
    private static readonly AGENT_PLAN_KEY = 'volcengine-agent';

    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: VolcengineProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} 专用模型扩展已激活!`);

        const provider = new VolcengineProvider(context, providerKey, providerConfig);
        const providerDisposable = vscode.lm.registerLanguageModelChatProvider(`ccmp.${providerKey}`, provider);

        // Coding Plan API Key
        const setApiKeyCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.setApiKey`, async () => {
            await VolcengineWizard.setCodingPlanApiKey(providerConfig.displayName, providerConfig.apiKeyTemplate);
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        // Agent Plan 专用 API Key
        const setAgentPlanApiKeyCommand = vscode.commands.registerCommand(
            `ccmp.${providerKey}.setAgentPlanApiKey`,
            async () => {
                await VolcengineWizard.setAgentPlanApiKey(
                    providerConfig.displayName,
                    providerConfig.tokenKeyTemplate || providerConfig.apiKeyTemplate
                );
                await provider.modelInfoCache?.invalidateCache(VolcengineProvider.AGENT_PLAN_KEY);
                provider._onDidChangeLanguageModelChatInformation.fire();
            }
        );

        const configWizardCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.configWizard`, async () => {
            Logger.info(`启动 ${providerConfig.displayName} 配置向导`);
            await VolcengineWizard.startWizard(
                providerConfig.displayName,
                providerConfig.apiKeyTemplate,
                providerConfig.tokenKeyTemplate
            );
            await provider.modelInfoCache?.invalidateCache(providerKey);
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [providerDisposable, setApiKeyCommand, setAgentPlanApiKeyCommand, configWizardCommand];
        disposables.forEach(d => context.subscriptions.push(d));
        return { provider, disposables };
    }

    private getProviderKeyForModel(modelConfig: ModelConfig): string {
        return modelConfig.provider || this.providerKey;
    }

    private async ensureApiKeyForModel(modelConfig: ModelConfig): Promise<string> {
        const providerKey = this.getProviderKeyForModel(modelConfig);
        const isAgentPlan = providerKey === VolcengineProvider.AGENT_PLAN_KEY;
        const keyType = isAgentPlan ? 'Agent Plan 专用' : 'Coding Plan';

        const hasApiKey = await ApiKeyManager.hasValidApiKey(providerKey);
        if (hasApiKey) {
            const apiKey = await ApiKeyManager.getApiKey(providerKey);
            if (apiKey) {
                return apiKey;
            }
        }

        Logger.warn(`模型 ${modelConfig.name} 缺少 ${keyType} API 密钥，进入设置流程`);

        if (isAgentPlan) {
            await VolcengineWizard.setAgentPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.tokenKeyTemplate || this.providerConfig.apiKeyTemplate
            );
        } else {
            await VolcengineWizard.setCodingPlanApiKey(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate
            );
        }

        const apiKey = await ApiKeyManager.getApiKey(providerKey);
        if (apiKey) {
            Logger.info(`${keyType}密钥设置成功`);
            return apiKey;
        }

        throw new Error(`${this.providerConfig.displayName}: 用户未设置 ${keyType} API 密钥`);
    }

    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) {
            return [];
        }

        const hasCodingKey = await ApiKeyManager.hasValidApiKey(this.providerKey);
        const hasAgentPlanKey = await ApiKeyManager.hasValidApiKey(VolcengineProvider.AGENT_PLAN_KEY);
        const hasAnyKey = hasCodingKey || hasAgentPlanKey;

        if (options.silent && !hasAnyKey) {
            Logger.debug(`${this.providerConfig.displayName}: 静默模式下，未检测到任何密钥，返回空模型列表`);
            return [];
        }

        if (!options.silent) {
            await VolcengineWizard.startWizard(
                this.providerConfig.displayName,
                this.providerConfig.apiKeyTemplate,
                this.providerConfig.tokenKeyTemplate
            );

            const codingKeyValid = await ApiKeyManager.hasValidApiKey(this.providerKey);
            const agentPlanKeyValid = await ApiKeyManager.hasValidApiKey(VolcengineProvider.AGENT_PLAN_KEY);
            if (!codingKeyValid && !agentPlanKeyValid) {
                Logger.warn(`${this.providerConfig.displayName}: 用户未设置任何密钥，返回空模型列表`);
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
        const modelConfig = this.findModelConfigById(model);
        if (!modelConfig) {
            const errorMessage = `未找到模型: ${model.id}`;
            Logger.error(errorMessage);
            throw new Error(errorMessage);
        }

        const providerKey = this.getProviderKeyForModel(modelConfig);
        const apiKey = await this.ensureApiKeyForModel(modelConfig);
        if (!apiKey) {
            const keyType = providerKey === VolcengineProvider.AGENT_PLAN_KEY ? 'Agent Plan 专用' : 'Coding Plan';
            throw new Error(`${this.providerConfig.displayName}: 无效的 ${keyType} API 密钥`);
        }

        const keyLabel = providerKey === VolcengineProvider.AGENT_PLAN_KEY ? 'Agent Plan' : 'Coding Plan';
        Logger.debug(
            `${this.providerConfig.displayName}: 即将处理请求，使用 ${keyLabel} 密钥 - 模型: ${modelConfig.name}`
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
            Logger.warn('记录预估Token失败，继续执行请求:', err);
        }

        const sdkMode = modelConfig.sdkMode || 'openai';
        const sdkName = this.getSdkDisplayName(sdkMode);
        Logger.info(`${this.providerConfig.displayName} Provider 开始处理请求 (${sdkName}): ${modelConfig.name}`);

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
                    Logger.warn('更新Token统计失败状态失败:', err);
                }
            }
            throw error;
        } finally {
            Logger.info(`✅ ${this.providerConfig.displayName}: ${model.name} 请求已完成`);
        }
    }
}
