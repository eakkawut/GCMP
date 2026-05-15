/*---------------------------------------------------------------------------------------------
 *  Commit Commands System
 *  Registers and handles commit message generation related commands
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { GeneratorService } from './generatorService';
import { CommitMessage } from './commitMessage';
import { Logger } from '../utils';
import { Repository } from '../types/git';

/**
 * Registers all Commit related commands
 */
export function registerCommitCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    // Register generate commit message command
    disposables.push(
        vscode.commands.registerCommand('ccmp.commit.generateMessage', async (sourceControlRepository?: Repository) => {
            await CommitMessage.generateAndSetCommitMessage(sourceControlRepository);
        })
    );

    // Staged button: force analysis of staged changes only
    disposables.push(
        vscode.commands.registerCommand(
            'ccmp.commit.generateMessageStaged',
            async (resContext?: vscode.SourceControlResourceGroup) => {
                await CommitMessage.generateAndSetCommitMessage(undefined, { scope: 'staged', resContext });
            }
        )
    );

    // Changes button: force analysis of working tree (includes tracked + untracked)
    disposables.push(
        vscode.commands.registerCommand(
            'ccmp.commit.generateMessageWorkingTree',
            async (resContext?: vscode.SourceControlResourceGroup) => {
                await CommitMessage.generateAndSetCommitMessage(undefined, { scope: 'workingTree', resContext });
            }
        )
    );

    // Register select model command
    disposables.push(
        vscode.commands.registerCommand('ccmp.commit.selectModel', async () => {
            try {
                // 1) First select provider (providerKey), then select the provider's model
                const providers = await GeneratorService.getAvailableCommitProviders();
                if (providers.length === 0) {
                    vscode.window.showWarningMessage('No available CCMP providers');
                    return;
                }

                const providerPick = await vscode.window.showQuickPick(
                    providers.map(p => ({
                        label: p.displayName,
                        description: p.providerKey,
                        detail: p.vendor,
                        providerKey: p.providerKey
                    })),
                    { placeHolder: 'Select provider for generating commit messages' }
                );

                if (!providerPick) {
                    return;
                }

                const providerKey = (providerPick as unknown as { providerKey: string }).providerKey;
                const models = await GeneratorService.getAvailableCommitModelsForProvider(providerKey);

                const modelPick = await vscode.window.showQuickPick(
                    models.map(m => ({
                        label: m.name,
                        description: m.id,
                        detail: `${providerKey}:${m.id}`,
                        modelId: m.id,
                        modelName: m.name
                    })),
                    { placeHolder: 'Select model for generating commit messages under this provider' }
                );

                if (!modelPick) {
                    return;
                }

                const { modelId, modelName } = modelPick;

                // 2) Update configuration (save provider + model)
                const config = vscode.workspace.getConfiguration('ccmp.commit');
                await config.update(
                    'model',
                    {
                        provider: providerKey,
                        model: modelId
                    },
                    vscode.ConfigurationTarget.Global
                );
                vscode.window.showInformationMessage(`Model selected: ${providerKey}:${modelName}`);
            } catch (error) {
                Logger.error('[CommitCommands] Model selection failed:', error);
                vscode.window.showErrorMessage('Model selection failed');
            }
        })
    );

    // Add to subscriptions
    context.subscriptions.push(...disposables);

    Logger.trace('[CommitCommands] Commit commands registered');

    return disposables;
}
