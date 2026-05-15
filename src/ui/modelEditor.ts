/**
 * Model Editor - Visual Form Interface
 * Provides visual interface for creating and editing compatible models
 */

import * as vscode from 'vscode';
import { CompatibleModelConfig } from '../utils/compatibleModelManager';
import { configProviders } from '../providers/config';
import { KnownProviders } from '../utils/knownProviders';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { VersionManager } from '../utils/versionManager';
import modelEditorCss from './modelEditor.css?raw';
import modelEditorJs from './modelEditor.js?raw';
import OpenAI from 'openai';

interface EditedModelConfig extends CompatibleModelConfig {
    /** API key (optional, if provided, will automatically set API key) */
    apiKey?: string;
}
/**
 * Delete model marker interface
 */
interface DeleteModelMarker {
    _deleteModel: true;
    modelId: string;
}

/**
 * Model Editor class
 * Manages visual form interface for model creation and editing
 */
export class ModelEditor {
    /**
     * Show model editor
     * @param model Model configuration to edit
     * @param isCreateMode Whether in create mode
     * @returns Updated model configuration, or undefined if cancelled, or delete marker object
     */
    static async show(
        model: CompatibleModelConfig,
        isCreateMode: boolean = false
    ): Promise<EditedModelConfig | DeleteModelMarker | undefined> {
        const panel = vscode.window.createWebviewPanel(
            'compatibleModelEditor',
            isCreateMode ? 'Create New Model' : `Edit Model: ${model.name || 'Untitled Model'}`,
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // Generate form HTML
        panel.webview.html = this.generateHTML(model, isCreateMode, panel.webview);

        return new Promise<CompatibleModelConfig | DeleteModelMarker | undefined>(resolve => {
            const disposables: vscode.Disposable[] = [];

            disposables.push(
                panel.webview.onDidReceiveMessage(
                    async message => {
                        switch (message.command) {
                            case 'getProviders':
                                // Return available provider list
                                this.sendProvidersList(panel.webview);
                                break;
                            case 'fetchModels':
                                // Fetch model list
                                await this.fetchModelsFromAPI(
                                    panel.webview,
                                    message.baseUrl,
                                    message.apiKey,
                                    message.provider
                                );
                                break;
                            case 'save':
                                // Validate returned model object
                                if (
                                    message.model &&
                                    typeof message.model === 'object' &&
                                    message.model.id &&
                                    message.model.name &&
                                    message.model.provider
                                ) {
                                    resolve(message.model);
                                } else {
                                    vscode.window.showErrorMessage('Invalid model data saved');
                                    resolve(undefined);
                                }
                                panel.dispose();
                                break;
                            case 'delete':
                                // Handle delete operation - show confirmation dialog
                                if (message.modelId && typeof message.modelId === 'string') {
                                    const modelName = message.modelName || 'this model';
                                    const confirmed = await vscode.window.showWarningMessage(
                                        `Are you sure you want to delete model "${modelName}"?`,
                                        { modal: true },
                                        'Delete'
                                    );
                                    if (confirmed === 'Delete') {
                                        // Return special delete marker object
                                        resolve({ _deleteModel: true, modelId: message.modelId });
                                        panel.dispose();
                                    }
                                    // If user cancels, don't close panel, continue editing
                                } else {
                                    vscode.window.showErrorMessage('Delete failed: Invalid model ID');
                                }
                                break;
                            case 'cancel':
                                resolve(undefined);
                                panel.dispose();
                                break;
                        }
                    },
                    undefined,
                    disposables
                )
            );

            disposables.push(
                panel.onDidDispose(
                    () => {
                        disposables.forEach(d => d.dispose());
                    },
                    undefined,
                    disposables
                )
            );
        });
    }

    /**
     * Generate model editor HTML
     */
    private static generateHTML(model: CompatibleModelConfig, isCreateMode: boolean, webview: vscode.Webview): string {
        const cspSource = webview.cspSource || '';

        // Prepare model data
        const modelData = {
            ...model,
            id: model?.id || '',
            name: model?.name || '',
            provider: model?.provider || '',
            sdkMode: model?.sdkMode || 'openai',
            tooltip: model?.tooltip || '',
            baseUrl: model?.baseUrl || '',
            model: model?.model || '',
            maxInputTokens: model?.maxInputTokens || 128000,
            maxOutputTokens: model?.maxOutputTokens || 4096,
            toolCalling: model?.capabilities?.toolCalling || false,
            imageInput: model?.capabilities?.imageInput || false,
            useInstructions: model?.useInstructions,
            webSearchTool: model?.webSearchTool,
            customHeader: model?.customHeader ? JSON.stringify(model.customHeader, null, 2) : '',
            extraBody: model?.extraBody ? JSON.stringify(model.extraBody, null, 2) : ''
        };

        const pageTitle = isCreateMode ? 'Create New Model' : `Edit Model: ${this.escapeHtml(modelData.name)}`;

        return `<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${pageTitle}</title>
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};" />
        <style>
            ${modelEditorCss}
        </style>
    </head>
    <body>
        <div class="container">
            <div id="app"></div>
        </div>
        <script>
            ${modelEditorJs}

            // Initialize data
            const initialModelData = ${JSON.stringify(modelData)};
            const initialIsCreateMode = ${isCreateMode};

            // Start editor
            document.addEventListener('DOMContentLoaded', function() {
                initializeEditor(initialModelData, initialIsCreateMode);
            });
        </script>
    </body>
</html>`;
    }

    /**
     * HTML escape function
     */
    private static escapeHtml(text: string): string {
        if (!text) {
            return '';
        }
        const map: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, char => map[char]);
    }

    /**
     * Send provider list to webview
     */
    private static sendProvidersList(webview: vscode.Webview) {
        const providersMap = new Map<string, { id: string; name: string }>();

        // Get providers from built-in configurations (configProviders)
        Object.entries(configProviders).forEach(([key, config]) => {
            providersMap.set(key, {
                id: key,
                name: config.displayName || key
            });
        });

        // Add known providers (KnownProviders)
        Object.entries(KnownProviders).forEach(([key, config]) => {
            providersMap.set(key, {
                id: key,
                name: config.displayName || key
            });
        });

        webview.postMessage({
            command: 'setProviders',
            providers: Array.from(providersMap.values())
        });
    }

    /**
     * Fetch model list from API
     */
    private static async fetchModelsFromAPI(
        webview: vscode.Webview,
        baseUrl: string,
        apiKey?: string,
        provider?: string
    ) {
        try {
            // Validate URL
            if (!baseUrl || !baseUrl.trim()) {
                webview.postMessage({
                    command: 'modelsError',
                    error: 'Please enter BASE URL first'
                });
                return;
            }

            // Build complete URL
            let url = baseUrl.trim();
            // Remove trailing slash
            url = url.replace(/\/+$/, '');

            // Intelligently add /models endpoint
            // If URL does not contain /v1, add /v1/models
            // If already contains /v1, only add /models
            let modelsUrl: string;
            if (url.includes('/v1')) {
                // Already contains /v1, directly add /models
                modelsUrl = `${url}/models`;
            } else {
                // Does not contain /v1, add /v1/models
                modelsUrl = `${url}/v1/models`;
            }

            // Send loading state
            webview.postMessage({
                command: 'modelsLoading'
            });

            // Build request headers
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                'User-Agent': VersionManager.getUserAgent('ModelEditor')
            };

            // If API Key is provided, add to request headers
            let effectiveApiKey = apiKey;
            if (!effectiveApiKey && provider) {
                // If API Key is not provided, try to get from ApiKeyManager
                effectiveApiKey = await ApiKeyManager.getApiKey(provider);
            }
            if (effectiveApiKey && effectiveApiKey.trim()) {
                headers['Authorization'] = `Bearer ${effectiveApiKey.trim()}`;
            }

            // Send request
            const response = await fetch(modelsUrl, {
                method: 'GET',
                headers: headers
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const responseData = (await response.json()) as
                | OpenAI.Models.ModelsPage
                | { models: OpenAI.Models.Model[] | string[] }
                | OpenAI.Models.Model[]
                | string[];

            // Parse model list
            let models: string[] = [];

            // OpenAI format: { data: [{ id: "model-name" }] }
            if ('data' in responseData && Array.isArray(responseData.data)) {
                models = responseData.data
                    .filter((item): item is OpenAI.Models.Model => !!item?.id)
                    .map(item => item.id);
            }
            // Direct array format: ["model1", "model2"]
            else if (Array.isArray(responseData)) {
                models = responseData
                    .filter((item): item is string | OpenAI.Models.Model => typeof item === 'string' || !!item?.id)
                    .map(item => (typeof item === 'string' ? item : item.id));
            }
            // Other format: { models: [...] } or { models: ["model1", "model2"] }
            else if ('models' in responseData && Array.isArray(responseData.models)) {
                models = responseData.models
                    .filter((item): item is string | OpenAI.Models.Model => typeof item === 'string' || !!item?.id)
                    .map(item => (typeof item === 'string' ? item : item.id));
            }

            // Send model list
            webview.postMessage({
                command: 'modelsLoaded',
                models: models
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            webview.postMessage({
                command: 'modelsError',
                error: `Failed to fetch model list: ${errorMessage}`
            });
        }
    }
}
