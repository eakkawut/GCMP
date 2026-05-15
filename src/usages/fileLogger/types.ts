/*---------------------------------------------------------------------------------------------
 *  Token File Logging System - Type Definitions
 *  Supplement globalState storage, provide detailed request log records
 *--------------------------------------------------------------------------------------------*/

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/**
 * Generic Token Usage Data Format - Supports Multiple SDKs
 */
export interface GenericUsageData {
    // === OpenAI Format ===
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cached_tokens?: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        audio_tokens?: number;
        [key: string]: number | undefined;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
        audio_tokens?: number;
        [key: string]: number | undefined;
    };
    // === Anthropic/Claude Format ===
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    // === Responses API Format ===
    input_tokens_details?: {
        cached_tokens?: number;
        [key: string]: number | undefined;
    };
    output_tokens_details?: {
        reasoning_tokens?: number;
        [key: string]: number | undefined;
    };

    // === Gemini usageMetadata (HTTP/SSE gateway returns) ===
    // Different gateways may have different field names: some use responseTokenCount, some use candidatesTokenCount (both represent output token count).
    promptTokenCount?: number;
    responseTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
    cacheTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
    candidatesTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
    // === Other Fields ===
    [key: string]: number | undefined | object;
}

/**
 * Raw Token Usage Data - Supports Multiple SDK Formats
 * Used to uniformly handle usage objects from different providers like Anthropic, OpenAI, etc.
 */
export type RawUsageData = Anthropic.Messages.Usage | OpenAI.Completions.CompletionUsage | GenericUsageData;

/**
 * Token Request Log Entry
 * One JSON object per line, recording a complete API request
 */
export interface TokenRequestLog {
    /** Request ID */
    requestId: string;
    /** Timestamp (milliseconds) */
    timestamp: number;
    /** ISO time string */
    isoTime: string;
    /** Provider Key */
    providerKey: string;
    /** Provider Display Name */
    providerName: string;
    /** Model ID */
    modelId: string;
    /** Model Name */
    modelName: string;
    /** Estimated Input Tokens */
    estimatedInput: number;
    /** Raw usage object (stored when request completes, supports multiple provider formats) */
    rawUsage: GenericUsageData | null;
    /** Request Status */
    status: 'estimated' | 'completed' | 'failed';
    /** Maximum Input Tokens (context window size) */
    maxInputTokens?: number;
    /** Request Type */
    requestType?: 'chat' | 'completion' | 'fim' | 'nes';
    /** Stream Start Time (millisecond timestamp) */
    streamStartTime?: number;
    /** Stream End Time (millisecond timestamp) */
    streamEndTime?: number;
}

/**
 * File Path Information
 */
export interface LogFilePath {
    /** Date String (YYYY-MM-DD) */
    date: string;
    /** Hour (0-23) */
    hour: number;
    /** Date Folder Path */
    dateFolder: string;
    /** Hour File Name (HH.jsonl) */
    hourFileName: string;
    /** Full File Path */
    fullPath: string;
}

/**
 * Base Statistics Data (Common Fields)
 */
export interface BaseStats {
    estimatedInput: number;
    actualInput: number;
    cacheTokens: number;
    /** Average First Token Latency (milliseconds) - Aggregated result, written to cache file */
    firstTokenLatency?: number;
    /** Average Output Speed (tokens/s) - Aggregated result, written to cache file */
    outputSpeeds?: number;
    outputTokens: number;
    requests: number;
}

/**
 * Token Statistics Data (Total)
 * Extends base statistics, adds completed/failed status
 */
export interface TokenStats extends BaseStats {
    completedRequests: number;
    failedRequests: number;
}

/**
 * Model Statistics Used Internally by FileLogger
 * Extends base statistics, adds model name
 */
export interface FileLoggerModelStats extends BaseStats {
    modelName: string;
}

/**
 * Provider Statistics Used Internally by FileLogger
 * Extends base statistics, adds provider name and model grouping
 * Note: providerKey is already used as Record key, no need to store repeatedly within object
 */
export interface FileLoggerProviderStats extends TokenStats {
    providerName: string;
    models: Record<string, FileLoggerModelStats>;
}

/**
 * Hourly Statistics (used for hourly)
 * Contains total, provider and model statistics, used as cache for differential calculation
 */
export interface HourlyStats extends TokenStats {
    /** Log File Modification Timestamp (used for cache validation) */
    modifiedTime: number;
    /** Grouped by Provider (use providerId directly as key) */
    providers: Record<string, FileLoggerProviderStats>;
}

/**
 * Statistics Result (calculated after reading from file)
 * Also the file structure of stats.json
 */
export interface TokenUsageStatsFromFile {
    /** Code Version Timestamp - Used to determine if cache was generated by current version code */
    versionTimestamp?: number;
    /** Total */
    total: TokenStats;
    /** Grouped by Provider (use providerId directly as key) */
    providers: Record<string, FileLoggerProviderStats>;
    /** Hourly Totals (only date statistics include this field) */
    hourly?: Record<string, HourlyStats>;
}

/**
 * Date Index Entry (used for index.json)
 */
export interface DateIndexEntry {
    total_input: number;
    total_cache: number;
    total_output: number;
    total_requests: number;
}

/**
 * Date Index File Structure
 * Used for quickly browsing date list without loading complete statistics for each date
 */
export interface DateIndex {
    /** Code Version Timestamp - Used to determine if cache was generated by current version code */
    versionTimestamp?: number;
    /** Cache Creation Timestamp - Used to determine if cache is newer than log files */
    cacheTimestamp?: number;
    dates: Record<string, DateIndexEntry>;
}
