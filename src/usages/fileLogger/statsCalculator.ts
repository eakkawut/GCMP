/*---------------------------------------------------------------------------------------------
 *  Statistics Calculator
 *  Specifically responsible for log aggregation and statistics calculation, no file I/O involved
 *  Designed as static class, all methods called directly without instantiation
 *--------------------------------------------------------------------------------------------*/

import { UsageParser } from './usageParser';
import type { TokenRequestLog, TokenUsageStatsFromFile } from './types';

/**
 * Statistics Calculator
 * Responsible for core logic of log aggregation and statistics calculation
 * Static class, no instantiation needed
 */
export abstract class StatsCalculator {
    private constructor() {
        // Private constructor to prevent instantiation
    }

    /** Calculate arithmetic mean (ignores non-positive/non-finite values) */
    static calculateMean(values: number[]): number {
        const cleaned = (values || []).filter(v => Number.isFinite(v) && v > 0);
        if (cleaned.length === 0) {
            return 0;
        }
        return cleaned.reduce((sum, v) => sum + v, 0) / cleaned.length;
    }

    /**
     * Calculate Robust Mean: First filter outliers using MAD in log space; if obvious gaps appear, keep the main cluster containing the median.
     */
    static calculateRobustMean(values: number[]): number {
        const cleaned = (values || []).filter(v => Number.isFinite(v) && v > 0);
        if (cleaned.length === 0) {
            return 0;
        }

        const mean = (arr: number[]): number => arr.reduce((sum, v) => sum + v, 0) / arr.length;
        const medianOfSorted = (sorted: number[]): number => {
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        };

        // When sample size is too small, use arithmetic mean directly
        if (cleaned.length < 5) {
            return mean(cleaned);
        }

        // Perform robust outlier detection in log space (rate anomalies are more pronounced)
        const pairs = cleaned.map(v => ({ v, log: Math.log(v) })).sort((a, b) => a.log - b.log);
        const logs = pairs.map(p => p.log);
        const medLog = medianOfSorted(logs);
        const absDevs = logs.map(l => Math.abs(l - medLog));
        const mad = medianOfSorted([...absDevs].sort((a, b) => a - b));

        // MAD=0 indicates data is highly concentrated, direct averaging is sufficient
        if (!Number.isFinite(mad) || mad <= 0) {
            return mean(cleaned);
        }

        // Standardize MAD to approximate standard deviation (normal approximation constant)
        const sigma = mad * 1.4826;
        // For right-skewed data like speeds, k=3.5 in log space is too lenient (tolerates ~33x ratio),
        // reducing to 1.5 keeps filtering threshold at about 4.5x, enabling stricter interception of extreme outliers.
        const k = 1.5;

        const madFiltered = pairs.filter(p => Math.abs(p.log - medLog) / sigma <= k).map(p => p.v);
        // If at least half the samples remain after filtering, the result can be trusted; otherwise degrade to gap detection
        if (madFiltered.length >= Math.max(3, Math.floor(cleaned.length * 0.5))) {
            return mean(madFiltered);
        }

        // Gap detection: if there's a huge gap after sorting, automatically select the main cluster (the one containing the median)
        const diffs: number[] = [];
        for (let i = 0; i < logs.length - 1; i++) {
            diffs.push(logs[i + 1] - logs[i]);
        }
        if (diffs.length === 0) {
            return mean(cleaned);
        }

        const sortedDiffs = [...diffs].sort((a, b) => a - b);
        const medDiff = medianOfSorted(sortedDiffs);
        const absDiffDevs = sortedDiffs.map(d => Math.abs(d - medDiff));
        const madDiff = medianOfSorted([...absDiffDevs].sort((a, b) => a - b));

        // gapThreshold considers both absolute ratio (>2x) and relative "abnormal gap"
        const minGap = Math.log(2); // adjacent point ratio >= 2
        const gapThreshold = Math.max(minGap, medDiff + 6 * (madDiff || 0));

        let bestGapIndex = -1;
        let bestGapValue = 0;
        for (let i = 0; i < diffs.length; i++) {
            if (diffs[i] >= gapThreshold && diffs[i] > bestGapValue) {
                bestGapValue = diffs[i];
                bestGapIndex = i;
            }
        }

        if (bestGapIndex >= 0) {
            // Determine which side to keep based on median position (main cluster)
            const midIndex = Math.floor((logs.length - 1) / 2);
            const keepLeft = bestGapIndex >= midIndex;
            const start = keepLeft ? 0 : bestGapIndex + 1;
            const end = keepLeft ? bestGapIndex + 1 : pairs.length;
            const cluster = pairs.slice(start, end).map(p => p.v);
            if (cluster.length >= 3) {
                return mean(cluster);
            }
        }

        // Final fallback: arithmetic mean
        return mean(cleaned);
    }

    /**
     * Merge Multiple Sequential Records with Same requestId, Take Final Status
     * Keep the status of the last record (completed/failed), but use the timestamp of the first record (request start time)
     * @param logs List of sequential records
     * @returns RecordMap merged by requestId
     */
    static mergeLogsByRequestId(logs: TokenRequestLog[]): Map<string, TokenRequestLog> {
        const mergedMap = new Map<string, TokenRequestLog>();

        for (const log of logs) {
            const existing = mergedMap.get(log.requestId);

            if (!existing) {
                // First time encountering this requestId, record initial timestamp
                mergedMap.set(log.requestId, { ...log });
            } else {
                // Already exists, keep the earlier timestamp (request start time), but update other fields to latest status
                if (log.timestamp < existing.timestamp) {
                    // Current record timestamp is earlier, update timestamp but keep other fields
                    existing.timestamp = log.timestamp;
                    existing.isoTime = log.isoTime;
                }
                // Regardless of timestamp, update to latest status (completed/failed and rawUsage)
                existing.status = log.status;
                existing.rawUsage = log.rawUsage;
                // Update stream time information
                if (log.streamStartTime !== undefined) {
                    existing.streamStartTime = log.streamStartTime;
                }
                if (log.streamEndTime !== undefined) {
                    existing.streamEndTime = log.streamEndTime;
                } else {
                    // Legacy data compatibility: historical records may only have final status update without separate streamEndTime recording.
                    // Here use this sequential record's time as fallback for end time, avoiding complete loss of historical data in duration/speed statistics.
                    existing.streamEndTime = log.timestamp;
                }
            }
        }

        return mergedMap;
    }

    /**
     * Aggregate Logs into Statistics Data
     * 1. First merge sequential records by requestId, take final status
     * 2. Only count successful (completed) requests
     * 3. Parse token statistics from rawUsage
     */
    static aggregateLogs(logs: TokenRequestLog[]): TokenUsageStatsFromFile {
        const stats: TokenUsageStatsFromFile = {
            total: {
                estimatedInput: 0,
                actualInput: 0,
                cacheTokens: 0,
                outputTokens: 0,
                requests: 0,
                completedRequests: 0,
                failedRequests: 0,
                firstTokenLatency: 0,
                outputSpeeds: 0
            },
            providers: {}
        };

        // Only collect "model-level" request speeds; provider/total speeds only do arithmetic mean of model's hourly speeds.
        const modelSpeedValues: Record<string, Record<string, number[]>> = {};
        // First Token latency does not undergo confidence processing: model/provider/total are all arithmetic means.
        const modelFirstTokenLatencyAcc: Record<string, Record<string, { sum: number; count: number }>> = {};

        // 1. Merge by requestId, take final status
        const mergedMap = this.mergeLogsByRequestId(logs);
        const finalLogs = Array.from(mergedMap.values());

        // 2. Iterate through merged logs
        for (const log of finalLogs) {
            // Count status of all requests to total
            stats.total.requests++;

            if (log.status === 'completed') {
                stats.total.completedRequests++;
            } else if (log.status === 'failed') {
                stats.total.failedRequests++;
            }

            // Initialize provider statistics (ensure all providers are recorded, even if request failed)
            if (!stats.providers[log.providerKey]) {
                stats.providers[log.providerKey] = {
                    providerName: log.providerName,
                    estimatedInput: 0,
                    actualInput: 0,
                    cacheTokens: 0,
                    outputTokens: 0,
                    requests: 0,
                    completedRequests: 0,
                    failedRequests: 0,
                    firstTokenLatency: 0,
                    outputSpeeds: 0,
                    models: {}
                };
            }

            const providerStats = stats.providers[log.providerKey];
            providerStats.requests++;

            if (log.status === 'completed') {
                providerStats.completedRequests++;
            } else if (log.status === 'failed') {
                providerStats.failedRequests++;
            }

            // Only count successful requests to token usage and speed
            if (log.status !== 'completed' || !log.rawUsage) {
                // If no rawUsage, use estimated input
                if (log.status === 'completed') {
                    stats.total.estimatedInput += log.estimatedInput;
                    stats.total.actualInput += log.estimatedInput;
                    providerStats.estimatedInput += log.estimatedInput;
                    providerStats.actualInput += log.estimatedInput;
                }
                continue;
            }

            // Parse token statistics from rawUsage
            const parsed = UsageParser.parseFromLog(log);

            // Update total (only successful requests)
            stats.total.estimatedInput += log.estimatedInput;
            stats.total.actualInput += parsed.actualInput;
            stats.total.cacheTokens += parsed.cacheReadTokens;
            stats.total.outputTokens += parsed.outputTokens;

            // Update provider's token statistics
            providerStats.estimatedInput += log.estimatedInput;
            providerStats.actualInput += parsed.actualInput;
            providerStats.cacheTokens += parsed.cacheReadTokens;
            providerStats.outputTokens += parsed.outputTokens;

            // Aggregate by model (only successful requests)
            if (!providerStats.models[log.modelId]) {
                providerStats.models[log.modelId] = {
                    modelName: log.modelName,
                    estimatedInput: 0,
                    actualInput: 0,
                    cacheTokens: 0,
                    outputTokens: 0,
                    requests: 0,
                    firstTokenLatency: 0,
                    outputSpeeds: 0
                };
            }

            const modelStats = providerStats.models[log.modelId];
            modelStats.estimatedInput += log.estimatedInput;
            modelStats.actualInput += parsed.actualInput;
            modelStats.cacheTokens += parsed.cacheReadTokens;
            modelStats.outputTokens += parsed.outputTokens;
            modelStats.requests++;

            // Speed samples only collected to "model" dimension.
            if (parsed.outputSpeed && parsed.outputSpeed > 0) {
                if (!modelSpeedValues[log.providerKey]) {
                    modelSpeedValues[log.providerKey] = {};
                }
                if (!modelSpeedValues[log.providerKey][log.modelId]) {
                    modelSpeedValues[log.providerKey][log.modelId] = [];
                }
                modelSpeedValues[log.providerKey][log.modelId].push(parsed.outputSpeed);
            }

            // First Token latency samples also only collected to "model" dimension (no confidence processing).
            if (log.streamStartTime !== undefined && log.timestamp !== undefined) {
                const firstTokenLatency = log.streamStartTime - log.timestamp;
                if (Number.isFinite(firstTokenLatency) && firstTokenLatency >= 0) {
                    if (!modelFirstTokenLatencyAcc[log.providerKey]) {
                        modelFirstTokenLatencyAcc[log.providerKey] = {};
                    }
                    if (!modelFirstTokenLatencyAcc[log.providerKey][log.modelId]) {
                        modelFirstTokenLatencyAcc[log.providerKey][log.modelId] = { sum: 0, count: 0 };
                    }
                    modelFirstTokenLatencyAcc[log.providerKey][log.modelId].sum += firstTokenLatency;
                    modelFirstTokenLatencyAcc[log.providerKey][log.modelId].count += 1;
                }
            }
        }

        // Only calculate and write "model-level" aggregated values; provider/total aggregation is uniformly calculated by upper layer after hourly cache completion.
        for (const [providerKey, providerStats] of Object.entries(stats.providers)) {
            for (const [modelId, modelStats] of Object.entries(providerStats.models)) {
                const speedValues = modelSpeedValues[providerKey]?.[modelId] || [];
                modelStats.outputSpeeds = this.calculateRobustMean(speedValues);

                const acc = modelFirstTokenLatencyAcc[providerKey]?.[modelId];
                modelStats.firstTokenLatency = acc && acc.count > 0 ? acc.sum / acc.count : 0;
            }
        }

        return stats;
    }
}
