/*---------------------------------------------------------------------------------------------
 *  Token Usage Parser Utility
 *  Uniformly parses usage objects in both OpenAI and Anthropic formats
 *--------------------------------------------------------------------------------------------*/

import type { TokenRequestLog } from './types';

/**
 * Parsed Token Statistics
 */
export interface ParsedUsageTokens {
    /** Actual Input Token Count */
    actualInput: number;
    /** Cache Read Token Count */
    cacheReadTokens: number;
    /** Cache Creation Token Count */
    cacheCreationTokens: number;
    /** Output Token Count */
    outputTokens: number;
    /** Total Token Count */
    totalTokens: number;
    /** Stream Duration (milliseconds) */
    streamDuration?: number;
    /** Output Speed (tokens/s) */
    outputSpeed?: number;
}

/**
 * Extended TokenRequestLog, provides parsed token statistics results
 */
export type ExtendedTokenRequestLog = TokenRequestLog & ParsedUsageTokens;

/**
 * Token Usage Parser Utility Class
 * Uniformly handles usage object formats from different providers
 */
export class UsageParser {
    /**
     * Parse Token Statistics from Raw Usage Object
     * Supports OpenAI, Anthropic, and Responses API three formats
     */
    static parseRawUsage(rawUsage: TokenRequestLog['rawUsage']): ParsedUsageTokens {
        // Default values
        const defaultResult: ParsedUsageTokens = {
            actualInput: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            totalTokens: 0
        };

        if (!rawUsage) {
            return defaultResult;
        }

        // Attempt to parse Anthropic/Claude format / Responses API format
        if (rawUsage.input_tokens !== undefined && rawUsage.output_tokens !== undefined) {
            const inputTokens = rawUsage.input_tokens || 0;
            const outputTokens = rawUsage.output_tokens || 0;

            // Check for cached_tokens field
            const cachedTokens = rawUsage.input_tokens_details?.cached_tokens || rawUsage.cached_tokens || 0;

            // Anthropic format
            const cacheReadTokens = rawUsage.cache_read_input_tokens || 0;
            const cacheCreationTokens = rawUsage.cache_creation_input_tokens || 0;

            // Responses API: cached_tokens already included in input_tokens, no need to add repeatedly
            // Anthropic API: cache_read_input_tokens and cache_creation_input_tokens not included in input_tokens
            const isResponsesApi = !!rawUsage.input_tokens_details?.cached_tokens;
            const actualCacheReadTokens = isResponsesApi ? cachedTokens : cacheReadTokens;
            const actualCacheCreationTokens = isResponsesApi ? 0 : cacheCreationTokens;

            // Responses API: actualInput = inputTokens (already includes cached_tokens)
            // Anthropic API: actualInput = inputTokens + cacheReadTokens + cacheCreationTokens
            const actualInput = isResponsesApi
                ? inputTokens
                : inputTokens + actualCacheReadTokens + actualCacheCreationTokens;

            return {
                actualInput,
                cacheReadTokens: actualCacheReadTokens,
                cacheCreationTokens: actualCacheCreationTokens,
                outputTokens,
                totalTokens: rawUsage.total_tokens || actualInput + outputTokens
            };
        }

        // Prioritize detecting Gemini-style usageMetadata (those with promptTokenCount are considered Gemini)
        if (rawUsage.promptTokenCount !== undefined) {
            const promptTokenCount = rawUsage.promptTokenCount;
            const responseTokenCount = rawUsage.responseTokenCount;
            const candidatesTokenCount = rawUsage.candidatesTokenCount;
            const totalTokenCount = rawUsage.totalTokenCount;
            const cachedContentTokenCount = rawUsage.cachedContentTokenCount;

            let outputTokens: number | undefined;
            if (typeof responseTokenCount === 'number') {
                outputTokens = responseTokenCount;
            } else if (typeof candidatesTokenCount === 'number') {
                outputTokens = candidatesTokenCount;
            }
            if (typeof promptTokenCount === 'number' && typeof outputTokens === 'number') {
                const cacheReadTokens = typeof cachedContentTokenCount === 'number' ? cachedContentTokenCount : 0;
                const cacheCreationTokens = Math.max(0, promptTokenCount - cacheReadTokens);

                return {
                    actualInput: promptTokenCount,
                    cacheReadTokens,
                    cacheCreationTokens,
                    outputTokens,
                    totalTokens: typeof totalTokenCount === 'number' ? totalTokenCount : promptTokenCount + outputTokens
                };
            }
        }

        // Attempt to parse OpenAI format
        if (rawUsage.prompt_tokens !== undefined) {
            const promptTokens = rawUsage.prompt_tokens || 0;
            const completionTokens = rawUsage.completion_tokens || 0;
            const cachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;

            // OpenAI: prompt_tokens includes all inputs, cached_tokens is the cache hit portion within it
            // Input not hitting cache will be written to cache (if cache functionality is enabled)
            const cacheCreationTokens = promptTokens - cachedTokens;

            return {
                actualInput: promptTokens,
                cacheReadTokens: cachedTokens,
                cacheCreationTokens,
                outputTokens: completionTokens,
                totalTokens: rawUsage.total_tokens || 0 || promptTokens + completionTokens
            };
        }

        // Unknown format, return default values
        return defaultResult;
    }

    /**
     * Parse Token Statistics from TokenRequestLog
     * If rawUsage exists, parse it; otherwise use estimatedInput
     */
    static parseFromLog(log: TokenRequestLog): ParsedUsageTokens {
        let result: ParsedUsageTokens;

        if (log.rawUsage) {
            result = this.parseRawUsage(log.rawUsage);
        } else {
            // No rawUsage, use estimated input
            result = {
                actualInput: log.estimatedInput,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 0,
                totalTokens: log.estimatedInput
            };
        }

        // Calculate stream duration
        let duration: number | undefined;
        if (log.streamStartTime && log.streamEndTime) {
            duration = log.streamEndTime - log.streamStartTime;
            // If stream duration is less than 10ms, use entire request duration
            if (duration < 10 && log.timestamp) {
                duration = log.streamEndTime - log.timestamp;
                log.streamStartTime = undefined; // Unreliable, reset stream start time
            }
        } else if (log.streamEndTime) {
            // If only stream end time exists, use difference between stream end time and request time as duration
            duration = log.streamEndTime - log.timestamp;
        }

        // Calculate output speed
        if (duration && duration > 0) {
            result.streamDuration = duration;
            if (result.outputTokens > 0) {
                const speed = (result.outputTokens / duration) * 1000; // tokens/s
                // Speed > 1000 considered potentially erroneous, discard directly
                if (speed <= 1000) {
                    result.outputSpeed = speed;
                }
            }
        }

        return result;
    }

    /**
     * Extend TokenRequestLog, Add Convenient Access Methods
     * Allows UI code to continue using simple field access
     */
    static extendLog(log: TokenRequestLog): ExtendedTokenRequestLog {
        const parsed = this.parseFromLog(log);
        return { ...log, ...parsed };
    }

    /**
     * Batch Extend TokenRequestLog Array
     */
    static extendLogs(logs: TokenRequestLog[]): ExtendedTokenRequestLog[] {
        return logs.map(log => this.extendLog(log));
    }
}
