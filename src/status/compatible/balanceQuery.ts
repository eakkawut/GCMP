/*---------------------------------------------------------------------------------------------
 *  Compatible Provider Balance Query Interface and Type Definitions
 *--------------------------------------------------------------------------------------------*/

/**
 * Balance Query Result
 */
export interface BalanceQueryResult {
    /** Paid balance */
    paid?: number;
    /** Granted balance */
    granted?: number;
    /** Available balance */
    balance: number;
    /** Currency symbol (CNY/USD) */
    currency: string;
}

/**
 * Balance Query Interface
 */
export interface IBalanceQuery {
    /**
     * Query provider balance
     * @param providerId Provider identifier
     * @returns Balance query result
     */
    queryBalance(providerId: string): Promise<BalanceQueryResult>;
}
