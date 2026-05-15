/*---------------------------------------------------------------------------------------------
 *  Compatible provider balance query manager
 *  Manages balance query handlers for all compatible providers
 *  Provided as global static instance, no instantiation needed
 *--------------------------------------------------------------------------------------------*/

import { StatusLogger } from '../../utils/statusLogger';
import { IBalanceQuery, BalanceQueryResult } from './balanceQuery';
import { AiHubMixBalanceQuery } from './providers/aihubmixBalanceQuery';
import { AiPingBalanceQuery } from './providers/aipingBalanceQuery';
import { SiliconflowBalanceQuery } from './providers/siliconflowBalanceQuery';
import { OpenrouterBalanceQuery } from './providers/openrouterBalanceQuery';

/**
 * Balance query manager
 * Responsible for managing balance query handlers for all compatible providers
 * Provided as global static instance, all methods are static
 */
export class BalanceQueryManager {
    private static queryHandlers = new Map<string, IBalanceQuery>();
    private static initialized = false;

    /** Private constructor, instantiation prohibited */
    private constructor() { }

    /**
     * Initialize manager (register default handlers)
     * Auto-initializes on first call to any static method
     */
    private static ensureInitialized(): void {
        if (!BalanceQueryManager.initialized) {
            BalanceQueryManager.registerDefaultHandlers();
            BalanceQueryManager.initialized = true;
        }
    }

    /**
     * Register default balance query handlers
     */
    private static registerDefaultHandlers(): void {
        BalanceQueryManager.registerHandler('aihubmix', new AiHubMixBalanceQuery());
        BalanceQueryManager.registerHandler('aiping', new AiPingBalanceQuery());
        BalanceQueryManager.registerHandler('siliconflow', new SiliconflowBalanceQuery());
        BalanceQueryManager.registerHandler('openrouter', new OpenrouterBalanceQuery());
    }

    /**
     * Register balance query handler
     * @param providerId Provider identifier
     * @param handler Balance query handler instance
     */
    static registerHandler(providerId: string, handler: IBalanceQuery): void {
        BalanceQueryManager.queryHandlers.set(providerId, handler);
        StatusLogger.debug(`[BalanceQueryManager] Registered balance query handler for provider ${providerId}`);
    }

    /**
     * Unregister balance query handler
     * @param providerId Provider identifier
     */
    static unregisterHandler(providerId: string): void {
        if (BalanceQueryManager.queryHandlers.has(providerId)) {
            BalanceQueryManager.queryHandlers.delete(providerId);
            StatusLogger.debug(`[BalanceQueryManager] Unregistered balance query handler for provider ${providerId}`);
        }
    }

    /**
     * Query provider balance
     * @param providerId Provider identifier
     * @returns Balance query result
     */
    static async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        BalanceQueryManager.ensureInitialized();

        const handler = BalanceQueryManager.queryHandlers.get(providerId);

        if (!handler) {
            // If no registered query handler, return default value
            StatusLogger.warn(`[BalanceQueryManager] Balance query handler not found for provider ${providerId}, using default value`);
            return {
                balance: 0,
                currency: 'CNY'
            };
        }

        try {
            const result = await handler.queryBalance(providerId);
            StatusLogger.debug(`[BalanceQueryManager] Successfully queried balance for provider ${providerId}: ${result.balance}`);
            return result;
        } catch (error) {
            StatusLogger.error(`[BalanceQueryManager] Failed to query balance for provider ${providerId}`, error);
            // Throw error on query failure, let upper layer handle
            throw error;
        }
    }

    /**
     * Get all registered provider IDs
     * @returns Provider ID list
     */
    static getRegisteredProviders(): string[] {
        BalanceQueryManager.ensureInitialized();
        return Array.from(BalanceQueryManager.queryHandlers.keys());
    }

    /**
     * Check if query handler is registered for specified provider
     * @param providerId Provider identifier
     * @returns Whether registered
     */
    static hasHandler(providerId: string): boolean {
        BalanceQueryManager.ensureInitialized();
        return BalanceQueryManager.queryHandlers.has(providerId);
    }
}
