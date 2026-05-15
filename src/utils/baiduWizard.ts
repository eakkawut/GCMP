/*-----------------------------------------------------------------
 *  Baidu Qianfan Configuration Wizard
 *  Provides interactive wizard to configure standard API key and Coding Plan dedicated key
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { StatusBarManager } from '../status';
export class BaiduWizard {
    private static readonly PROVIDER_KEY = 'baidu';
    private static readonly CODING_PLAN_KEY = 'baidu-coding';
    /**
     * Start Baidu Qianfan configuration wizard
     * Allows user to select which key type to configure
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, codingKeyTemplate?: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) Set Standard API Key',
                        detail: 'For pay-as-you-go models (ERNIE-5.0, GLM-5, etc.)',
                        value: 'normal'
                    },
                    {
                        label: '$(key) Set Coding Plan Dedicated Key',
                        detail: 'For Coding Plan programming package models',
                        value: 'coding'
                    },
                    {
                        label: '$(check-all) Set Both Keys',
                        detail: 'Configure standard key and Coding Plan key in sequence',
                        value: 'both'
                    }
                ],
                { title: `${displayName} Key Configuration`, placeHolder: 'Select items to configure' }
            );
            if (!choice) {
                Logger.debug('User cancelled Baidu Qianfan configuration wizard');
                return;
            }
            if (choice.value === 'normal' || choice.value === 'both') {
                await this.setNormalApiKey(displayName, apiKeyTemplate);
            }
            if (choice.value === 'coding' || choice.value === 'both') {
                await this.setCodingPlanApiKey(displayName, codingKeyTemplate || apiKeyTemplate);
            }
        } catch (error) {
            Logger.error(`Baidu Qianfan configuration wizard error: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
            }
        } catch (error) {
            Logger.error(`Coding Plan API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
        // Check and display status bar
        await StatusBarManager.checkAndShowStatus('baidu');
    }
}
