/*---------------------------------------------------------------------------------------------
 *  CLI Authentication Command Registration
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CliAuthFactory } from './auth/cliAuthFactory';

/**
 * Register CLI authentication commands
 */
export function registerCliAuthCommands(context: vscode.ExtensionContext): void {
    const cliAuthCommand = vscode.commands.registerCommand('ccmp.cli.auth', async () => {
        const cliTypes = CliAuthFactory.getSupportedCliTypes();

        const selected = await vscode.window.showQuickPick(
            cliTypes.map(cli => ({
                label: cli.name,
                cliType: cli.id
            })),
            {
                placeHolder: 'Select the CLI tool to authenticate'
            }
        );
        if (selected) {
            const credentials = await CliAuthFactory.ensureAuthenticated(selected.cliType);
            if (credentials) {
                vscode.window.showInformationMessage(`${selected.label} authentication successful!`);
            } else {
                vscode.window.showErrorMessage(`${selected.label} authentication failed, please run CLI login first`);
            }
        }
    });

    context.subscriptions.push(cliAuthCommand);
}
