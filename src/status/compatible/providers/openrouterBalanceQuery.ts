/*---------------------------------------------------------------------------------------------
 *  OpenRouter Balance Query Handler
 *--------------------------------------------------------------------------------------------*/

import { IBalanceQuery, BalanceQueryResult } from '../balanceQuery';
import { StatusLogger } from '../../../utils/statusLogger';
import { ApiKeyManager } from '../../../utils/apiKeyManager';
import { Logger } from '../../../utils';

/**
 * OpenRouter API response type
 */
interface OpenRouterBalanceResponse {
    /** Response data */
    data: {
        /** Total purchased credits */
        total_credits: number;
        /** Total usage credits */
        total_usage: number;
    };
}

/**
 * OpenRouter balance query handler
 */
export class OpenrouterBalanceQuery implements IBalanceQuery {
    /**
     * Query OpenRouter balance
     * @param providerId Provider identifier
     * @returns Balance query result
     */
    async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        StatusLogger.debug(`[OpenrouterBalanceQuery] Querying balance for provider ${providerId}`);

        try {
            // Get API key
            const apiKey = await ApiKeyManager.getApiKey(providerId);

            if (!apiKey) {
                throw new Error(`API key not found for provider ${providerId}`);
            }

            // Call OpenRouter balance query API
            const response = await fetch('https://openrouter.ai/api/v1/credits', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`);
            }

            const result = (await response.json()) as OpenRouterBalanceResponse;

            // Parse balance data
            const totalCredits = result.data.total_credits || 0; // Total purchased credits
            const totalUsage = result.data.total_usage || 0; // Total usage credits
            const balance = totalCredits - totalUsage; // Available balance

            StatusLogger.debug('[OpenrouterBalanceQuery] Balance query successful');

            return {
                balance,
                currency: 'USD' // OpenRouterusing USD
            };
        } catch (error) {
            Logger.error('[OpenrouterBalanceQuery] Failed to query balance', error);
            throw new Error(`OpenRouter balance query failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}
