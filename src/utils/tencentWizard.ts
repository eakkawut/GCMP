/*---------------------------------------------------------------------------------------------
 *  Tencent Cloud Configuration Wizard
 *  Provides interactive wizard to configure paid models, Coding Plan, Token Plan, and DeepSeek dedicated keys
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';

export class TencentWizard {
    private static readonly PROVIDER_KEY = 'tencent';
    private static readonly CODING_PLAN_KEY = 'tencent-coding';
    private static readonly TOKEN_PLAN_KEY = 'tencent-token';
    private static readonly DEEPSEEK_KEY = 'tencent-deepseek';
    private static readonly TOKENHUB_KEY = 'tencent-tokenhub';

    static async startWizard(
        displayName: string,
        apiKeyTemplate: string,
        codingKeyTemplate?: string,
        tokenPlanKeyTemplate?: string
    ): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) Set Paid Model API Key',
                        detail: 'For Tencent Hunyuan and Tencent Cloud third-party large model pay-as-you-go models',
                        value: 'normal'
                    },
                    {
                        label: '$(key) Set Coding Plan Dedicated Key',
                        detail: 'For Tencent Cloud Coding Plan models',
                        value: 'coding'
                    },
                    {
                        label: '$(key) Set Token Plan Dedicated Key',
                        detail: 'For Tencent Cloud Token Plan models',
                        value: 'tokenPlan'
                    },
                    {
                        label: '$(key) Set DeepSeek Dedicated Key',
                        detail: 'For Tencent Cloud Knowledge Engine Atomic Capability DeepSeek models',
                        value: 'deepseek'
                    },
                    {
                        label: '$(key) Set TokenHub Billing Key',
                        detail: 'For Tencent Cloud TokenHub pay-as-you-go models',
                        value: 'tokenhub'
                    },
                    {
                        label: '$(check-all) Configure All Items in Sequence',
                        detail: 'Configure paid key, Coding Plan key, Token Plan key, DeepSeek key, and TokenHub key in order',
                        value: 'all'
                    }
                ],
                { title: `${displayName} Configuration Wizard`, placeHolder: 'Select items to configure' }
            );
            if (!choice) {
                Logger.debug('User cancelled Tencent Cloud configuration wizard');
                return;
            }

            if (choice.value === 'normal' || choice.value === 'all') {
                await this.setApiKey(apiKeyTemplate);
            }
            if (choice.value === 'coding' || choice.value === 'all') {
                await this.setCodingPlanApiKey(codingKeyTemplate || apiKeyTemplate);
            }
            if (choice.value === 'tokenPlan' || choice.value === 'all') {
                await this.setTokenPlanApiKey(tokenPlanKeyTemplate || apiKeyTemplate);
            }
            if (choice.value === 'deepseek' || choice.value === 'all') {
                await this.setDeepSeekApiKey(apiKeyTemplate);
            }
            if (choice.value === 'tokenhub' || choice.value === 'all') {
                await this.setTokenHubApiKey(apiKeyTemplate);
            }
        } catch (error) {
            Logger.error(`Tencent Cloud configuration wizard error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    static async setApiKey(apiKeyTemplate: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.PROVIDER_KEY,
            prompt: 'Enter Tencent Cloud large model API Key (leave blank to clear)',
            title: 'Set Tencent Cloud large model API Key',
            placeHolder: apiKeyTemplate,
            successMessage: 'Tencent Cloud large model API Key has been set',
            clearMessage: 'Tencent Cloud large model API Key has been cleared'
        });
    }

    static async setCodingPlanApiKey(codingKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.CODING_PLAN_KEY,
            prompt: 'Enter Tencent Cloud Coding Plan dedicated API Key (leave blank to clear)',
            title: 'Set Tencent Cloud Coding Plan dedicated API Key',
            placeHolder: codingKeyTemplate,
            successMessage: 'Tencent Cloud Coding Plan dedicated API Key has been set',
            clearMessage: 'Tencent Cloud Coding Plan dedicated API Key has been cleared'
        });
    }

    static async setTokenPlanApiKey(tokenPlanKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.TOKEN_PLAN_KEY,
            prompt: 'Enter Tencent Cloud Token Plan dedicated API Key (leave blank to clear)',
            title: 'Set Tencent Cloud Token Plan dedicated API Key',
            placeHolder: tokenPlanKeyTemplate,
            successMessage: 'Tencent Cloud Token Plan dedicated API Key has been set',
            clearMessage: 'Tencent Cloud Token Plan dedicated API Key has been cleared'
        });
    }

    static async setDeepSeekApiKey(apiKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.DEEPSEEK_KEY,
            prompt: 'Enter Tencent Cloud DeepSeek dedicated API Key (leave blank to clear)',
            title: 'Set Tencent Cloud DeepSeek dedicated API Key',
            placeHolder: apiKeyTemplate,
            successMessage: 'Tencent Cloud DeepSeek dedicated API Key has been set',
            clearMessage: 'Tencent Cloud DeepSeek dedicated API Key has been cleared'
        });
    }

    static async setTokenHubApiKey(apiKeyTemplate?: string): Promise<void> {
        await this.promptForApiKey({
            providerKey: this.TOKENHUB_KEY,
            prompt: 'Enter Tencent Cloud TokenHub API Key (leave blank to clear)',
            title: 'Set Tencent Cloud TokenHub API Key',
            placeHolder: apiKeyTemplate,
            successMessage: 'Tencent Cloud TokenHub API Key has been set',
            clearMessage: 'Tencent Cloud TokenHub API Key has been cleared'
        });
    }

    private static async promptForApiKey(options: {
        providerKey: string;
        prompt: string;
        title: string;
        placeHolder?: string;
        successMessage: string;
        clearMessage: string;
    }): Promise<boolean> {
        const result = await vscode.window.showInputBox({
            prompt: options.prompt,
            title: options.title,
            placeHolder: options.placeHolder,
            password: true,
            ignoreFocusOut: true
        });

        if (result === undefined) {
            return false;
        }

        try {
            if (result.trim() === '') {
                await ApiKeyManager.deleteApiKey(options.providerKey);
                vscode.window.showInformationMessage(options.clearMessage);
                return false;
            }

            await ApiKeyManager.setApiKey(options.providerKey, result.trim());
            vscode.window.showInformationMessage(options.successMessage);
            return true;
        } catch (error) {
            Logger.error(`Tencent Cloud API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }
}
