/*---------------------------------------------------------------------------------------------
 *  CLI Authentication Dedicated Provider
 *  Inherits from GenericModelProvider, supports CLI authentication mode
 *  Supports CLI authentication providers such as qwen-code, gemini, codex, etc.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatMessage,
    LanguageModelChatInformation,
    ProvideLanguageModelChatResponseOptions,
    Progress,
    CancellationToken,
    PrepareLanguageModelChatModelOptions
} from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { ApiKeyManager, Logger } from '../utils';
import { GenericModelProvider } from '../providers/genericModelProvider';
import { CliWizard } from './cliWizard';
import { CliAuthFactory } from './auth/cliAuthFactory';
import { StatusBarManager } from '../status';

/**
 * CLI authentication dedicated model provider class
 * Inherits from GenericModelProvider, supports CLI authentication mode
 * Suitable for all providers using CLI authentication (qwen-code, gemini, codex, etc.)
 */
export class CliModelProvider extends GenericModelProvider {
    constructor(context: vscode.ExtensionContext, providerKey: string, providerConfig: ProviderConfig) {
        super(context, providerKey, providerConfig);
    }

    /**
     * Override model information provider method
     * Starts configuration wizard instead of requiring API key when no API key is available
     */
    async provideLanguageModelChatInformation(
        options: PrepareLanguageModelChatModelOptions & { silent: boolean },
        token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        if (options.configuration) {
            // If request contains configuration, return empty model list
            return [];
        }

        // Check if valid API key exists
        let hasApiKey: boolean;
        if (options.silent) {
            hasApiKey = await Promise.race([
                ApiKeyManager.ensureApiKey(this.providerKey, this.providerConfig.displayName, false),
                new Promise<boolean>(resolve => setTimeout(() => resolve(false), 500)) // 500ms timeout
            ]);
        } else {
            // In non-silent mode, directly trigger user interaction to ensure key exists
            await vscode.commands.executeCommand(`ccmp.${this.providerKey}.configWizard`);
            hasApiKey = await ApiKeyManager.ensureApiKey(this.providerKey, this.providerConfig.displayName, false);
            options.silent = true; // Adjust subsequent calls to silent mode
        }
        if (!hasApiKey) {
            // If in silent mode (e.g., during extension startup), do not trigger user interaction, return empty list directly
            if (options.silent) {
                return [];
            }
            try {
                const credentials = await CliAuthFactory.ensureAuthenticated(this.providerKey);
                if (credentials) {
                    await ApiKeyManager.setApiKey(this.providerKey, credentials.access_token);
                    Logger.info(`[CliModelProvider] Loaded authentication credentials from ${this.providerKey} CLI`);
                } else {
                    await vscode.commands.executeCommand(`ccmp.${this.providerKey}.configWizard`);
                    // Unable to get credentials, return empty list
                    Logger.warn(`[CliModelProvider] Unable to load authentication credentials from ${this.providerKey} CLI`);
                    return [];
                }
            } catch (error) {
                Logger.warn(`[CliModelProvider] Failed to load authentication credentials from ${this.providerKey} CLI:`, error);
                return [];
            }
        }
        // Call parent method to return model list
        return super.provideLanguageModelChatInformation(options, token);
    }

    /**
     * Static factory method - Create and activate CLI authentication provider
     */
    static createAndActivate(
        context: vscode.ExtensionContext,
        providerKey: string,
        providerConfig: ProviderConfig
    ): { provider: CliModelProvider; disposables: vscode.Disposable[] } {
        Logger.trace(`${providerConfig.displayName} CLI authentication model extension activated!`);
        // Create provider instance
        const provider = new CliModelProvider(context, providerKey, providerConfig);
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
            await CliModelProvider.startConfigWizard(providerKey, providerConfig.displayName);
            // Clear cache after configuration change
            await provider.modelInfoCache?.invalidateCache(providerKey);
            // Trigger model information change event
            provider._onDidChangeLanguageModelChatInformation.fire();
        });

        const disposables = [providerDisposable, setApiKeyCommand, configWizardCommand];
        disposables.forEach(disposable => context.subscriptions.push(disposable));
        return { provider, disposables };
    }

    /**
     * Start the corresponding configuration wizard based on provider
     * @param providerKey Provider identifier
     * @param displayName Display name
     */
    private static async startConfigWizard(providerKey: string, displayName: string): Promise<void> {
        // Get supported CLI type list
        const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
        const supportedCliIds = supportedCliTypes.map(cli => cli.id);
        // Check if it is a supported CLI type
        if (!supportedCliIds.includes(providerKey)) {
            Logger.warn(`[CliProvider] Unknown CLI authentication provider: ${providerKey}`);
            vscode.window.showWarningMessage(`Unknown provider: ${providerKey}`);
            return;
        }
        // Use unified CLI wizard
        await CliWizard.startWizard(providerKey, displayName);
    }

    /**
     * Override provideChatResponse to update status bar usage after request completion
     */
    override async provideLanguageModelChatResponse(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        options: ProvideLanguageModelChatResponseOptions,
        progress: Progress<vscode.LanguageModelResponsePart>,
        token: CancellationToken
    ): Promise<void> {
        try {
            // Call parent implementation
            await super.provideLanguageModelChatResponse(model, messages, options, progress, token);
        } finally {
            // After request completion, delay status bar usage update
            StatusBarManager.getStatusBar(this.providerKey)?.delayedUpdate(200);
        }
    }
}
