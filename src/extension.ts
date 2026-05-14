import * as vscode from 'vscode';
import { GenericModelProvider } from './providers/genericModelProvider';
import { ZhipuProvider } from './providers/zhipuProvider';
import { MoonshotProvider } from './providers/moonshotProvider';
import { CliModelProvider } from './cli/cliModelProvider';
import { MiniMaxProvider } from './providers/minimaxProvider';
import { DashscopeProvider } from './providers/dashscopeProvider';
import { TencentProvider } from './providers/tencentProvider';
import { XiaomimimoProvider } from './providers/xiaomimimoProvider';
import { BaiduProvider } from './providers/baiduProvider';
import { VolcengineProvider } from './providers/volcengineProvider';
import { CompatibleProvider } from './providers/compatibleProvider';
import { InlineCompletionShim } from './copilot/inlineCompletionShim';
import { Logger, StatusLogger, CompletionLogger, TokenCounter } from './utils';
import { ApiKeyManager, ConfigManager, JsonSchemaProvider } from './utils';
import { registerCliAuthCommands } from './cli/cliAuthCommands';
import { TokenUsagesManager } from './usages/usagesManager';
import { TokenUsagesView } from './ui/usagesView';
import { CompatibleModelManager } from './utils/compatibleModelManager';
import { LeaderElectionService, StatusBarManager } from './status';
import { registerAllTools } from './tools';
import { CliAuthFactory } from './cli/auth/cliAuthFactory';
import { registerCommitCommands, checkGitAvailability } from './commit';
import { clearRegisteredProviders, registerProvider, registeredProviders } from './utils/providerRegistry';

/**
 * Global variable - stores registered provider instances for cleanup when the extension is deactivated
 */
const registeredDisposables: vscode.Disposable[] = [];

// Inline completion provider instance (uses lightweight Shim, lazy-loads the actual completion engine)
let inlineCompletionProvider: InlineCompletionShim | undefined;

/**
 * Activate providers - dynamically registers based on configuration files (parallel optimization version)
 */
async function activateProviders(context: vscode.ExtensionContext): Promise<void> {
    const startTime = Date.now();
    const configProvider = ConfigManager.getConfigProvider();

    if (!configProvider) {
        Logger.warn('Provider configuration not found, skipping provider registration');
        return;
    }

    // Set extension path (for tokenizer initialization)
    TokenCounter.setExtensionPath(context.extensionPath);

    Logger.debug(`⏱️ Starting parallel registration of ${Object.keys(configProvider).length} providers...`);

    // CLI authentication provider list (from CliAuthFactory)
    const supportedCliTypes = CliAuthFactory.getSupportedCliTypes();
    const cliAuthProviders = supportedCliTypes.map(cli => cli.id);

    // Register all providers in parallel for performance
    const registrationPromises = Object.entries(configProvider).map(async ([providerKey, providerConfig]) => {
        try {
            Logger.trace(`Registering provider: ${providerConfig.displayName} (${providerKey})`);
            const providerStartTime = Date.now();

            let provider:
                | GenericModelProvider
                | ZhipuProvider
                | MoonshotProvider
                | CliModelProvider
                | MiniMaxProvider
                | DashscopeProvider
                | TencentProvider
                | XiaomimimoProvider
                | BaiduProvider
                | VolcengineProvider;
            let disposables: vscode.Disposable[];

            if (providerKey === 'zhipu') {
                // Use dedicated provider for zhipu (configuration wizard functionality)
                const result = ZhipuProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'moonshot') {
                // Use dedicated provider for moonshot (multi-key management and configuration wizard)
                const result = MoonshotProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'minimax') {
                // Use dedicated provider for minimax (multi-key management and configuration wizard)
                const result = MiniMaxProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'dashscope') {
                // Use dedicated provider for dashscope (multi-key management and configuration wizard)
                const result = DashscopeProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'tencent') {
                // Use dedicated provider for tencent (four types of keys and protocol switching)
                const result = TencentProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'xiaomimimo') {
                // Use dedicated provider for xiaomimimo (multi-key management and configuration wizard)
                const result = XiaomimimoProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'baidu') {
                // Use dedicated provider for Baidu Qianfan (multi-key management and configuration wizard)
                const result = BaiduProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (providerKey === 'volcengine') {
                // Use dedicated provider for Volcengine (Coding Plan / Agent Plan multi-key management and configuration wizard)
                const result = VolcengineProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else if (cliAuthProviders.includes(providerKey)) {
                // Use generic CLI provider for CLI authentication providers
                const result = CliModelProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            } else {
                // Use generic provider for other providers (supports automatic selection based on sdkMode)
                const result = GenericModelProvider.createAndActivate(context, providerKey, providerConfig);
                provider = result.provider;
                disposables = result.disposables;
            }

            const providerTime = Date.now() - providerStartTime;
            Logger.debug(`✅ ${providerConfig.displayName} provider registered successfully (took: ${providerTime}ms)`);
            return { providerKey, provider, disposables };
        } catch (error) {
            Logger.error(`❌ Failed to register provider ${providerKey}:`, error);
            return null;
        }
    });

    // Wait for all providers to be registered
    const results = await Promise.all(registrationPromises);

    // Collect successfully registered providers
    for (const result of results) {
        if (result) {
            registerProvider(result.providerKey, result.provider);
            registeredDisposables.push(...result.disposables);
        }
    }

    const totalTime = Date.now() - startTime;
    const successCount = results.filter(r => r !== null).length;
    Logger.debug(
        `⏱️ Provider registration completed: ${successCount}/${Object.keys(configProvider).length} successful (total time: ${totalTime}ms)`
    );
}

/**
 * Activate compatible provider
 */
async function activateCompatibleProvider(context: vscode.ExtensionContext): Promise<void> {
    try {
        Logger.trace('Registering compatible provider...');
        const providerStartTime = Date.now();

        // Create and activate compatible provider
        const result = CompatibleProvider.createAndActivate(context);
        const provider = result.provider;
        const disposables = result.disposables;

        // Store registered provider and disposables
        registerProvider('compatible', provider);
        registeredDisposables.push(...disposables);

        const providerTime = Date.now() - providerStartTime;
        Logger.debug(`✅ Compatible Provider registered successfully (took: ${providerTime}ms)`);
    } catch (error) {
        Logger.error('❌ Failed to register compatible provider:', error);
    }
}

/**
 * Activate inline completion provider (lightweight Shim, lazy-loads the actual completion engine)
 */
async function activateInlineCompletionProvider(context: vscode.ExtensionContext): Promise<void> {
    try {
        Logger.trace('Registering inline completion provider (Shim mode)...');
        const providerStartTime = Date.now();

        // Create and activate lightweight Shim (without @vscode/chat-lib dependency)
        const result = InlineCompletionShim.createAndActivate(context);
        inlineCompletionProvider = result.provider;
        registeredDisposables.push(...result.disposables);

        const providerTime = Date.now() - providerStartTime;
        Logger.debug(`✅ Inline completion provider registered successfully - Shim mode (took: ${providerTime}ms)`);
    } catch (error) {
        Logger.error('❌ Failed to register inline completion provider:', error);
    }
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
    // Store singleton instances to globalThis for use by modules in copilot.bundle.js
    globalThis.__ccmp_singletons = {
        CompletionLogger,
        ApiKeyManager,
        StatusBarManager,
        ConfigManager
    };

    const activationStartTime = Date.now();

    try {
        Logger.initialize('GitHub Copilot Models Provider (CCMP)'); // Initialize logger manager
        StatusLogger.initialize('GitHub Copilot Models Provider Status'); // Initialize high-frequency status logger
        CompletionLogger.initialize('GitHub Copilot Inline Completion via CCMP'); // Initialize high-frequency inline completion logger

        const isDevelopment = context.extensionMode === vscode.ExtensionMode.Development;
        Logger.debug(`🔧 CCMP extension mode: ${isDevelopment ? 'Development' : 'Production'}`);
        // Check and prompt VS Code log level settings
        if (isDevelopment) {
            Logger.checkAndPromptLogLevel();
        }

        Logger.debug('⏱️ Starting CCMP extension activation...');

        // Step 0: Initialize leader election service
        let stepStartTime = Date.now();
        LeaderElectionService.initialize(context);
        Logger.trace(`⏱️ Leader election service initialized (took: ${Date.now() - stepStartTime}ms)`);

        // Step 1: Initialize API key manager
        stepStartTime = Date.now();
        ApiKeyManager.initialize(context);
        Logger.trace(`⏱️ API key manager initialized (took: ${Date.now() - stepStartTime}ms)`);

        // Step 2: Initialize configuration manager
        stepStartTime = Date.now();
        const configDisposable = ConfigManager.initialize();
        context.subscriptions.push(configDisposable);
        Logger.trace(`⏱️ Configuration manager initialized (took: ${Date.now() - stepStartTime}ms)`);
        // Step 2.1: Initialize JSON Schema provider
        stepStartTime = Date.now();
        JsonSchemaProvider.initialize();
        context.subscriptions.push({ dispose: () => JsonSchemaProvider.dispose() });
        Logger.trace(`⏱️ JSON Schema provider initialized (took: ${Date.now() - stepStartTime}ms)`);
        // Step 2.2: Initialize compatible model manager
        stepStartTime = Date.now();
        CompatibleModelManager.initialize();
        Logger.trace(`⏱️ Compatible model manager initialized (took: ${Date.now() - stepStartTime}ms)`);
        // Step 2.3: Initialize token usage manager
        stepStartTime = Date.now();
        await TokenUsagesManager.instance.initialize(context);
        Logger.trace(`⏱️ Token usage manager initialized (took: ${Date.now() - stepStartTime}ms)`);

        // Step 3: Activate providers (parallel optimization)
        stepStartTime = Date.now();
        await activateProviders(context);
        Logger.trace(`⏱️ Model provider registration completed (took: ${Date.now() - stepStartTime}ms)`);
        // Step 3.1: Activate compatible provider
        stepStartTime = Date.now();
        await activateCompatibleProvider(context);
        Logger.trace(`⏱️ Compatible provider registration completed (took: ${Date.now() - stepStartTime}ms)`);

        // Step 3.2: Initialize all status bars (including creation and registration)
        stepStartTime = Date.now();
        await StatusBarManager.initializeAll(context);
        Logger.trace(`⏱️ All status bars initialized (took: ${Date.now() - stepStartTime}ms)`);

        // Step 4: Register tools
        stepStartTime = Date.now();
        registerAllTools(context);
        Logger.trace(`⏱️ Tool registration completed (took: ${Date.now() - stepStartTime}ms)`);

        // Step 5: Register inline completion provider (lightweight Shim, lazy-loads the actual completion engine)
        stepStartTime = Date.now();
        await activateInlineCompletionProvider(context);
        Logger.trace(`⏱️ NES inline completion provider registration completed (took: ${Date.now() - stepStartTime}ms)`);

        // Step 6: Register token usage statistics command
        stepStartTime = Date.now();
        // Command to view today's usage statistics details (singleton pattern, only one statistics page allowed per window)
        let tokenUsagesView: TokenUsagesView | undefined;
        const viewStatsCommand = vscode.commands.registerCommand('ccmp.tokenUsage.showDetails', () => {
            if (!tokenUsagesView) {
                tokenUsagesView = new TokenUsagesView(context);
            }
            tokenUsagesView.show();
        });
        context.subscriptions.push(
            viewStatsCommand,
            // Ensure view instance is cleaned up when extension is deactivated
            new vscode.Disposable(() => {
                tokenUsagesView?.dispose();
                tokenUsagesView = undefined;
            })
        );
        Logger.trace(`⏱️ Token usage statistics command registration completed (took: ${Date.now() - stepStartTime}ms)`);

        // Step 7: Register CLI authentication commands
        stepStartTime = Date.now();
        registerCliAuthCommands(context);
        Logger.trace(`⏱️ CLI authentication command registration completed (took: ${Date.now() - stepStartTime}ms)`);

        // Step 8: Register commit message generation command
        stepStartTime = Date.now();
        const commitDisposables = registerCommitCommands(context);
        commitDisposables.forEach(disposable => context.subscriptions.push(disposable));
        Logger.trace(`⏱️ Commit message generation command registration completed (took: ${Date.now() - stepStartTime}ms)`);

        // Step 9: Check Git availability (does not block extension activation)
        // Set to unavailable by default, update after check is complete
        vscode.commands.executeCommand('setContext', 'ccmp.gitAvailable', false);
        const gitDisposable = checkGitAvailability();
        context.subscriptions.push(gitDisposable);

        const totalActivationTime = Date.now() - activationStartTime;
        Logger.info(`✅ CCMP extension activation completed (total time: ${totalActivationTime}ms)`);
    } catch (error) {
        const errorMessage = `CCMP extension activation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
        Logger.error(errorMessage, error instanceof Error ? error : undefined);

        // Try to display user-friendly error message
        vscode.window.showErrorMessage('CCMP extension failed to start. Please check the output window for details.');
        // Re-throw error to let VS Code know the extension failed to start
        throw error;
    }
}

// This method is called when your extension is deactivated
export function deactivate() {
    try {
        Logger.info('Starting CCMP extension deactivation...');

        // Clean up all status bars
        StatusBarManager.disposeAll();
        Logger.trace('All status bars cleaned up');

        // Stop leader election service
        LeaderElectionService.stop();
        Logger.trace('Leader election service stopped');

        // Clean up resources for all registered providers
        for (const [providerKey, provider] of Object.entries(registeredProviders)) {
            try {
                if (typeof provider.dispose === 'function') {
                    provider.dispose();
                    Logger.trace(`Resources for provider ${providerKey} cleaned up`);
                }
            } catch (error) {
                Logger.warn(`Error cleaning up resources for provider ${providerKey}:`, error);
            }
        }

        // Clean up inline completion provider
        if (inlineCompletionProvider) {
            inlineCompletionProvider.dispose();
            Logger.trace('Inline completion provider cleaned up');
        }

        // Clean up all registered disposables
        for (const disposable of registeredDisposables) {
            try {
                disposable.dispose();
            } catch (error) {
                Logger.warn('Error cleaning up registered disposable:', error);
            }
        }
        registeredDisposables.length = 0; // Clear array
        Logger.trace('All registered disposables cleaned up');

        clearRegisteredProviders();
        Logger.trace('All registered providers cleaned up');

        // Clean up compatible model manager
        CompatibleModelManager.dispose();
        Logger.trace('Compatible model manager cleaned up');

        ConfigManager.dispose(); // Clean up configuration manager

        // Clean up token usage manager
        TokenUsagesManager.instance.dispose().catch(error => {
            Logger.warn('Failed to clean up token usage manager:', error);
        });
        Logger.trace('Token usage manager cleaned up');

        Logger.info('CCMP extension deactivation completed');
        StatusLogger.dispose(); // Clean up status logger
        CompletionLogger.dispose(); // Clean up inline completion logger
        Logger.dispose(); // Dispose Logger only when extension is destroyed
    } catch (error) {
        Logger.error('Error during CCMP extension deactivation:', error);
    }
}
