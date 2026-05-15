/*---------------------------------------------------------------------------------------------
 *  Retry Manager
 *  Provides cumulative delay retry mechanism, specifically for handling retryable rate limit errors
 *--------------------------------------------------------------------------------------------*/

import { Logger } from './logger';

/**
 * Retry configuration interface
 */
export interface RetryConfig {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
}

/**
 * Error type definition
 */
export type RetryableError = Error & {
    status?: number;
    statusCode?: number;
    code?: string | number;
    message?: string;
};

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_CONFIG: RetryConfig = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 30000
};

/**
 * Retry manager class
 * Provides incremental cumulative delay retry mechanism
 */
export class RetryManager {
    private config: RetryConfig;

    constructor(config?: Partial<RetryConfig>) {
        this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
    }

    /**
     * Execute operation with retry mechanism
     * @param operation Operation function to execute
     * @param isRetryable Function to determine if error is retryable
     * @param providerName Provider name (for logging)
     * @returns Operation result
     */
    async executeWithRetry<T>(
        operation: () => Promise<T>,
        isRetryable: (error: RetryableError) => boolean,
        providerName: string
    ): Promise<T> {
        let lastError: RetryableError | undefined;
        let attempt = 0;

        // First request
        Logger.trace(`[${providerName}] Starting first request`);
        try {
            const result = await operation();
            return result;
        } catch (error) {
            lastError = error as RetryableError;
            // If first request fails and is not retryable, throw directly
            if (!isRetryable(lastError)) {
                Logger.warn(`[${providerName}] First request failed: ${lastError.message}`);
                throw lastError;
            }
            Logger.warn(`[${providerName}] First request failed, starting retry mechanism: ${lastError.message}`);
        }

        // Retry loop
        while (attempt < this.config.maxAttempts) {
            attempt++;

            // Calculate delay time
            const actualDelayMs = this.calculateDelayMs(attempt);
            Logger.info(`[${providerName}] Retrying after ${actualDelayMs / 1000} second(s)...`);

            // Wait for delay time
            await this.delay(actualDelayMs);

            // Execute retry
            Logger.info(`[${providerName}] Retry attempt #${attempt}/${this.config.maxAttempts}`);
            try {
                const result = await operation();
                Logger.info(`[${providerName}] Retry succeeded! After ${attempt} retry attempt(s)`);
                return result;
            } catch (error) {
                lastError = error as RetryableError;

                // If not a retryable error, throw directly
                if (!isRetryable(lastError)) {
                    Logger.warn(`[${providerName}] ${attempt}th retry failed: ${lastError.message}`);
                    throw lastError;
                }

                Logger.warn(`[${providerName}] ${attempt}th retry failed, preparing next retry: ${lastError.message}`);
            }
        }

        // All retries failed, throw last error
        if (lastError) {
            Logger.error(`[${providerName}] All retry attempts failed: ${lastError.message}`);
            throw lastError;
        } else {
            throw new Error(`[${providerName}] Unknown error`);
        }
    }

    /**
     * Check if 429 error
     * @param error Error object
     * @returns Whether it is a 429 error
     */
    static isRateLimitError(error: RetryableError, deep = 0): boolean {
        // Check OpenAI error object
        if ('status' in error && (error.status === 429 || error.status === 529)) {
            return true;
        }
        // Check if statusCode property exists
        if ('statusCode' in error && (error.statusCode === 429 || error.statusCode === 529)) {
            return true;
        }

        if (error.message && typeof error.message === 'string') {
            // Check if error message contains 429/529
            if (error.message.includes('429') || error.message.includes('529')) {
                return true;
            }
            // Some providers may include specific rate limit hints in error message
            if (error.message.toLowerCase().includes('rate limit') || error.message.includes('request too frequent')) {
                return true;
            }
            // Some providers may use "temporarily overloaded" or "excessive traffic" hints to indicate server overload, which can also be considered as retryable
            if (
                error.message.toLowerCase().includes('temporarily overloaded') ||
                error.message.includes('excessive traffic')
            ) {
                return true;
            }
        }

        // Check if nested error object exists
        if (deep <= 3 && 'error' in error && typeof error.error === 'object' && error.error !== null) {
            return this.isRateLimitError(error.error as RetryableError, deep + 1);
        }
        return false;
    }

    /**
     * Delay for specified milliseconds
     * @param ms Milliseconds
     * @returns Promise
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Calculate wait time before Nth retry
     * 1 -> 1s, 2 -> 3s, 3 -> 6s, 4 -> 10s, 5 -> 15s
     */
    private calculateDelayMs(attempt: number): number {
        const triangularMultiplier = (attempt * (attempt + 1)) / 2;
        return Math.min(this.config.initialDelayMs * triangularMultiplier, this.config.maxDelayMs);
    }
}
