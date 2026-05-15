/*---------------------------------------------------------------------------------------------
 *  SiliconFlow Balance Query Handler
 *--------------------------------------------------------------------------------------------*/

import { IBalanceQuery, BalanceQueryResult } from '../balanceQuery';
import { StatusLogger } from '../../../utils/statusLogger';
import { ApiKeyManager } from '../../../utils/apiKeyManager';
import { Logger } from '../../../utils';

/**
 * SiliconFlow API response type
 */
interface SiliconFlowBalanceResponse {
    /** Response status code */
    code: number;
    /** Response message */
    message: string;
    /** Response status */
    status: boolean;
    /** User data object */
    data: SiliconFlowUserData;
}

/**
 * SiliconFlow user data object
 */
interface SiliconFlowUserData {
    /** User ID */
    id: string;
    /** User name */
    name: string;
    /** User avatar */
    image: string;
    /** User email */
    email: string;
    /** Whether admin */
    isAdmin: boolean;
    /** Granted balance */
    balance: string;
    /** Account status */
    status: string;
    /** User introduction */
    introduction: string;
    /** User role */
    role: string;
    /** Recharged balance */
    chargeBalance: string;
    /** Total balance */
    totalBalance: string;
}

/**
 * SiliconFlow balance query handler
 */
export class SiliconflowBalanceQuery implements IBalanceQuery {
    /**
     * Query SiliconFlow balance
     * @param providerId Provider identifier
     * @returns Balance query result
     */
    async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        StatusLogger.debug(`[SiliconflowBalanceQuery] Querying balance for provider ${providerId}`);

        try {
            // Get API key
            const apiKey = await ApiKeyManager.getApiKey(providerId);

            if (!apiKey) {
                throw new Error(`API key not found for provider ${providerId}`);
            }

            // Call SiliconFlow balance query API
            const response = await fetch('https://api.siliconflow.cn/v1/user/info', {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`API request failed: ${response.status} ${response.statusText}`);
            }

            const result = (await response.json()) as SiliconFlowBalanceResponse;

            // Check API response status code
            if (result.code !== 20000 || !result.status) {
                throw new Error(`API returned error: ${result.message || 'Unknown error'}`);
            }

            // Parse balance data
            const data = result.data;
            const granted = parseFloat(data.balance) || 0; // Granted balance
            const paid = parseFloat(data.chargeBalance) || 0; // Recharged balance
            const balance = parseFloat(data.totalBalance) || paid + granted; // Total balance

            StatusLogger.debug('[SiliconflowBalanceQuery] Balance query successful');

            return {
                paid,
                granted,
                balance,
                currency: 'CNY' // SiliconFlowusing CNY
            };
        } catch (error) {
            Logger.error('[SiliconflowBalanceQuery] Failed to query balance', error);
            throw new Error(`SiliconFlow balance query failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }
}
