/*---------------------------------------------------------------------------------------------
 *  Custom Model Manager
 *  Manages custom models for standalone compatible providers
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Logger } from './logger';
import { ApiKeyManager } from './apiKeyManager';
import { StatusBarManager } from '../status';
import { KnownProviders } from './knownProviders';
import { configProviders } from '../providers/config';
import { ModelEditor } from '../ui/modelEditor';

/**
 * Back button click event
 */
interface BackButtonClick {
    back: true;
}

/**
 * Check if back button click
 */
function isBackButtonClick(value: unknown): value is BackButtonClick {
    return typeof value === 'object' && (value as BackButtonClick)?.back === true;
}

/**
 * Custom model configuration interface
 */
export interface CompatibleModelConfig {
    /** Model ID */
    id: string;
    /** Model name */
    name: string;
    /** Provider identifier */
    provider: string;
    /** Model description */
    tooltip?: string;
    /** API base URL */
    baseUrl?: string;
    /**
     * Custom API endpoint path (optional)
     * Used to replace the default path appended to baseUrl (e.g., /chat/completions, /responses).
     * - Relative path (e.g., /custom/path): concatenated with baseUrl
     * - Full URL (e.g., https://api.example.com/custom): used directly as request address
     * Only effective for openai, openai-sse, openai-responses modes.
     */
    endpoint?: string;
    /** Model name used in API requests (optional) */
    model?: string;
    /**
     * Model family identifier (optional)
     * Used to determine the editing tool mode for the model
     * If not set, default will be auto-inferred based on sdkMode:
     * - anthropic → claude-sonnet-4.6
     * - openai/openai-sse: id/model contains gpt → gpt-5.2, otherwise → claude-sonnet-4.6
     * - openai-responses → gpt-5.2
     * - gemini-sse → gemini-3-pro
     */
    family?: string;
    /** Maximum input token count */
    maxInputTokens: number;
    /** Maximum output token count */
    maxOutputTokens: number;
    /** SDK mode */
    sdkMode?: 'anthropic' | 'openai' | 'openai-sse' | 'openai-responses' | 'gemini-sse';
    /** Model capabilities */
    capabilities: {
        /** Tool calling */
        toolCalling: boolean;
        /** Image input */
        imageInput: boolean;
    };
    /** Custom HTTP headers (optional) */
    customHeader?: Record<string, string>;
    /** Additional request body parameters (optional) */
    extraBody?: Record<string, unknown>;
    /**
     * Whether to use instructions parameter in Responses API (default false)
     *  - When set to true, use instructions parameter to pass system instructions
     *  - When set to false, pass system message instructions via user messages
     */
    useInstructions?: boolean;
    /** Whether to enable Anthropic native web_search tool (only effective for sdkMode=anthropic) */
    webSearchTool?: boolean;
    /**
     * Deep thinking mode options list (optional)
     * Used for UI configuration selection, determines the thinking mode range users can choose:
     * - disabled: Force disable deep thinking capability
     * - enabled: Force enable deep thinking capability
     * - auto: Model decides whether deep thinking is needed
     * - adaptive: Model adaptively adjusts deep thinking mode based on context
     */
    thinking?: ('disabled' | 'enabled' | 'auto' | 'adaptive')[];
    /**
     * Thinking mode parameter format (optional)
     * - boolean: Use boolean format { enable_thinking: true/false }
     * - object: Use object format { thinking: { type: 'enabled' | 'disabled' } }
     * Default is 'boolean', only effective for openai/openai-sse modes
     */
    thinkingFormat?: 'boolean' | 'object';
    /**
     * Chain-of-thought length adjustment options (optional)
     * Used for UI configuration selection, balancing effects, latency, and cost needs for different scenarios:
     * - none/minimal: Disable thinking, answer directly
     * - low: Lightweight thinking, focused on fast response
     * - medium: Balanced mode, balancing speed and depth
     * - high: Deep analysis for complex problems
     * - xhigh: Maximum reasoning depth, slower speed
     * - max: Absolute highest capability, no token consumption limit
     */
    reasoningEffort?: ('none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')[];
    /** Whether created by wizard (internal flag, not persisted) */
    _isFromWizard?: boolean;
}

/**
 * Custom model manager class
 */
export class CompatibleModelManager {
    private static models: CompatibleModelConfig[] = [];
    private static configListener: vscode.Disposable | null = null;
    private static _onDidChangeModels = new vscode.EventEmitter<void>();
    static readonly onDidChangeModels = CompatibleModelManager._onDidChangeModels.event;
    private static isSaving = false; // Flag for saving to avoid triggering config listener

    static getSdkModeLabel(sdkMode: CompatibleModelConfig['sdkMode']): string {
        switch (sdkMode) {
            case 'anthropic':
                return 'Anthropic';
            case 'gemini-sse':
                return 'Gemini';
            case 'openai':
            case 'openai-sse':
            case 'openai-responses':
            default:
                return 'OpenAI';
        }
    }

    /**
     * Initialize model manager
     */
    static initialize(): void {
        this.loadModels();
        this.setupConfigListener();
        Logger.debug('Custom model manager initialized');
    }

    /**
     * Dispose resources
     */
    static dispose(): void {
        if (this.configListener) {
            this.configListener.dispose();
            this.configListener = null;
        }
        this._onDidChangeModels.dispose();
        Logger.trace('Custom model manager disposed');
    }

    /**
     * Set up configuration file change listener
     */
    private static setupConfigListener(): void {
        // Dispose old listener
        if (this.configListener) {
            this.configListener.dispose();
        }
        // Listen for ccmp configuration changes
        this.configListener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('ccmp.compatibleModels')) {
                // If saving, ignore config changes (avoid overwriting in-memory data with reload)
                if (this.isSaving) {
                    Logger.debug('Saving configuration, skipping reload');
                    return;
                }
                Logger.info('Detected custom model config change, reloading...');
                this.loadModels();
                this._onDidChangeModels.fire();
            }
        });
    }

    /**
     * Load models from configuration
     */
    private static loadModels(): void {
        try {
            const config = vscode.workspace.getConfiguration('ccmp');
            const modelsData = config.get<CompatibleModelConfig[]>('compatibleModels', []);
            this.models = (modelsData || []).filter(
                model => model != null && typeof model === 'object' && model.id && model.name && model.provider
            ); // Filter out invalid models
            Logger.debug(`Loaded ${this.models.length} custom models`);
        } catch (error) {
            Logger.error('Failed to load custom models:', error);
            this.models = [];
        }
    }

    /**
     * Save models to configuration
     */
    private static async saveModels(): Promise<void> {
        try {
            this.isSaving = true; // Set save flag
            const config = vscode.workspace.getConfiguration('ccmp');
            // Remove internal flag fields and undefined/null values when saving
            const modelsToSave = this.models
                .filter(model => model != null && typeof model === 'object')
                .map(model => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    const { _isFromWizard, ...rest } = model;
                    // Remove fields with undefined or null values (fields cleared by user)
                    const cleaned: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(rest)) {
                        // Filter out undefined and null values
                        if (value !== undefined && value !== null) {
                            cleaned[key] = value;
                        }
                    }
                    return cleaned;
                });

            Logger.debug('Preparing to save models, cleaned data:', JSON.stringify(modelsToSave, null, 2));

            await config.update('compatibleModels', modelsToSave, vscode.ConfigurationTarget.Global);
            Logger.debug('Custom models saved to configuration');

            // Immediately reload from config file after successful save to ensure memory and config file sync
            // This ensures cleared fields (undefined/null) are also removed from memory
            this.loadModels();

            // Manually trigger model change event to notify all listeners (e.g., CompatibleProvider)
            this._onDidChangeModels.fire();
            Logger.debug('Model change event triggered');
        } catch (error) {
            Logger.error('Failed to save custom models:', error);
            throw error;
        } finally {
            // Delayed reset flag to ensure config change event has been triggered
            setTimeout(() => {
                this.isSaving = false;
            }, 100);
        }
    }

    /**
     * Get all models
     */
    static getModels(): CompatibleModelConfig[] {
        return this.models;
    }

    /**
     * Get raw data (unprocessed) for specified model from configuration file
     * @param modelId Model ID
     * @returns Raw model config, or undefined
     */
    private static getRawModelFromConfig(modelId: string): CompatibleModelConfig | undefined {
        try {
            const config = vscode.workspace.getConfiguration('ccmp');
            const modelsData = config.get<CompatibleModelConfig[]>('compatibleModels', []);
            const rawModel = modelsData.find(model => model && model.id === modelId);

            // Return raw data without any processing (including not adding default tooltip)
            return rawModel;
        } catch (error) {
            Logger.error('Failed to read raw model data from config file:', error);
            return undefined;
        }
    }
    /**
     * Add model
     */
    static async addModel(model: CompatibleModelConfig): Promise<void> {
        // Check if model is empty
        if (!model) {
            throw new Error('Model configuration cannot be empty');
        }

        // Check required fields
        if (!model.id || !model.name || !model.provider) {
            throw new Error('Model configuration missing required fields (id, name, provider)');
        }

        // Check if model ID already exists
        if (this.models.some(m => m.id === model.id)) {
            throw new Error(`Model ID "${model.id}" already exists`);
        }

        // Ensure model object is valid
        if (typeof model !== 'object') {
            throw new Error('Model configuration must be a valid object');
        }

        // Ensure capabilities object exists
        if (!model.capabilities || typeof model.capabilities !== 'object') {
            model.capabilities = {
                toolCalling: false,
                imageInput: false
            };
        }

        this.models.push(model);
        await this.saveModels();
        Logger.info(`Added custom model: ${model.name} (${model.provider}, ${model.sdkMode})`);

        StatusBarManager.compatible?.checkAndShowStatus();
    }

    /**
     * Update model
     */
    static async updateModel(id: string, updates: Partial<CompatibleModelConfig>): Promise<void> {
        // Check if update data is empty
        if (!updates) {
            throw new Error('Update data cannot be empty');
        }

        const index = this.models.findIndex(m => m.id === id);
        if (index === -1) {
            throw new Error(`Model ID "${id}" not found`);
        }

        // Ensure existing model is not empty
        if (!this.models[index]) {
            throw new Error(`Model data corrupted, cannot update model ID "${id}"`);
        }

        this.models[index] = { ...this.models[index], ...updates };
        await this.saveModels();
        Logger.info(`Updated custom model: ${id}`);

        StatusBarManager.compatible?.checkAndShowStatus();
    }

    /**
     * Delete model
     */
    static async removeModel(id: string): Promise<void> {
        const index = this.models.findIndex(m => m.id === id);
        if (index === -1) {
            throw new Error(`Model ID "${id}" not found`);
        }
        const removedModel = this.models[index];

        // Ensure model to delete is not empty
        if (!removedModel) {
            throw new Error(`Model data corrupted, cannot delete model ID "${id}"`);
        }

        this.models.splice(index, 1);
        await this.saveModels();
        Logger.info(`Deleted custom model: ${removedModel.name}`);

        await StatusBarManager.compatible?.checkAndShowStatus();
    }

    /**
     * Configure model or update API key (main entry)
     */
    static async configureModelOrUpdateAPIKey(): Promise<void> {
        // If no custom models, go directly to add flow
        if (this.models.length === 0) {
            Logger.info('No custom models, going directly to add flow');
            await this.configureModels();
            return;
        }

        interface BYOKQuickPickItem extends vscode.QuickPickItem {
            action: 'apiKey' | 'configureModels';
        }
        const options: BYOKQuickPickItem[] = [
            {
                label: '$(key) Manage API Keys',
                detail: 'Update or configure provider or model API keys',
                action: 'apiKey'
            },
            {
                label: '$(settings-gear) Configure Models',
                detail: 'Add, edit, or delete model configurations',
                action: 'configureModels'
            }
        ];

        const quickPick = vscode.window.createQuickPick<BYOKQuickPickItem>();
        quickPick.title = 'Manage OpenAI / Anthropic Compatible Models';
        quickPick.placeholder = 'Select an action';
        quickPick.items = options;
        quickPick.ignoreFocusOut = true;

        const selected = await new Promise<BYOKQuickPickItem | undefined>(resolve => {
            quickPick.onDidAccept(() => {
                const selectedItem = quickPick.selectedItems[0];
                resolve(selectedItem);
                quickPick.hide();
            });
            quickPick.onDidHide(() => {
                resolve(undefined);
            });
            quickPick.show();
        });

        if (selected?.action === 'apiKey') {
            await this.promptAndSetApiKey();
        } else if (selected?.action === 'configureModels') {
            await this.configureModels();
        }
        this._onDidChangeModels.fire();
    }

    /**
     * Prompt and set API key - set by provider
     */
    private static async promptAndSetApiKey(): Promise<void> {
        try {
            // Get all configured providers
            const providers = await this.getUniqueProviders();
            if (providers.length === 0) {
                vscode.window.showWarningMessage('No custom model configuration yet, please add models first');
                return;
            }
            // If only one provider, directly set that provider's API key
            if (providers.length === 1) {
                await this.setApiKeyForProvider(providers[0]);
                return;
            }

            // Get historical custom providers
            const historicalProviders = await this.getHistoricalCustomProviders();

            const customProviders: string[] = [];
            const knownProviders: string[] = [];
            const builtinProviders: string[] = [];

            providers.forEach(provider => {
                if (historicalProviders.includes(provider)) {
                    customProviders.push(provider);
                } else if (provider in KnownProviders) {
                    knownProviders.push(provider);
                } else if (provider in configProviders) {
                    builtinProviders.push(provider);
                } else {
                    // Default to custom provider
                    customProviders.push(provider);
                }
            });

            // Create selection items in order: custom, known, built-in, with separators
            const providerChoices = [];

            // Custom providers
            if (customProviders.length > 0) {
                providerChoices.push(...customProviders.map(provider => ({ label: provider })));
            }

            // Known providers (add separator)
            if (knownProviders.length > 0) {
                if (customProviders.length > 0) {
                    providerChoices.push({ label: 'Known Providers', kind: vscode.QuickPickItemKind.Separator });
                }
                providerChoices.push(
                    ...knownProviders.map(provider => ({
                        label: provider,
                        description: KnownProviders[provider]?.displayName
                    }))
                );
            }

            // Built-in providers (add separator)
            if (builtinProviders.length > 0) {
                if (customProviders.length > 0 || knownProviders.length > 0) {
                    providerChoices.push({ label: 'Built-in Providers', kind: vscode.QuickPickItemKind.Separator });
                }
                providerChoices.push(
                    ...builtinProviders.map(provider => ({
                        label: provider,
                        description: configProviders[provider as keyof typeof configProviders]?.displayName
                    }))
                );
            }

            // If multiple providers, let user select
            const selected = await vscode.window.showQuickPick(providerChoices, {
                placeHolder: 'Select provider to set API key for'
            });
            if (!selected) {
                return;
            }
            await this.setApiKeyForProvider(selected.label);
        } catch (error) {
            Logger.error('Failed to set API key:', error);
            vscode.window.showErrorMessage(`Failed to set API key: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Get all unique provider list
     */
    private static async getUniqueProviders(): Promise<string[]> {
        const providers = new Set<string>();
        // Get all providers from existing models
        for (const model of this.models) {
            if (model.provider && model.provider.trim()) {
                providers.add(model.provider.trim());
            } else {
                // If model has no specified provider, use 'compatible' as default
                providers.add('compatible');
            }
        }
        return Array.from(providers).sort();
    }

    /**
     * Get provider display name
     */
    private static getProviderDisplayName(provider: string): string {
        const knownProvider = KnownProviders[provider];
        if (knownProvider?.displayName) {
            return knownProvider.displayName;
        }

        const builtinProvider = configProviders[provider as keyof typeof configProviders];
        if (builtinProvider?.displayName) {
            return builtinProvider.displayName;
        }

        return provider;
    }

    /**
     * Set API key for specified provider
     */
    private static async setApiKeyForProvider(provider: string): Promise<void> {
        const displayName = this.getProviderDisplayName(provider);
        const apiKey = await vscode.window.showInputBox({
            prompt: `Enter API key for "${displayName}" (leave blank to clear)`,
            title: `Set ${displayName} API Key`,
            placeHolder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
            password: true,
            ignoreFocusOut: true
        });
        if (apiKey === undefined) {
            return;
        }

        if (apiKey.trim().length === 0) {
            // Clear key
            await ApiKeyManager.deleteApiKey(provider);
            Logger.info(`API key for provider "${provider}" has been cleared`);
        } else {
            // Save key
            await ApiKeyManager.setApiKey(provider, apiKey.trim());
            Logger.info(`API key for provider "${provider}" has been set`);
        }

        // After modifying API Key, check if Compatible status bar needs to show/hide
        await StatusBarManager.compatible?.checkAndShowStatus();
        await StatusBarManager.compatible?.delayedUpdate(provider, 0);
    } /**
      * Configure models - main configuration flow
      */
    private static async configureModels(): Promise<void> {
        while (true) {
            interface ModelQuickPickItem extends vscode.QuickPickItem {
                modelId?: string;
                action?: 'add' | 'edit';
            }
            const items: ModelQuickPickItem[] = [];
            // Add existing models
            for (const model of this.models) {
                const details: string[] = [
                    `$(arrow-up) ${model.maxInputTokens} $(arrow-down) ${model.maxOutputTokens}`,
                    `$(chip) ${this.getSdkModeLabel(model.sdkMode)}`
                ];
                if (model.capabilities.toolCalling) {
                    details.push('$(plug) Tool Calling');
                }
                if (model.capabilities.imageInput) {
                    details.push('$(circuit-board) Image Understanding');
                }
                items.push({
                    label: model.name,
                    description: model.id,
                    detail: details.join('\t'),
                    modelId: model.id,
                    action: 'edit'
                });
            }
            // If no models, use visual editor to add directly
            if (items.length === 0) {
                const newModel = await this.showVisualModelEditorForCreate();
                if (newModel) {
                    await this.addModel(newModel);
                }
                return;
            }

            // Add separator and actions
            if (items.length > 0) {
                const separator = { label: '', kind: vscode.QuickPickItemKind.Separator };
                items.push(separator as ModelQuickPickItem);
            }
            items.push({
                label: '$(add) Add New Model',
                detail: 'Create new custom model configuration',
                action: 'add'
            });

            const quickPick = vscode.window.createQuickPick<ModelQuickPickItem>();
            quickPick.title = 'Custom Model Configuration';
            quickPick.placeholder = 'Select a model to edit or add new model';
            quickPick.items = items;
            quickPick.ignoreFocusOut = true;

            const selected = await new Promise<ModelQuickPickItem | BackButtonClick | undefined>(resolve => {
                const disposables: vscode.Disposable[] = [];
                disposables.push(
                    quickPick.onDidAccept(() => {
                        const selectedItem = quickPick.selectedItems[0];
                        resolve(selectedItem);
                        quickPick.hide();
                    })
                );
                disposables.push(
                    quickPick.onDidHide(() => {
                        resolve(undefined);
                        disposables.forEach(d => d.dispose());
                    })
                );
                quickPick.show();
            });

            if (!selected || isBackButtonClick(selected)) {
                return;
            }

            if (selected.action === 'add') {
                const newModel = await this.showVisualModelEditorForCreate();
                if (newModel) {
                    await this.addModel(newModel);
                }
            } else if (selected.action === 'edit' && selected.modelId) {
                const model = this.models.find(m => m.id === selected.modelId);
                if (model) {
                    const result = await this._editModel(selected.modelId, model);
                    if (result) {
                        if (result.action === 'update' && result.config) {
                            await this.updateModel(result.id, result.config);
                        } else if (result.action === 'delete') {
                            await this.removeModel(result.id);
                        }
                    }
                }
            }
        }
    }

    private static async _editModel(
        modelId: string,
        currentConfig: CompatibleModelConfig
    ): Promise<{ action: 'update' | 'delete'; id: string; config?: Partial<CompatibleModelConfig> } | undefined> {
        // Read raw data from configuration file (unprocessed)
        const rawConfig = this.getRawModelFromConfig(modelId);
        // If unable to read raw data, use in-memory data as fallback
        const configToEdit = rawConfig || currentConfig;

        // Directly show visual form editor
        const updatedConfig = await this.showVisualModelEditor(configToEdit);
        if (updatedConfig) {
            return { action: 'update', id: modelId, config: updatedConfig };
        }
        return undefined;
    }

    /**
     * Show visual model editor (create mode)
     * @returns New model config, or undefined if cancelled
     */
    private static async showVisualModelEditorForCreate(): Promise<CompatibleModelConfig | undefined> {
        // Create default new model configuration
        const defaultModel: CompatibleModelConfig = {
            id: '', // To be filled by user in form
            name: '', // To be filled by user in form
            provider: '', // To be selected by user in form
            sdkMode: 'openai',
            maxInputTokens: 128000,
            maxOutputTokens: 4096,
            capabilities: {
                toolCalling: true,
                imageInput: false
            }
        };

        return this.showVisualModelEditor(defaultModel, true);
    }

    /**
     * Show visual model editor
     * @param model Model config to edit
     * @param isCreateMode Whether in create mode
     * @returns Updated model config, or undefined if cancelled
     */
    private static async showVisualModelEditor(
        model: CompatibleModelConfig,
        isCreateMode: boolean = false
    ): Promise<CompatibleModelConfig | undefined> {
        const result = await ModelEditor.show(model, isCreateMode);

        // Check if delete operation
        if (result && '_deleteModel' in result && result._deleteModel) {
            // Execute delete operation
            try {
                await this.removeModel(result.modelId);
                vscode.window.showInformationMessage('Model deleted');
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to delete model: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
            return undefined;
        }

        // If user filled API Key, save to key manager
        if (result && 'apiKey' in result && result.apiKey && result.provider) {
            try {
                await ApiKeyManager.setApiKey(result.provider, result.apiKey);
                Logger.info(`Saved API key for provider ${result.provider} to key manager`);
                // Remove apiKey from model config as it has been saved to key manager
                delete result.apiKey;
            } catch (error) {
                Logger.error('Failed to save API key:', error);
                vscode.window.showErrorMessage(
                    `Failed to save API key: ${error instanceof Error ? error.message : 'Unknown error'}`
                );
            }
        }

        return result as CompatibleModelConfig | undefined;
    }

    /**
     * Get historical custom provider list
     */
    private static async getHistoricalCustomProviders(): Promise<string[]> {
        try {
            // Import provider config to get built-in provider list
            const { configProviders } = await import('../providers/config/index.js');
            const builtinProviders = Object.keys(configProviders);
            const knownProviders = Object.keys(KnownProviders);
            // Get all unique provider identifiers from existing models
            const allProviders = this.models
                .map(model => model.provider)
                .filter(provider => provider && provider.trim() !== '');
            // Deduplicate and exclude built-in providers and 'compatible'
            const customProviders = [...new Set(allProviders)].filter(
                provider =>
                    provider !== 'compatible' &&
                    !builtinProviders.includes(provider) &&
                    !knownProviders.includes(provider)
            );
            return customProviders;
        } catch (error) {
            Logger.error('Failed to get historical custom providers:', error);
            return [];
        }
    }
}
