/*---------------------------------------------------------------------------------------------
 *  Dashscope (Alibaba Cloud) Configuration Wizard
 *  Provides interactive wizard to configure standard key, Coding Plan dedicated key, and Token Plan dedicated key
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';

export class DashscopeWizard {
    private static readonly PROVIDER_KEY = 'dashscope';
    private static readonly CODING_PLAN_KEY = 'dashscope-coding';
    private static readonly TOKEN_PLAN_KEY = 'dashscope-token';

    /**
     * Start Dashscope configuration wizard
     */
    static async startWizard(
        displayName: string,
        apiKeyTemplate: string,
        codingKeyTemplate?: string,
        tokenKeyTemplate?: string
    ): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) Set API Key',
                        detail: `For ${displayName} standard pay-as-you-go models`,
                        value: 'normal'
                    },
                    {
                        label: '$(key) Set Coding Plan Dedicated Key',
                        detail: `For ${displayName} Coding Plan models`,
                        value: 'coding'
                    },
                    {
                        label: '$(key) Set Token Plan Dedicated Key',
                        detail: `For ${displayName} Token Plan models`,
                        value: 'tokenPlan'
                    },
                    {
                        label: '$(check-all) Configure All Items in Sequence',
                        detail: 'Configure standard key, Coding Plan dedicated key, and Token Plan dedicated key in order',
                        value: 'all'
                    }
                ],
                { title: `${displayName} Key Configuration`, placeHolder: 'Select items to configure' }
            );

            if (!choice) {
                Logger.debug('User cancelled Dashscope configuration wizard');
                return;
            }

            if (choice.value === 'normal' || choice.value === 'all') {
                await this.setNormalApiKey(displayName, apiKeyTemplate);
            }

            if (choice.value === 'coding' || choice.value === 'all') {
                await this.setCodingPlanApiKey(displayName, codingKeyTemplate || apiKeyTemplate);
            }

            if (choice.value === 'tokenPlan' || choice.value === 'all') {
                await this.setTokenPlanApiKey(displayName, tokenKeyTemplate || codingKeyTemplate || apiKeyTemplate);
            }
        } catch (error) {
            Logger.error(`Dashscope configuration wizard error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set Dashscope standard API key
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
            Logger.error(`Dashscope API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set Dashscope Coding Plan dedicated key
     */
    static async setCodingPlanApiKey(displayName: string, codingKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `Enter Coding Plan dedicated API Key for ${displayName} (leave blank to clear)`,
            title: `Set ${displayName} Coding Plan dedicated API Key`,
            placeHolder: codingKeyTemplate,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return;
        }

        try {
            if (result.trim() === '') {
                Logger.info(`${displayName} Coding Plan dedicated API Key has been cleared`);
                await ApiKeyManager.deleteApiKey(this.CODING_PLAN_KEY);
                vscode.window.showInformationMessage(`${displayName} Coding Plan dedicated API Key has been cleared`);
            } else {
                await ApiKeyManager.setApiKey(this.CODING_PLAN_KEY, result.trim());
                Logger.info(`${displayName} Coding Plan dedicated API Key has been set`);
                vscode.window.showInformationMessage(`${displayName} Coding Plan dedicated API Key has been set`);
            }
        } catch (error) {
            Logger.error(
                `Dashscope Coding Plan API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set Dashscope Token Plan dedicated key
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
                `Dashscope Token Plan API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}
