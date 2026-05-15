/*---------------------------------------------------------------------------------------------
 *  Volcengine (Volcano Ark) Configuration Wizard
 *  Provides interactive wizard to configure Coding Plan key and Agent Plan dedicated key
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';

export class VolcengineWizard {
    private static readonly PROVIDER_KEY = 'volcengine';
    private static readonly AGENT_PLAN_KEY = 'volcengine-agent';

    /**
     * Start Volcengine Ark configuration wizard
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, tokenKeyTemplate?: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) Set Coding Plan API Key',
                        detail: `For ${displayName} Coding Plan models or pay-as-you-go models`,
                        value: 'coding'
                    },
                    {
                        label: '$(key) Set Agent Plan Dedicated Key',
                        detail: `For ${displayName} Agent Plan models (exclusive API Key)`,
                        value: 'agentPlan'
                    },
                    {
                        label: '$(check-all) Configure All Items in Sequence',
                        detail: 'Configure Coding Plan key and Agent Plan dedicated key in order',
                        value: 'all'
                    }
                ],
                { title: `${displayName} Key Configuration`, placeHolder: 'Select items to configure' }
            );

            if (!choice) {
                Logger.debug('User cancelled Volcengine Ark configuration wizard');
                return;
            }

            if (choice.value === 'coding' || choice.value === 'all') {
                await this.setCodingPlanApiKey(displayName, apiKeyTemplate);
            }

            if (choice.value === 'agentPlan' || choice.value === 'all') {
                await this.setAgentPlanApiKey(displayName, tokenKeyTemplate || apiKeyTemplate);
            }
        } catch (error) {
            Logger.error(`Volcengine Ark configuration wizard error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set Coding Plan API key
     */
    static async setCodingPlanApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `Enter Coding Plan API Key for ${displayName} (leave blank to clear)`,
            title: `Set ${displayName} Coding Plan API Key`,
            placeHolder: apiKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} Coding Plan API Key has been cleared`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
                vscode.window.showInformationMessage(`${displayName} Coding Plan API Key has been cleared`);
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} Coding Plan API Key has been set`);
                vscode.window.showInformationMessage(`${displayName} Coding Plan API Key has been set`);
            }
        } catch (error) {
            Logger.error(
                `Volcengine Ark Coding Plan API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set Agent Plan dedicated key
     */
    static async setAgentPlanApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `Enter Agent Plan dedicated API Key for ${displayName} (leave blank to clear)`,
            title: `Set ${displayName} Agent Plan dedicated API Key`,
            placeHolder: apiKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} Agent Plan dedicated API Key has been cleared`);
                await ApiKeyManager.deleteApiKey(this.AGENT_PLAN_KEY);
                vscode.window.showInformationMessage(`${displayName} Agent Plan dedicated API Key has been cleared`);
            } else {
                await ApiKeyManager.setApiKey(this.AGENT_PLAN_KEY, result.trim());
                Logger.info(`${displayName} Agent Plan dedicated API Key has been set`);
                vscode.window.showInformationMessage(`${displayName} Agent Plan dedicated API Key has been set`);
            }
        } catch (error) {
            Logger.error(
                `Volcengine Ark Agent Plan API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}
