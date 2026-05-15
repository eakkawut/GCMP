/*---------------------------------------------------------------------------------------------
 *  AIHubMix Balance Query Handler
 *--------------------------------------------------------------------------------------------*/

import { IBalanceQuery, BalanceQueryResult } from '../balanceQuery';
import { StatusLogger } from '../../../utils/statusLogger';
import { ApiKeyManager } from '../../../utils/apiKeyManager';
import { Logger, KnownProviders } from '../../../utils';

/**
 * AIHubMix API response type
 */
interface AiHubMixBalanceResponse {
    /** Object type */
    object: string;
    /** Remaining quota, in USD */
    total_usage: number;
}

/**
 * AIHubMix error response type
 */
interface AiHubMixErrorResponse {
    /** Error response */
    error: {
        /** Error message */
        message: string;
        /** Error type */
        type: string;
    };
}

/**
 * AIHubMix balance query handler
 */
export class AiHubMixBalanceQuery implements IBalanceQuery {
    /**
     * Query AIHubMix balance
     * @param providerId Provider identifier
     * @returns AIHubMix balance query result
     */
    async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        StatusLogger.debug(`[AiHubMixBalanceQuery] Querying balance for provider ${providerId}`);

        try {
            // Get API key
            const apiKey = await ApiKeyManager.getApiKey(providerId);
            if (!apiKey) {
                throw new Error(`API key not found for ${providerId}`);
            }

            // Call AIHubMix balance query API
            const response = await fetch('https://aihubmix.com/dashboard/billing/remain', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                    ...(KnownProviders['aihubmix']?.customHeader || {})
                }
            });

            if (!response.ok) {
                // Try to parse error response
                let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
                try {
                    const errorData = (await response.json()) as AiHubMixErrorResponse;
                    errorMessage = errorData?.error?.message || errorMessage;

                    // Detect insufficient funds error: quota exhausted
                    if (errorData.error?.message?.includes('quota exhausted')) {
                        StatusLogger.warn(`[AiHubMixBalanceQuery] Account quota exhausted (insufficient funds): ${errorData.error.message}`);
                        return {
                            balance: Number.MIN_SAFE_INTEGER, // Use special negative value to indicate insufficient funds
                            currency: 'USD'
                        };
                    }
                } catch {
                    // If error response cannot be parsed, use default error message
                }
                throw new Error(errorMessage);
            }

            const data = (await response.json()) as AiHubMixBalanceResponse;

            // Parse response data
            // API return format: {"object":"list","total_usage":0.06495}
            // total_usage represents remaining quota, in USD
            // Special value: -0.000002 indicates unlimited quota
            const remainingAmount = data.total_usage; // Check if unlimited quota
            const isInfinite = remainingAmount === -0.000002;

            // If unlimited quota, return special marker
            if (isInfinite) {
                return {
                    balance: Number.MAX_SAFE_INTEGER,
                    currency: 'USD'
                };
            }

            // For other negative values, log warning but still process as limited quota
            if (remainingAmount < 0 && !isInfinite) {
                StatusLogger.warn(`[AiHubMixBalanceQuery] Detected abnormal negative balance: ${remainingAmount}, setting to 0`);
            }

            StatusLogger.debug('[AiHubMixBalanceQuery] Balance query successful');

            // Normal case: return remaining quota
            return {
                balance: remainingAmount,
                currency: 'USD'
            };
        } catch (error) {
            Logger.error('[AiHubMixBalanceQuery] Failed to query balance', error);
            throw new Error(`AIHubMix balance query failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
