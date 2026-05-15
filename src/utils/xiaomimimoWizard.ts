/*---------------------------------------------------------------------------------------------
 *  Xiaomi MiMo Configuration Wizard
 *  Provides interactive wizard to configure standard key and Token Plan dedicated key
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { ConfigManager, XiaomimimoConfig } from './configManager';

export class XiaomimimoWizard {
    private static readonly PROVIDER_KEY = 'xiaomimimo';
    private static readonly TOKEN_PLAN_KEY = 'xiaomimimo-token';

    /**
     * Start Xiaomi MiMo configuration wizard
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, tokenKeyTemplate?: string): Promise<void> {
        try {
            const currentEndpoint = ConfigManager.getXiaomimimoEndpoint();
            const endpointLabels: Record<string, string> = {
                cn: 'China (cn)',
                sgp: 'Singapore (sgp)',
                ams: 'Europe (ams)'
            };

            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) Set API Key',
                        detail: `For ${displayName} standard pay-as-you-go models`,
                        value: 'normal'
                    },
                    {
                        label: '$(key) Set Token Plan Dedicated Key',
                        detail: `For ${displayName} Token Plan models`,
                        value: 'tokenPlan'
                    },
                    {
                        label: '$(globe) Set Token Plan Endpoint',
                        description: `Current: ${endpointLabels[currentEndpoint]}`,
                        detail: 'Set Xiaomi MiMo Token Plan endpoint: China (cn), Singapore (sgp), or Europe (ams)',
                        value: 'endpoint'
                    },
                    {
                        label: '$(check-all) Set Both Keys',
                        detail: 'Configure standard key and Token Plan dedicated key in sequence',
                        value: 'both'
                    }
                ],
                { title: `${displayName} Key Configuration`, placeHolder: 'Select items to configure' }
            );

            if (!choice) {
                Logger.debug('User cancelled Xiaomi MiMo configuration wizard');
                return;
            }

            if (choice.value === 'normal' || choice.value === 'both') {
                await this.setNormalApiKey(displayName, apiKeyTemplate);
            }
            if (choice.value === 'tokenPlan' || choice.value === 'both') {
                await this.setTokenPlanApiKey(displayName, tokenKeyTemplate || apiKeyTemplate);
            }
            if (choice.value === 'endpoint') {
                await this.setTokenPlanEndpoint(displayName);
            }
        } catch (error) {
            Logger.error(`Xiaomi MiMo configuration wizard error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set Xiaomi MiMo standard API key
     */
    static async setNormalApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `Enter API Key for ${displayName} (leave blank to clear)`,
            title: `Set ${displayName} API Key`,
            placeHolder: apiKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} API Key has been cleared`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
                vscode.window.showInformationMessage(`${displayName} API Key has been cleared`);
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} API Key has been set`);
                vscode.window.showInformationMessage(`${displayName} API Key has been set`);
            }
        } catch (error) {
            Logger.error(`Xiaomi MiMo API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set Xiaomi MiMo Token Plan dedicated key
     */
    static async setTokenPlanApiKey(displayName: string, tokenKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `Enter Token Plan dedicated API Key for ${displayName} (leave blank to clear)`,
            title: `Set ${displayName} Token Plan dedicated API Key`,
            placeHolder: tokenKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} Token Plan dedicated API Key has been cleared`);
                await ApiKeyManager.deleteApiKey(this.TOKEN_PLAN_KEY);
                vscode.window.showInformationMessage(`${displayName} Token Plan dedicated API Key has been cleared`);
            } else {
                await ApiKeyManager.setApiKey(this.TOKEN_PLAN_KEY, result.trim());
                Logger.info(`${displayName} Token Plan dedicated API Key has been set`);
                vscode.window.showInformationMessage(`${displayName} Token Plan dedicated API Key has been set`);
            }
        } catch (error) {
            Logger.error(
                `Xiaomi MiMo Token Plan API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Select Token Plan endpoint
     */
    static async setTokenPlanEndpoint(displayName: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(home) China (cn)',
                        value: 'cn' as const
                    },
                    {
                        label: '$(location) Singapore (sgp)',
                        value: 'sgp' as const
                    },
                    {
                        label: '$(globe) Europe (ams)',
                        value: 'ams' as const
                    }
                ],
                {
                    title: `${displayName} Token Plan Endpoint Selection`,
                    placeHolder: 'Select endpoint',
                    canPickMany: false
                }
            );

            if (!choice) {
                Logger.debug(`User cancelled ${displayName} Token Plan endpoint selection`);
                return;
            }

            await this.saveTokenPlanEndpoint(choice.value);

            const endpointLabels: Record<string, string> = {
                cn: 'China endpoint',
                sgp: 'Singapore endpoint',
                ams: 'Europe endpoint'
            };
            Logger.info(`${displayName} Token Plan endpoint set to: ${endpointLabels[choice.value]}`);
            vscode.window.showInformationMessage(
                `${displayName} Token Plan endpoint set to: ${endpointLabels[choice.value]}`
            );
        } catch (error) {
            Logger.error(`Token Plan endpoint setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Save Token Plan endpoint configuration
     */
    static async saveTokenPlanEndpoint(endpoint: XiaomimimoConfig['endpoint']): Promise<void> {
        try {
            const config = vscode.workspace.getConfiguration('ccmp.xiaomimimo');
            await config.update('endpoint', endpoint, vscode.ConfigurationTarget.Global);
            Logger.info(`Saved Token Plan endpoint: ${endpoint}`);
        } catch (error) {
            Logger.error(`Failed to save Token Plan endpoint: ${error instanceof Error ? error.message : 'Unknown error'}`);
            throw error;
        }
    }
}
