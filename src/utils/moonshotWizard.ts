/*---------------------------------------------------------------------------------------------
 *  MoonshotAI Configuration Wizard
 *  Provides interactive wizard to configure Moonshot key and Kimi For Coding dedicated key
 *--------------------------------------------------------------------------------------------*/

// cSpell:ignore kimi
import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { StatusBarManager } from '../status';

export class MoonshotWizard {
    private static readonly PROVIDER_KEY = 'moonshot';
    private static readonly KIMI_KEY = 'kimi';

    /**
     * Start MoonshotAI configuration wizard
     * Allows user to select which key type to configure
     */
    static async startWizard(displayName: string, apiKeyTemplate: string, codingKeyTemplate?: string): Promise<void> {
        try {
            const choice = await vscode.window.showQuickPick(
                [
                    {
                        label: '$(key) Set Moonshot API Key',
                        detail: 'API key for calling Kimi-K2 series paid models via Moonshot AI Open Platform',
                        value: 'moonshot'
                    },
                    {
                        label: '$(key) Set Kimi For Coding Dedicated Key',
                        detail: 'Dedicated key for Kimi membership plan value-added benefits for code development scenarios',
                        value: 'kimi'
                    },
                    {
                        label: '$(check-all) Set Both Keys',
                        detail: 'Configure Moonshot API key and Kimi For Coding dedicated key in sequence',
                        value: 'both'
                    }
                ],
                { title: `${displayName} Key Configuration`, placeHolder: 'Select items to configure' }
            );

            if (!choice) {
                Logger.debug('User cancelled MoonshotAI configuration wizard');
                return;
            }

            if (choice.value === 'moonshot' || choice.value === 'both') {
                await this.setMoonshotApiKey(displayName, apiKeyTemplate);
            }

            if (choice.value === 'kimi' || choice.value === 'both') {
                await this.setKimiApiKey(displayName, codingKeyTemplate);
            }
        } catch (error) {
            Logger.error(`MoonshotAI configuration wizard error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Set Moonshot API key
     */
    static async setMoonshotApiKey(displayName: string, apiKeyTemplate: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: `Enter API Key for ${displayName} (leave blank to clear)`,
            title: `Set ${displayName} API Key`,
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
                Logger.info(`${displayName} API Key has been cleared`);
                await ApiKeyManager.deleteApiKey(this.PROVIDER_KEY);
                vscode.window.showInformationMessage(`${displayName} API Key has been cleared`);
            } else {
                await ApiKeyManager.setApiKey(this.PROVIDER_KEY, result.trim());
                Logger.info(`${displayName} API Key has been set`);
                vscode.window.showInformationMessage(`${displayName} API Key has been set`);
            }
        } catch (error) {
            Logger.error(`Moonshot API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        // Check and display status bar
        await StatusBarManager.checkAndShowStatus('moonshot');
    }

    /**
     * Set Kimi For Coding dedicated key
     */
    static async setKimiApiKey(_displayName: string, codingKeyTemplate?: string): Promise<void> {
        const result = await vscode.window.showInputBox({
            prompt: 'Enter Kimi For Coding dedicated API Key (leave blank to clear)',
            title: 'Set Kimi For Coding dedicated API Key',
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
                Logger.info('Kimi For Coding dedicated API Key has been cleared');
                await ApiKeyManager.deleteApiKey(this.KIMI_KEY);
                vscode.window.showInformationMessage('Kimi For Coding dedicated API Key has been cleared');
            } else {
                await ApiKeyManager.setApiKey(this.KIMI_KEY, result.trim());
                Logger.info('Kimi For Coding dedicated API Key has been set');
                vscode.window.showInformationMessage('Kimi For Coding dedicated API Key has been set');
            }
        } catch (error) {
            Logger.error(`Kimi For Coding API Key operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            vscode.window.showErrorMessage(`Setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        // Check and display status bar
        await StatusBarManager.checkAndShowStatus('kimi');
    }
}
