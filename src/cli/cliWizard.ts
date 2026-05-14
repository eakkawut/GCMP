/*---------------------------------------------------------------------------------------------
 *  CLI Configuration Wizard
 *  Provides a unified interactive wizard for configuring authentication
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CliAuthFactory } from './auth/cliAuthFactory';
import { Logger } from '../utils';

/**
 * Start the CLI configuration wizard
 */
export async function startCliWizard(context: vscode.ExtensionContext): Promise<void> {
    Logger.trace('Starting CLI configuration wizard...');

    // Get supported CLI authentication types
    const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();

    if (supportedCliTypes.length === 0) {
        Logger.warn('No CLI authentication types supported');
        vscode.window.showInformationMessage('No CLI authentication types supported');
        return;
    }

    // Show quick pick for authentication type selection
    const selectedType = await vscode.window.showQuickPick(
        supportedCliTypes.map(cli => ({
            label: cli.name,
            description: cli.description,
            detail: cli.id,
            target: cli
        })),
        {
            placeHolder: 'Select the tool you want to authenticate with',
            ignoreFocusOut: true
        }
    );

    if (!selectedType) {
        Logger.trace('CLI configuration wizard cancelled');
        return;
    }

    // Execute the authentication flow
    try {
        await CliAuthFactory.executeAuthFlow(selectedType.target.id, context);
        vscode.window.showInformationMessage(`Authentication with ${selectedType.label} completed successfully`);
    } catch (error) {
        Logger.error(`Authentication failed for ${selectedType.label}:`, error);
        vscode.window.showErrorMessage(`Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * CLI configuration wizard provider
 */
export class CliWizardProvider implements vscode.WebviewPanelSerializer<vscode.WebviewPanelState> {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: vscode.WebviewPanelState): Promise<void> {
        Logger.trace('Deserializing CLI wizard webview panel');
        // Restore the webview panel state
        webviewPanel.webview.html = this.getWebviewContent();
    }

    private getWebviewContent(): string {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>CLI Configuration Wizard</title>
            </head>
            <body>
                <h1>CLI Configuration Wizard</h1>
                <p>Configure your CLI authentication settings here</p>
            </body>
            </html>
        `;
    }
}
