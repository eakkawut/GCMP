/*---------------------------------------------------------------------------------------------
 *  Usage Statistics - Types Exposed to Upper Layers
 *--------------------------------------------------------------------------------------------*/

// Re-export fileLogger types for use
export type {
    FileLoggerProviderStats,
    FileLoggerModelStats,
    TokenUsageStatsFromFile,
    HourlyStats
} from './fileLogger/types';

/**
 * Date Summary
 */
export interface DateSummary {
    date: string;
    total_input: number;
    total_cache: number;
    total_output: number;
    total_requests: number;
}
