/*---------------------------------------------------------------------------------------------
 *  Base Class for Single Provider Status Bar Item
 *  Inherits BaseStatusBarItem, adds API Key related logic
 *  Suitable for provider status bars that depend on a single API Key (e.g., MiniMax, DeepSeek, Kimi, Moonshot)
 *--------------------------------------------------------------------------------------------*/

import { BaseStatusBarItem, StatusBarItemConfig } from './baseStatusBarItem';
import { ApiKeyManager } from '../utils/apiKeyManager';

// Re-export StatusBarItemConfig for use by subclasses
export { StatusBarItemConfig } from './baseStatusBarItem';

/**
 * Base Class for Single Provider Status Bar Item
 * Inherits BaseStatusBarItem, provides API Key check logic
 *
 * Suitable for:
 * - Providers that depend on a single API Key
 * - MiniMaxStatusBar, DeepSeekStatusBar, KimiStatusBar, MoonshotStatusBar, etc.
 *
 * @template T Status data type
 */
export abstract class ProviderStatusBarItem<T> extends BaseStatusBarItem<T> {
    /** Status bar item configuration (includes apiKeyProvider) */
    protected override readonly config: StatusBarItemConfig;

    /**
     * Constructor
     * @param config Status bar item configuration containing apiKeyProvider
     */
    constructor(config: StatusBarItemConfig) {
        super(config);
        this.config = config;
    }

    /**
     * Check whether the status bar should be displayed
     * Determined by checking if API Key exists
     * @returns Whether the status bar should be displayed
     */
    protected async shouldShowStatusBar(): Promise<boolean> {
        return await ApiKeyManager.hasValidApiKey(this.config.apiKeyProvider);
    }
}
