/**
 * Global Singleton Accessor - Unified access to extension's shared singleton instances in copilot.bundle.js
 *
 * Due to esbuild code splitting, extension.js and copilot.bundle.js are two independent CommonJS modules.
 * This module provides a unified interface to access shared singletons stored in globalThis, ensuring both bundles use the same instances.
 */

import { CompletionLogger } from '../utils/completionLogger';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { StatusBarManager } from '../status/statusBarManager';
import { ConfigManager } from '../utils/configManager';

/** Type definition for singleton container */
interface CCMPSingletons {
    CompletionLogger: typeof CompletionLogger;
    ApiKeyManager: typeof ApiKeyManager;
    StatusBarManager: typeof StatusBarManager;
    ConfigManager: typeof ConfigManager;
}

/** Extension global type */
declare global {
    var __ccmp_singletons: CCMPSingletons | undefined;
}

/**
 * Get shared CompletionLogger instance
 * Priority from globalThis (instance initialized by extension.js), otherwise fall back to direct import
 */
export function getCompletionLogger(): typeof CompletionLogger {
    return globalThis.__ccmp_singletons?.CompletionLogger || CompletionLogger;
}

/**
 * Get shared ApiKeyManager instance
 * Priority from globalThis (instance initialized by extension.js), otherwise fall back to direct import
 */
export function getApiKeyManager(): typeof ApiKeyManager {
    return globalThis.__ccmp_singletons?.ApiKeyManager || ApiKeyManager;
}

/**
 * Get shared StatusBarManager instance
 * Priority from globalThis (instance initialized by extension.js), otherwise fall back to direct import
 */
export function getStatusBarManager(): typeof StatusBarManager {
    return globalThis.__ccmp_singletons?.StatusBarManager || StatusBarManager;
}

/**
 * Get shared ConfigManager instance
 * Priority from globalThis (instance initialized by extension.js), otherwise fall back to direct import
 */
export function getConfigManager(): typeof ConfigManager {
    return globalThis.__ccmp_singletons?.ConfigManager || ConfigManager;
}

/**
 * Batch get all shared singletons (optional)
 * Used to obtain multiple instances at once
 */
export function getAllSingletons(): CCMPSingletons {
    return {
        CompletionLogger: getCompletionLogger(),
        ApiKeyManager: getApiKeyManager(),
        StatusBarManager: getStatusBarManager(),
        ConfigManager: getConfigManager()
    };
}
