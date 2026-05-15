/*---------------------------------------------------------------------------------------------
 *  API Key Secure Storage Manager
 *  Uses VS Code SecretStorage for secure API key management
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ApiKeyValidation } from '../types/sharedTypes';
import { Logger } from './logger';
import { StatusBarManager } from '../status';
import { configProviders } from '../providers/config';
import { CliAuthFactory } from '../cli/auth/cliAuthFactory';

/**
 * API Key Secure Storage Manager
 * Supports multi-provider mode
 */
export class ApiKeyManager {
    private static context: vscode.ExtensionContext;
    private static builtinProviders: Set<string> | null = null;

    /**
     * Initialize API key manager
     */
    static initialize(context: vscode.ExtensionContext): void {
        this.context = context;
    }

    /**
     * Get built-in provider list
     */
    private static async getBuiltinProviders(): Promise<Set<string>> {
        if (this.builtinProviders !== null) {
            return this.builtinProviders;
        }
        try {
            this.builtinProviders = new Set(Object.keys(configProviders));
        } catch (error) {
            Logger.warn('Failed to get built-in provider list:', error);
            this.builtinProviders = new Set();
        }
        return this.builtinProviders;
    }

    /**
     * Get secret storage key for provider
     * For built-in providers, use their original key name
     * For custom providers, use 'provider' as the key name
     */
    private static getSecretKey(provider: string): string {
        return `${provider}.apiKey`;
    }

    /**
     * Check if API key exists
     */
    static async hasValidApiKey(provider: string): Promise<boolean> {
        const secretKey = this.getSecretKey(provider);
        const apiKey = await this.context.secrets.get(secretKey);
        return apiKey !== undefined && apiKey.trim().length > 0;
    }

    /**
     * Get API key
     * Built-in providers: use provider name directly as key
     * Custom providers: use 'provider' as key name
     */
    static async getApiKey(provider: string): Promise<string | undefined> {
        const secretKey = this.getSecretKey(provider);
        return await this.context.secrets.get(secretKey);
    }

    /**
     * Validate API key
     */
    static validateApiKey(apiKey: string, _provider: string): ApiKeyValidation {
        // Empty value allowed for clearing key
        if (!apiKey || apiKey.trim().length === 0) {
            return { isValid: true, isEmpty: true };
        }
        // No specific format validation, any non-empty value is valid
        return { isValid: true };
    }

    /**
     * Set API key to secure storage
     */
    static async setApiKey(provider: string, apiKey: string): Promise<void> {
        const secretKey = this.getSecretKey(provider);
        await this.context.secrets.store(secretKey, apiKey);
    }

    /**
     * Delete API key
     */
    static async deleteApiKey(provider: string): Promise<void> {
        const secretKey = this.getSecretKey(provider);
        await this.context.secrets.delete(secretKey);
    }

    /**
     * Ensure API key exists, prompt user to input if not
     * @param provider Provider identifier
     * @param displayName Display name
     * @param throwError Whether to throw error on check failure, default true
     * @returns Whether check succeeded
     */
    static async ensureApiKey(provider: string, displayName: string, throwError = true): Promise<boolean> {
        // CLI auth providers need special handling
        const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
        const cliAuthProviders = supportedCliTypes.map(cli => cli.id);
        if (cliAuthProviders.includes(provider)) {
            // CLI provider, load from CLI
            return await this.handleCliAuth(provider, displayName);
        }

        // Non-CLI auth providers use original logic
        if (await this.hasValidApiKey(provider)) {
            return true;
        }

        // Check if built-in provider
        const builtinProviders = await this.getBuiltinProviders();
        if (builtinProviders.has(provider)) {
            // Built-in provider: trigger corresponding setup command, let Provider handle specific config
            const commandId = `ccmp.${provider}.setApiKey`;
            await vscode.commands.executeCommand(commandId);
        } else {
            // Custom provider: directly prompt for API key input
            await this.promptAndSetApiKey(provider, provider, 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
        }

        // Verify if valid after setup
        const isValid = await this.hasValidApiKey(provider);
        if (!isValid && throwError) {
            throw new Error(`API Key required to use ${displayName} model`);
        }
        return isValid;
    }

    /**
     * Force refresh CLI authentication credentials
     * @param provider Provider identifier
     * @param displayName Display name
     * @returns Whether refresh succeeded
     */
    static async forceRefreshCliAuth(provider: string, displayName: string): Promise<boolean> {
        // Check if CLI auth provider
        const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
        const cliAuthProviders = supportedCliTypes.map(cli => cli.id);
        if (!cliAuthProviders.includes(provider)) {
            Logger.warn(`[ApiKeyManager] ${provider} is not a CLI auth provider`);
            return false;
        }

        const apiKey = await CliAuthFactory.getInstance(provider)?.getApiKey(true);
        if (apiKey) {
            Logger.info(`[ApiKeyManager] Force refreshed ${displayName} CLI auth`);
            return true;
        }
        Logger.warn(`[ApiKeyManager] Failed to load auth credentials from ${displayName} CLI`);
        return false;
    }

    /**
     * Handle CLI authentication
     * @param provider Provider identifier
     * @param displayName Display name
     * @param throwError Whether to throw error on check failure
     * @returns Whether authentication succeeded
     */
    private static async handleCliAuth(provider: string, displayName: string): Promise<boolean> {
        const credentials = await CliAuthFactory.ensureAuthenticated(provider);
        if (credentials) {
            const apiKey = await CliAuthFactory.getInstance(provider)?.getApiKey();
            if (!apiKey) {
                Logger.warn(`[ApiKeyManager] ${displayName} CLI failed to load auth credentials`);
                return false;
            }
            // Save access key to secret storage after CLI validation passes
            await this.setApiKey(provider, apiKey);
            Logger.info(`[ApiKeyManager] Loaded auth credentials from ${displayName} CLI`);
            return true;
        }
        return false;
    }

    /**
     * Handle API key replacement in customHeader
     * Replace ${APIKEY} with actual API key (case-insensitive)
     */
    static processCustomHeader(
        customHeader: Record<string, string> | undefined,
        apiKey: string
    ): Record<string, string> {
        if (!customHeader) {
            return {};
        }

        const processedHeader: Record<string, string> = {};
        for (const [key, value] of Object.entries(customHeader)) {
            // Replace ${APIKEY} with actual API key (case-insensitive)
            const processedValue = value.replace(/\$\{\s*APIKEY\s*\}/gi, apiKey);
            processedHeader[key] = processedValue;
        }
        return processedHeader;
    }

    /**
     * Generic API key input and setup logic
     */
    static async promptAndSetApiKey(provider: string, displayName: string, placeHolder: string): Promise<void> {
        const apiKey = await vscode.window.showInputBox({
            prompt: `Enter your ${displayName} API Key (leave blank to clear)`,
            title: `Set ${displayName} API Key`,
            placeHolder: placeHolder,
            password: true,
            ignoreFocusOut: true
        });
        if (apiKey !== undefined) {
            const validation = this.validateApiKey(apiKey, provider);
            if (validation.isEmpty) {
                await this.deleteApiKey(provider);
                vscode.window.showInformationMessage(`${displayName} API Key has been cleared`);
            } else {
                await this.setApiKey(provider, apiKey.trim());
                vscode.window.showInformationMessage(`${displayName} API Key has been set`);
            }
            // After API key change, related components will auto-update via ConfigManager's config listener
            Logger.debug(`API key updated: ${provider}`);

            // After API key setup, update status bar
            if (provider === 'deepseek' || provider === 'moonshot') {
                try {
                    StatusBarManager.checkAndShowStatus(provider);
                } catch (error) {
                    Logger.warn('Failed to update status bar:', provider, error);
                }
            }
        }
    }
}
