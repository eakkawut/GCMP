/*---------------------------------------------------------------------------------------------
 *  ZhipuAI Configuration Wizard
 *  Provides interactive wizard to configure API key and MCP search service
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { ConfigManager } from './configManager';

export class ZhipuWizard {
    private static readonly PROVIDER_KEY = 'zhipu';

    /**
     * Start configuration wizard
     * Directly enters settings menu without first checking API Key
     */
    static async startWizard(displayName: string, apiKeyTemplate: string): Promise<void> {
        try {
            // Get current MCP status
            const currentMCPStatus = ConfigManager.getZhipuSearchConfig().enableMCP;
            const mcpStatusText = currentMCPStatus ? 'Enabled' : 'Disabled';

            // Get current endpoint
            const currentEndpoint = ConfigManager.getZhipuEndpoint();
            const endpointLabel = currentEndpoint === 'api.z.ai' ? 'International (api.z.ai)' : 'China (open.bigmodel.cn)';

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: `$(key) Update ${displayName} API Key`,
                        detail: `Set or remove ${displayName} API Key`,
                        action: 'updateApiKey'
                    },
                    {
                        label: '$(plug) Enable MCP Search Mode',
                        description: `Current: ${mcpStatusText}`,
                        detail: 'Use search quota within Coding Plan package, Lite(100 trials)/Pro(1K searches)/Max(4K searches)',
                        action: 'toggleMCP'
                    },
                    {
                        label: '$(globe) Set Endpoint',
                        description: `Current: ${endpointLabel}`,
                        detail: 'Set ZhipuAI access endpoint: China (open.bigmodel.cn) or International (api.z.ai)',
                        action: 'endpoint'
                    }
                ],
                {
                    title: `${displayName} Configuration Menu`,
                    placeHolder: 'Select action to perform'
                }
            );

            if (!choice) {
                Logger.debug('User cancelled ZhipuAI configuration wizard');
                return;
            }

            if (choice.action === 'updateApiKey') {
                // Check if API Key already exists
                const hasApiKey = await ApiKeyManager.hasValidApiKey(this.PROVIDER_KEY);
                if (!hasApiKey) {
                    // No API Key, set API Key first
                    Logger.debug('Detected unset API Key, starting API Key setup flow');
                    const apiKeySet = await this.showSetApiKeyStep(displayName, apiKeyTemplate);
                    if (!apiKeySet) {
                        // User cancelled API Key setup
                        Logger.debug('User cancelled API Key setup');
                        return;
                    }
                    Logger.debug('API Key setup successful, proceeding to MCP search configuration');

                    // Configure MCP search service
                    await this.showMCPConfigStep(displayName);
                } else {
                    // Already has API Key, re-setup API Key
                    const apiKeySet = await this.showSetApiKeyStep(displayName, apiKeyTemplate);
                    if (!apiKeySet) {
                        return;
                    }
                }
            } else if (choice.action === 'toggleMCP') {
                await this.showMCPConfigStep(displayName);
            } else if (choice.action === 'endpoint') {
                await this.setEndpoint(displayName);
            }
        } catch (error) {
            Logger.error(`ZhipuAI configuration wizard error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Show set API Key step
     * Allows user to enter empty value to clear API Key
     */
    private static async showSetApiKeyStep(displayName: string, apiKeyTemplate: string): Promise<boolean> {
        const result = await vscode.window.showInputBox({
            prompt: `Enter API Key for ${displayName} (leave blank to clear)`,
            title: `Set ${displayName} API Key`,
            placeHolder: apiKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        // User cancelled input
        if (result === undefined) {
            return false;
        }

        try {
            // Allow empty value to clear API Key
            if (result.trim() === '') {
                Logger.info(`${displayName} API Key has been cleared`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} API Key has been set`);
            }
            return true;
        } catch (error) {
            Logger.error(`API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }

    /**
     * Show MCP search configuration step
     */
    private static async showMCPConfigStep(displayName: string): Promise<void> {
        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: '$(x) Do Not Enable MCP Search Mode',
                    detail: 'Use Web Search API pay-as-you-go interface, use package quota or advanced search features when needed',
                    action: 'disableMCP'
                },
                {
                    label: '$(check) Enable MCP Search Mode',
                    detail: 'Use search quota within Coding Plan package, Lite(100 trials)/Pro(1K searches)/Max(4K searches)',
                    action: 'enableMCP'
                }
            ],
            {
                title: `${displayName} MCP Search Service Configuration`,
                placeHolder: 'Select whether to enable search service MCP mode'
            }
        );

        if (!choice) {
            return;
        }

        try {
            if (choice.action === 'enableMCP') {
                await this.setMCPConfig(true);
            } else {
                await this.setMCPConfig(false);
            }
        } catch (error) {
            Logger.error(`MCP configuration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            vscode.window.showErrorMessage(`MCP configuration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set MCP configuration
     */
    private static async setMCPConfig(enable: boolean): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('ccmp');
            await config.update('zhipu.search.enableMCP', enable, vscode.ConfigurationTarget.Global);
            Logger.info(`Zhipu MCP search service ${enable ? 'enabled' : 'disabled'}`);
        } catch (error) {
            const errorMessage = `Failed to set MCP configuration: ${error instanceof Error ? error.message : 'Unknown error'}`;
            Logger.error(errorMessage);
            throw error;
        }
    }

    /**
     * Set endpoint
     */
    static async setEndpoint(displayName: string): Promise<void> {
        const currentEndpoint = ConfigManager.getZhipuEndpoint();
        const endpointLabel = currentEndpoint === 'api.z.ai' ? 'International (api.z.ai)' : 'China (open.bigmodel.cn)';

        const choice = await vscode.window.showQuickPick(
            [
                {
                    label: '$(home) China (open.bigmodel.cn)',
                    detail: 'Recommended, faster access speed in China',
                    value: 'open.bigmodel.cn'
                },
                {
                    label: '$(globe) International (api.z.ai)',
                    detail: 'For overseas users or when China endpoint is inaccessible',
                    value: 'api.z.ai'
                }
            ],
            {
                title: `${displayName} Endpoint Selection`,
                placeHolder: 'Select endpoint',
                canPickMany: false
            }
        );

        if (!choice) {
            Logger.debug(`User cancelled ${displayName} endpoint selection`);
            return;
        }

        try {
            const config = vscode.workspace.getConfiguration('ccmp.zhipu');
            await config.update('endpoint', choice.value, vscode.ConfigurationTarget.Global);
            Logger.info(`${displayName} endpoint set to: ${choice.value}`);
            vscode.window.showInformationMessage(`${displayName} endpoint has been set to: ${choice.value === 'open.bigmodel.cn' ? 'China' : 'International'}`);
        } catch (error) {
            Logger.error(`Failed to set endpoint: ${error instanceof Error ? error.message : 'Unknown error'}`);
            vscode.window.showErrorMessage(`Endpoint setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Get wizard display name for ZhipuAI
     */
    static getDisplayName(): string {
        return 'ZhipuAI';
    }
}
