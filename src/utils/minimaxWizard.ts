/*---------------------------------------------------------------------------------------------
 *  MiniMax Configuration Wizard
 *  Provides interactive wizard to configure standard key and Coding Plan dedicated key, with endpoint selection support
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { ConfigManager } from './configManager';
import { StatusBarManager } from '../status';
import { MiniMaxConfig } from './configManager';

export class MiniMaxWizard {
    private static readonly PROVIDER_KEY = 'minimax';
    private static readonly CODING_PLAN_KEY = 'minimax-coding';

    /**
     * Start MiniMax configuration wizard
     * Allows user to select which key type to configure
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, codingKeyTemplate?: string): Promise<void> {
        try {
            // Get current endpoint
            const currentEndpoint = ConfigManager.getMinimaxEndpoint();
            const endpointLabel = currentEndpoint === 'minimax.io' ? 'International (minimax.io)' : 'China (minimaxi.com)';

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) Set Standard API Key',
                        detail: 'For MiniMax-M2 standard pay-as-you-go models',
                        value: 'normal'
                    },
                    {
                        label: '$(key) Set Coding Plan Dedicated Key',
                        detail: 'For MiniMax-M2 (Coding Plan) models',
                        value: 'coding'
                    },
                    {
                        label: '$(check-all) Set Both Keys',
                        detail: 'Configure standard key and Coding Plan key in sequence',
                        value: 'both'
                    },
                    {
                        label: '$(globe) Set Coding Plan Endpoint',
                        description: `Current: ${endpointLabel}`,
                        detail: 'Set the endpoint for Coding Plan programming package: China (minimaxi.com) or International (minimax.io)',
                        value: 'endpoint'
                    }
                ],
                { title: `${displayName} Key Configuration`, placeHolder: 'Select items to configure' }
            );

            if (!choice) {
                Logger.debug('User cancelled MiniMax configuration wizard');
                return;
            }

            if (choice.value === 'normal' || choice.value === 'both') {
                await this.setNormalApiKey(displayName, apiKeyTemplate);
            }

            if (choice.value === 'coding' || choice.value === 'both') {
                await this.setCodingPlanApiKey(displayName, codingKeyTemplate || apiKeyTemplate);
            }

            if (choice.value === 'endpoint') {
                await this.setCodingPlanEndpoint(displayName);
            }
        } catch (error) {
            Logger.error(`MiniMax configuration wizard error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set standard API key
     */
    static async setNormalApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `Enter standard API Key for ${displayName} (leave blank to clear)`,
            title: `Set ${displayName} Standard API Key`,
            placeHolder: apiKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        // User cancelled input
        if (result === undefined) {
            return;
        }

        try {
            // Allow empty value to clear API Key
            if (result.trim() === '') {
                Logger.info(`${displayName} standard API Key has been cleared`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
                vscode.window.showInformationMessage(`${displayName} standard API Key has been cleared`);
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} standard API Key has been set`);
                vscode.window.showInformationMessage(`${displayName} standard API Key has been set`);
            }
        } catch (error) {
            Logger.error(`Standard API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set Coding Plan dedicated key
     */
    static async setCodingPlanApiKey(displayName: string, codingKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `Enter Coding Plan dedicated API Key for ${displayName} (leave blank to clear)`,
            title: `Set ${displayName} Coding Plan dedicated API Key`,
            placeHolder: codingKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        // User cancelled input
        if (result === undefined) {
            return;
        }

        try {
            // Allow empty value to clear API Key
            if (result.trim() === '') {
                Logger.info(`${displayName} Coding Plan dedicated API Key has been cleared`);
                await ApiKeyManager.deleteApiKey(this.CODING_PLAN_KEY);
                vscode.window.showInformationMessage(`${displayName} Coding Plan dedicated API Key has been cleared`);
            } else {
                await ApiKeyManager.setApiKey(this.CODING_PLAN_KEY, result.trim());
                Logger.info(`${displayName} Coding Plan dedicated API Key has been set`);
                vscode.window.showInformationMessage(`${displayName} Coding Plan dedicated API Key has been set`);

                // After API Key is set, automatically prompt for endpoint selection
                await this.setCodingPlanEndpoint(displayName);
            }
        } catch (error) {
            Logger.error(`Coding Plan API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        // Check and display status bar
        await StatusBarManager.checkAndShowStatus('minimax');
    }

    /**
     * Select Coding Plan endpoint (China/International)
     */
    static async setCodingPlanEndpoint(displayName: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(home) China (minimaxi.com)',
                        value: 'minimaxi.com' as const
                    },
                    {
                        label: '$(globe) International (minimax.io)',
                        value: 'minimax.io' as const
                    }
                ],
                {
                    title: `${displayName} (Coding Plan) Endpoint Selection`,
                    placeHolder: 'Select endpoint',
                    canPickMany: false
                }
            );

            if (!choice) {
                Logger.debug(`User cancelled ${displayName} Coding Plan endpoint selection`);
                return;
            }

            // Save user's endpoint selection
            await this.saveCodingPlanSite(choice.value);

            const siteLabel = choice.value === 'minimax.io' ? 'International' : 'China';
            Logger.info(`${displayName} Coding Plan endpoint set to: ${siteLabel}`);
            vscode.window.showInformationMessage(`${displayName} Coding Plan endpoint set to: ${siteLabel}`);
        } catch (error) {
            Logger.error(`Coding Plan endpoint setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Save Coding Plan endpoint configuration
     */
    static async saveCodingPlanSite(site: MiniMaxConfig['endpoint']): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('ccmp.minimax');

            // Save to ccmp.minimax.endpoint configuration
            await config.update('endpoint', site, vscode.ConfigurationTarget.Global);
            Logger.info(`Saved Coding Plan endpoint: ${site}`);
        } catch (error) {
            Logger.error(`Failed to save Coding Plan endpoint: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    }
}
