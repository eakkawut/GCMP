/*---------------------------------------------------------------------------------------------
 *  ZhipuAI Dedicated Provider
 *  Extends GenericModelProvider with configuration wizard functionality and status bar updates
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatProvider,
    LanguageModelChatMessage,
    LanguageModelChatInformation,
    ProvideLanguageModelChatResponseOptions,
    PrepareLanguageModelChatModelOptions,
    Progress,
    CancellationToken
} from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { Logger } from '../utils/logger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { ZhipuWizard } from '../utils/zhipuWizard';
import { GenericModelProvider } from './genericModelProvider';
import { StatusBarManager } from '../status/statusBarManager';
import { RetryableError } from '../utils';

/**
 * ZhipuAI Dedicated Model Provider Class
 * Extends GenericModelProvider with configuration wizard functionality
 */
export class ZhipuProvider extends GenericModelProvider implements LanguageModelChatProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * Static Factory Method - Create and Activate Zhipu Provider
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: ZhipuProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} Dedicated Model Extension Activated!`);
        // Create provider instance
        const provider = new ZhipuProvider(context, providerKey, providerConfig);
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

        // Register configuration wizard command
        const configWizardCommand = vscode.commands.registerCommand(`ccmp.${providerKey}.configWizard`, async () => {
            Logger.info(`Starting ${providerConfig.displayName} Configuration Wizard`);
            await ZhipuWizard.startWizard(providerConfig.displayName, providerConfig.apiKeyTemplate);
        });

        const disposables = [providerDisposable, setApiKeyCommand, configWizardCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * Get Zhipu status bar instance (for delayedUpdate call)
     */
    static getZhipuStatusBar() {
        return StatusBarManager.zhipu;
    }

    /**
     * Temporarily override provideLanguageModelChatInformation to support non-silent mode wizard trigger
     */
    override async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions,
        _token: CancellationToken
    ): Promise<LanguageModelChatInformation[]> {
        if (options.configuration) {
            // If request contains configuration, do not return model list
            return [];
        }

        if (!options.silent) {
            await vscode.commands.executeCommand(`ccmp.${this.providerKey}.configWizard`);
            return super.provideLanguageModelChatInformation({ silent: true }, _token);
        }
        return super.provideLanguageModelChatInformation(options, _token);
    }

    /**
     * Override provideChatResponse to update status bar after request completion
     */
    override async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        try {
            const modelConfig = this.findModelConfigById(model);
            if (modelConfig?.sdkMode === 'anthropic') {
                const systemMessage = messages.find(msg => msg.role === vscode.LanguageModelChatMessageRole.System);
                if (systemMessage && Array.isArray(systemMessage.content)) {
                    const systemPrompt = systemMessage.content.find(
                        msgPart => msgPart instanceof vscode.LanguageModelTextPart
                    );
                    if (systemPrompt?.value) {
                        const promptText = systemPrompt.value;
                        const applyPatch = "You are Claude Code, Anthropic's official CLI for Claude.\n\n";
                        systemPrompt.value = applyPatch + promptText;
                    }
                }
            }

            // Call parent class implementation
            await super.provideLanguageModelChatResponse(model, messages, options, progress, token);
        } finally {
            // After request completion, delayed update ZhipuAI status bar usage
            StatusBarManager.zhipu?.delayedUpdate();
        }
    }

    static isServerError(error: RetryableError, deep = 0): boolean {
        // Zhipu's server errors usually indicate server overload, can also be retried
        if (error.message && typeof error.message === 'string' && error.code) {
            // Zhipu-specific server error codes that need retry
            if (
                error.code === '500' ||
                (typeof error.code === 'string' &&
                    error.code.length === 4 && // 4-digit error code, similar to 1234, 1305, etc., indicating server overload or temporary communication error
                    (error.code.startsWith('12') || error.code.startsWith('13')))
            ) {
                return true;
            }
        }
        // Check for nested error object
        if (deep <= 3 && 'error' in error && typeof error.error === 'object' && error.error !== null) {
            return this.isServerError(error.error as RetryableError, deep + 1);
        }
        return false;
    }
    protected override shouldRetryRequest(error: RetryableError): boolean {
        if (super.shouldRetryRequest(error)) {
            Logger.debug(`[${this.providerConfig.displayName}] Request failed, meets request rate limit retry conditions, preparing to retry...`);
            return true;
        }
        if (ZhipuProvider.isServerError(error)) {
            Logger.debug(`[${this.providerConfig.displayName}] Request failed, meets server-side error retry conditions, preparing to retry...`);
            return true;
        }
        return false;
    }
}
