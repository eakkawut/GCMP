/*---------------------------------------------------------------------------------------------
 *  Token Counter
 *  Handles all token counting related logic
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
    LanguageModelChatInformation,
    LanguageModelChatMessage,
    LanguageModelChatMessageRole,
    LanguageModelChatTool,
    ProvideLanguageModelChatResponseOptions
} from 'vscode';
import { createTokenizer, getRegexByEncoder, getSpecialTokensByEncoder, TikTokenizer } from '@microsoft/tiktokenizer';
import { Logger } from './logger';
import { sanitizeToolSchemaForSdkMode } from './schemaSanitizer';
import { CustomDataPartMimeTypes } from '../handlers/types';

/* ---------------------------------------------------------------------------------------------
 *  Token Counter Main Class
 *  Responsible for calculating token counts for messages, system messages, and tool definitions
 *------------------------------------------------------------------------------------------- */

/**
 * Globally shared tokenizer instance and extension path
 */
let sharedTokenizerPromise: TikTokenizer | null = null;
let extensionPath: string | null = null;
let sharedTokenCounterInstance: TokenCounter | null = null;

/**
 * Simple LRU cache implementation
 */
class LRUCache<T> {
    private cache = new Map<string, T>();
    constructor(private maxSize: number) { }

    get(key: string): T | undefined {
        const value = this.cache.get(key);
        if (value !== undefined) {
            // Move accessed item to end (most recently used)
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }

    put(key: string, value: T): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Delete oldest item (first)
            const firstKey = this.cache.keys().next().value;
            if (firstKey) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(key, value);
    }
}

/**
 * Token Counter class
 * Responsible for calculating token counts for messages, system messages, and tool definitions
 * Also manages globally shared tokenizer instance
 */
export class TokenCounter {
    /**
     * Text token cache (LRU, capacity 5000)
     */
    private tokenCache = new LRUCache<number>(5000);

    /**
     * Set extension path
     * Must be called before creating TokenCounter instance
     */
    static setExtensionPath(path: string): void {
        extensionPath = path;
        Logger.trace('\u2713 [TokenCounter] Extension path set');
    }

    /**
     * Get globally shared TokenCounter instance (singleton)
     */
    static getInstance(): TokenCounter {
        if (!sharedTokenCounterInstance) {
            sharedTokenCounterInstance = new TokenCounter();
            Logger.trace('\u2713 [TokenCounter] Global instance created');
        }
        return sharedTokenCounterInstance;
    }

    /**
     * Get shared tokenizer instance (lazy loaded, global singleton)
     */
    static getSharedTokenizer(): TikTokenizer {
        if (!sharedTokenizerPromise) {
            Logger.trace('\u{1F527} [TokenCounter] First tokenizer request, initializing global shared instance...');
            if (!extensionPath) {
                throw new Error('[TokenCounter] Extension path not initialized, please call TokenCounter.setExtensionPath() first');
            }
            const basePath = vscode.Uri.file(extensionPath!);
            const tokenizerPath = vscode.Uri.joinPath(basePath, 'dist', 'o200k_base.tiktoken').fsPath;
            sharedTokenizerPromise = createTokenizer(
                tokenizerPath,
                getSpecialTokensByEncoder('o200k_base'),
                getRegexByEncoder('o200k_base')
            );
            Logger.trace('\u2713 [TokenCounter] Tokenizer initialization complete');
        }
        return sharedTokenizerPromise;
    }

    constructor(private tokenizer?: TikTokenizer) {
        // If no tokenizer passed, use shared instance
        if (!this.tokenizer) {
            this.tokenizer = TokenCounter.getSharedTokenizer();
        }
    }

    /**
     * Calculate token count for text (with cache)
     */
    private getTextTokenLength(text: string): number {
        if (!text) {
            return 0;
        }

        // Check cache first
        const cacheValue = this.tokenCache.get(text);
        if (cacheValue !== undefined) {
            // Logger.trace(`[Cache hit] "${text.substring(0, 20)}..." -> ${cacheValue} tokens`);
            return cacheValue;
        }

        // Cache miss, calculate token count
        const tokenCount = this.tokenizer!.encode(text).length;

        // Store in cache
        this.tokenCache.put(text, tokenCount);
        // Logger.trace(`[Cache write] "${text.substring(0, 20)}..." -> ${tokenCount} tokens`);

        return tokenCount;
    }

    /**
     * Extract text content from message part
     */
    private extractPartText(part: unknown): string | null {
        if (!part || typeof part !== 'object') {
            return null;
        }

        const partObj = part as Record<string, unknown>;

        // Handle LanguageModelTextPart / LanguageModelThinkingPart
        if ('value' in partObj) {
            if (typeof partObj.value === 'string') {
                return partObj.value;
            }
            if (Array.isArray(partObj.value) && partObj.value.every(item => typeof item === 'string')) {
                return partObj.value.join('');
            }
        }

        // Handle binary/DataPart (especially images): avoid JSON.stringify expanding Uint8Array/Buffer into huge array causing inflated tokens
        if ('mimeType' in partObj && typeof partObj.mimeType === 'string' && 'data' in partObj) {
            const byteLength = getBinaryByteLength(partObj.data);
            return JSON.stringify({ mimeType: partObj.mimeType, byteLength });
        }

        // Handle other types of parts, convert to JSON string
        if ('name' in partObj || 'input' in partObj || 'callId' in partObj) {
            return JSON.stringify(partObj);
        }

        return null;
    }

    private estimateNonImageBinaryTokens(byteLength: number): number {
        if (!byteLength) {
            return 0;
        }
        // Make a small capped estimate for non-image binary payloads
        const base = 20;
        const per16Kb = Math.ceil(byteLength / 16384);
        return Math.min(200, base + per16Kb);
    }

    private estimateImageTokensFromBytes(bytes: Uint8Array, mimeType: string, detail: ImageDetail): number {
        try {
            return estimateImageTokensFromBytes(bytes, mimeType, detail);
        } catch {
            // Best degradation: if unable to parse dimensions, avoid count explosion
            return this.estimateNonImageBinaryTokens(bytes.byteLength);
        }
    }

    private estimateImagePartTotalTokens(bytes: Uint8Array, mimeType: string, detail: ImageDetail): number {
        // 1) Image body cost: aligned with vscode-copilot-chat (tiles*170+85)
        const imageCost = this.estimateImageTokensFromBytes(bytes, mimeType, detail);

        // 2) Wrapper cost: request still needs to carry structured "image part"
        // Here deliberately exclude base64 payload, only estimate wrapper overhead with minimal JSON skeleton
        const wrapperSkeleton = `{"type":"image_url","image_url":{"url":"data:${mimeType};base64,"}}`;
        const wrapperTokens = this.getTextTokenLength(wrapperSkeleton);

        return imageCost + wrapperTokens;
    }

    /**
     * Calculate token count for single text or message object
     */
    async countTokens(_model: LanguageModelChatInformation, text: string | LanguageModelChatMessage): Promise<number> {
        if (typeof text === 'string') {
            const stringTokens = this.tokenizer!.encode(text).length;
            // Logger.trace(`[Token count] String: ${stringTokens} tokens (length: ${text.length})`);
            return stringTokens;
        }

        // Handle LanguageModelChatMessage object
        try {
            const objectTokens = await this.countMessageObjectTokens(text as unknown as Record<string, unknown>);
            // Logger.trace(`[Token count] Object message: ${objectTokens} tokens`);
            return objectTokens;
        } catch (error) {
            Logger.warn('[Token count] Failed to calculate message object tokens, using simplified calculation:', error);
            // Fallback: convert message object to JSON string for calculation
            const fallbackTokens = this.tokenizer!.encode(JSON.stringify(text)).length;
            Logger.trace(`[Token count] Fallback calculation: ${fallbackTokens} tokens`);
            return fallbackTokens;
        }
    }

    /**
     * Recursively calculate token count in message object
     * Supports complex content like text, images, tool calls, thinking content, etc.
     */
    async countMessageObjectTokens(obj: Record<string, unknown>, depth: number = 0): Promise<number> {
        // ThinkingPart: only count text content, don't recurse into metadata
        if (obj instanceof vscode.LanguageModelThinkingPart) {
            const thinkingText = this.extractPartText(obj);
            return thinkingText ? this.getTextTokenLength(thinkingText) : 0;
        }

        // DataPart / binary part: don't expand data array for byte-by-byte counting
        if (obj && typeof obj.mimeType === 'string' && 'data' in obj) {
            if (obj.mimeType === CustomDataPartMimeTypes.CacheControl) {
                return 0; // cache_control type parts don't count towards tokens
            }
            if (obj.mimeType === CustomDataPartMimeTypes.StatefulMarker) {
                return 0; // stateful_marker type parts don't count towards tokens
            }
            const bytes = getBinaryUint8Array(obj.data);
            if (bytes) {
                const mimeType = String(obj.mimeType);
                if (isImageMimeType(mimeType)) {
                    return this.estimateImagePartTotalTokens(bytes, mimeType, 'auto');
                }
                return this.getTextTokenLength(mimeType) + this.estimateNonImageBinaryTokens(bytes.byteLength);
            }
        }

        let numTokens = 0;
        // const indent = '  '.repeat(depth);

        // Each object/message needs some extra tokens for separation and formatting
        if (depth === 0) {
            // Message separator and base formatting overhead (3 tokens is more accurate than 1)
            const overheadTokens = 3;
            numTokens += overheadTokens;
            // Logger.trace(`${indent}[Overhead] Message separator: ${overheadTokens} tokens`);
        }

        for (const [, value] of Object.entries(obj)) {
            if (!value) {
                continue;
            }

            // Large binary data (Uint8Array / Buffer JSON / number[]): use estimation instead of recursive traversal to avoid token inflation and performance issues
            // Note: DataPart (including images) is already handled uniformly at the beginning of this method, here only handles other binary data
            const binaryByteLength = getBinaryByteLength(value);
            if (binaryByteLength > 0) {
                numTokens += this.estimateNonImageBinaryTokens(binaryByteLength);
                continue;
            }

            if (typeof value === 'string') {
                // String content directly calculate tokens (using cache)
                const tokens = this.getTextTokenLength(value);
                numTokens += tokens;
                // Logger.trace(`${indent}[${key}] String: ${tokens} tokens`);
            } else if (typeof value === 'number' || typeof value === 'boolean') {
                // Numbers and booleans also calculate tokens (using cache)
                const tokens = this.getTextTokenLength(String(value));
                numTokens += tokens;
                // Logger.trace(`${indent}[${key}] ${typeof value}: ${tokens} tokens`);
            } else if (Array.isArray(value)) {
                // Array handling
                // Logger.trace(`${indent}[${key}] Array (${value.length} items)`);
                for (const item of value) {
                    if (typeof item === 'string') {
                        const tokens = this.getTextTokenLength(item);
                        numTokens += tokens;
                        // Logger.trace(`${indent}  [value] String: ${tokens} tokens`);
                    } else if (typeof item === 'number' || typeof item === 'boolean') {
                        const tokens = this.getTextTokenLength(String(item));
                        numTokens += tokens;
                        // Logger.trace(`${indent}  [${typeof item}] ${typeof item}: ${tokens} tokens`);
                    } else if (item && typeof item === 'object') {
                        // Nested object array
                        const itemTokens = await this.countMessageObjectTokens(
                            item as Record<string, unknown>,
                            depth + 2
                        );
                        numTokens += itemTokens;
                    }
                }
            } else if (typeof value === 'object') {
                // Logger.trace(`${indent}[${key}] Object type`);
                const nestedTokens = await this.countMessageObjectTokens(value as Record<string, unknown>, depth + 1);
                numTokens += nestedTokens;
            }
        }

        return numTokens;
    }

    /**
     * Calculate total token count for multiple messages
     * Includes regular messages, system messages, tool definitions, and thinking content (based on configuration)
     */
    async countMessagesTokens(
        model: LanguageModelChatInformation,
        messages: Array<LanguageModelChatMessage>,
        modelConfig?: { sdkMode?: string },
        options?: ProvideLanguageModelChatResponseOptions
    ): Promise<number> {
        let totalTokens = 0;
        // Logger.trace(`[Token count] Starting to calculate tokens for ${messages.length} messages...`);

        // Calculate message tokens
        // eslint-disable-next-line @typescript-eslint/prefer-for-of
        for (let i = 0; i < messages.length; i++) {
            const message = messages[i];

            const messageTokens = await this.countTokens(
                model,
                message as unknown as string | LanguageModelChatMessage
            );
            totalTokens += messageTokens;
            // Logger.trace(`[Token count] Message #${i + 1}: ${messageTokens} tokens (cumulative: ${totalTokens})`);
        }

        const sdkMode = modelConfig?.sdkMode || 'openai';

        if (sdkMode === 'anthropic') {
            // Add system message and tool token costs for Anthropic SDK mode
            // Calculate system message token cost
            const systemMessageTokens = this.countSystemMessageTokens(messages);
            if (systemMessageTokens > 0) {
                totalTokens += systemMessageTokens;
                // Logger.trace(`[Token count] System messages: ${systemMessageTokens} tokens (cumulative: ${totalTokens})`);
            }
        }

        // Tool costs (all use 1.1x)
        const toolsTokens = this.countToolsTokens(options?.tools, modelConfig);
        if (toolsTokens > 0) {
            totalTokens += toolsTokens;
            // Logger.trace(
            //     `[Token count] Tool definitions (${options?.tools?.length || 0} tools): ${toolsTokens} tokens (cumulative: ${totalTokens})`
            // );
        }

        // Logger.info(
        //     `[Token count] Total: ${messages.length} messages${sdkMode === 'anthropic' ? ' + system messages + tool definitions' : ' (OpenAI SDK)'}, ${totalTokens} tokens`
        // );
        return totalTokens;
    }

    /**
     * Calculate token count for system messages
     * Extract all system messages from message list and calculate combined
     */
    private countSystemMessageTokens(messages: Array<LanguageModelChatMessage>): number {
        let systemText = '';

        for (const message of messages) {
            if (message.role === LanguageModelChatMessageRole.System) {
                if (typeof message.content === 'string') {
                    systemText += message.content;
                }
            }
        }

        if (!systemText) {
            return 0;
        }

        // Calculate system message token count - use caching mechanism
        const systemTokens = this.getTextTokenLength(systemText);

        // Anthropic's system message processing adds some extra formatting tokens
        // Actual testing shows system message wrapper overhead is approximately 25-30 tokens
        const systemOverhead = 28;
        const totalSystemTokens = systemTokens + systemOverhead;

        Logger.debug(
            `[Token count] System message details: content ${systemTokens} tokens + wrapper overhead ${systemOverhead} tokens = ${totalSystemTokens} tokens`
        );
        return totalSystemTokens;
    }

    /**
     * Calculate token count for tool definitions
     * Follows official VS Code Copilot implementation:
     * - Base overhead: 16 tokens (tool array overhead)
     * - Per tool: 8 tokens + object content tokens
     * - Finally multiply by 1.1 safety factor (official standard)
     */
    private countToolsTokens(tools?: readonly LanguageModelChatTool[], modelConfig?: { sdkMode?: string }): number {
        const baseToolTokens = 16;
        let numTokens = 0;
        if (!tools || tools.length === 0) {
            return 0;
        }

        numTokens += baseToolTokens;

        const baseTokensPerTool = 8;
        for (const tool of tools) {
            numTokens += baseTokensPerTool;
            const serializedSchema = tool.inputSchema
                ? sanitizeToolSchemaForSdkMode(tool.inputSchema, modelConfig?.sdkMode)
                : undefined;
            // Calculate tool object tokens (name, description, parameters)
            const toolObj = {
                name: tool.name,
                description: tool.description || '',
                input_schema: serializedSchema
            };
            // Simple heuristic: iterate object and calculate tokens (using cache)
            for (const [, value] of Object.entries(toolObj)) {
                if (typeof value === 'string') {
                    numTokens += this.getTextTokenLength(value);
                } else if (value && typeof value === 'object') {
                    // For JSON objects, use JSON string encoding (using cache)
                    numTokens += this.getTextTokenLength(JSON.stringify(value));
                }
            }
        }

        // Use official standard 1.1 safety factor
        return Math.floor(numTokens * 1.1);
    }
}

/* ---------------------------------------------------------------------------------------------
 *  Binary Data Utilities
 *  For safely handling Uint8Array/ArrayBuffer/Buffer and other binary payloads
 *------------------------------------------------------------------------------------------- */

function isBufferJson(value: unknown): value is { type: 'Buffer'; data: number[] } {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const obj = value as { type?: unknown; data?: unknown };
    return obj.type === 'Buffer' && Array.isArray(obj.data);
}

function getBinaryByteLength(value: unknown): number {
    if (!value) {
        return 0;
    }
    if (value instanceof Uint8Array) {
        return value.byteLength;
    }
    if (value instanceof ArrayBuffer) {
        return value.byteLength;
    }
    if (ArrayBuffer.isView(value)) {
        return value.byteLength;
    }
    if (isBufferJson(value)) {
        return value.data.length;
    }
    if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'number')) {
        return value.length;
    }
    return 0;
}

function getBinaryUint8Array(value: unknown): Uint8Array | undefined {
    if (!value) {
        return undefined;
    }
    if (value instanceof Uint8Array) {
        return value;
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (isBufferJson(value)) {
        return new Uint8Array(value.data);
    }
    if (Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'number')) {
        return new Uint8Array(value);
    }
    return undefined;
}

/* ---------------------------------------------------------------------------------------------
 *  Image Token Estimator
 *  Aligned with microsoft/vscode-copilot-chat implementation (OpenAI Vision image cost estimation)
 *------------------------------------------------------------------------------------------- */

type ImageDetail = 'low' | 'high' | 'auto' | undefined;

function isImageMimeType(mimeType: string): boolean {
    return mimeType.startsWith('image/');
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function getImageDimensionsFromBytes(bytes: Uint8Array, mimeType: string): { width: number; height: number } {
    const mt = mimeType.toLowerCase();

    if (mt === 'image/png') {
        if (bytes.length < 24) {
            throw new Error('PNG too small');
        }
        const width = readUInt32BE(bytes, 16);
        const height = readUInt32BE(bytes, 20);
        return { width, height };
    }

    if (mt === 'image/gif') {
        if (bytes.length < 10) {
            throw new Error('GIF too small');
        }
        const width = readUInt16LE(bytes, 6);
        const height = readUInt16LE(bytes, 8);
        return { width, height };
    }

    if (mt === 'image/jpeg' || mt === 'image/jpg') {
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
            throw new Error('Invalid JPEG');
        }

        let offset = 2;
        while (offset + 4 < bytes.length) {
            if (bytes[offset] !== 0xff) {
                offset++;
                continue;
            }

            const marker = readUInt16BE(bytes, offset);
            if (marker === 0xffd8 || marker === 0xffd9) {
                offset += 2;
                continue;
            }

            if (offset + 4 >= bytes.length) {
                break;
            }

            const segmentLength = readUInt16BE(bytes, offset + 2);

            if (marker >= 0xffc0 && marker <= 0xffc2) {
                if (offset + 9 >= bytes.length) {
                    break;
                }
                const height = readUInt16BE(bytes, offset + 5);
                const width = readUInt16BE(bytes, offset + 7);
                return { width, height };
            }

            offset += 2 + segmentLength;
        }

        throw new Error('JPEG dimensions not found');
    }

    if (mt === 'image/webp') {
        if (bytes.length < 16) {
            throw new Error('WEBP too small');
        }
        const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
        const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        if (riff !== 'RIFF' || webp !== 'WEBP') {
            throw new Error('Invalid WEBP');
        }

        let offset = 12;
        while (offset + 8 <= bytes.length) {
            const fourcc = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
            const size = readUInt32LE(bytes, offset + 4);
            const dataStart = offset + 8;
            if (dataStart + size > bytes.length) {
                break;
            }

            if (fourcc === 'VP8X') {
                if (size < 10) {
                    throw new Error('Invalid VP8X');
                }
                const width = 1 + (bytes[dataStart + 4] | (bytes[dataStart + 5] << 8) | (bytes[dataStart + 6] << 16));
                const height = 1 + (bytes[dataStart + 7] | (bytes[dataStart + 8] << 8) | (bytes[dataStart + 9] << 16));
                return { width, height };
            }

            if (fourcc === 'VP8 ') {
                if (size >= 10) {
                    const width = (readUInt16LE(bytes, dataStart + 6) & 0x3fff) >>> 0;
                    const height = (readUInt16LE(bytes, dataStart + 8) & 0x3fff) >>> 0;
                    if (width > 0 && height > 0) {
                        return { width, height };
                    }
                }
            }

            if (fourcc === 'VP8L') {
                if (size >= 5 && bytes[dataStart] === 0x2f) {
                    const b0 = bytes[dataStart + 1];
                    const b1 = bytes[dataStart + 2];
                    const b2 = bytes[dataStart + 3];
                    const b3 = bytes[dataStart + 4];
                    const bits = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
                    const width = (bits & 0x3fff) + 1;
                    const height = ((bits >> 14) & 0x3fff) + 1;
                    return { width, height };
                }
            }

            offset = dataStart + size + (size % 2);
        }

        throw new Error('WEBP dimensions not found');
    }

    if (mt === 'image/bmp') {
        if (bytes.length < 26) {
            throw new Error('BMP too small');
        }
        const width = readUInt32LE(bytes, 18) | 0;
        const rawHeight = readUInt32LE(bytes, 22) | 0;
        const height = Math.abs(rawHeight);
        if (width <= 0 || height <= 0) {
            throw new Error('Invalid BMP');
        }
        return { width, height };
    }

    throw new Error(`Unsupported image format: ${mimeType}`);
}

// Aligned with microsoft/vscode-copilot-chat implementation
// https://platform.openai.com/docs/guides/vision#calculating-costs
//
// Calculation examples:
// 1. Low detail mode: fixed 85 tokens
//    calculateOpenAIVisionImageTokenCost(1920, 1080, 'low') = 85
//
// 2. Small image (512x512, no scaling needed):
//    - tiles = ceil(512/512) * ceil(512/512) = 1 * 1 = 1
//    - tokens = 1 * 170 + 85 = 255
//    calculateOpenAIVisionImageTokenCost(512, 512, 'auto') = 255
//
// 3. Medium image (1024x768):
//    - Shortest side scaled to 768: scaleFactor = 768/768 = 1, no scaling needed
//    - tiles = ceil(1024/512) * ceil(768/512) = 2 * 2 = 4
//    - tokens = 4 * 170 + 85 = 765
//    calculateOpenAIVisionImageTokenCost(1024, 768, 'auto') = 765
//
// 4. Large image (3000x2000, first scale to within 2048x2048):
//    - Step 1: scaleFactor = 2048/3000 ≈ 0.683
//      Scaled: 2048 x 1365
//    - Step 2: scaleFactor = 768/1365 ≈ 0.563
//      Scaled: 1153 x 768
//    - tiles = ceil(1153/512) * ceil(768/512) = 3 * 2 = 6
//    - tokens = 6 * 170 + 85 = 1105
//    calculateOpenAIVisionImageTokenCost(3000, 2000, 'auto') = 1105
//
// 5. Extra large image (4000x3000):
//    - Step 1: scaleFactor = 2048/4000 = 0.512
//      Scaled: 2048 x 1536
//    - Step 2: scaleFactor = 768/1536 = 0.5
//      Scaled: 1024 x 768
//    - tiles = ceil(1024/512) * ceil(768/512) = 2 * 2 = 4
//    - tokens = 4 * 170 + 85 = 765
//    calculateOpenAIVisionImageTokenCost(4000, 3000, 'auto') = 765
//
function calculateOpenAIVisionImageTokenCost(width: number, height: number, detail: ImageDetail): number {
    if (detail === 'low') {
        return 85;
    }

    if (width > 2048 || height > 2048) {
        const scaleFactor = 2048 / Math.max(width, height);
        width = Math.round(width * scaleFactor);
        height = Math.round(height * scaleFactor);
    }

    const scaleFactor = 768 / Math.min(width, height);
    width = Math.round(width * scaleFactor);
    height = Math.round(height * scaleFactor);

    const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
    return tiles * 170 + 85;
}

function estimateImageTokensFromBytes(bytes: Uint8Array, mimeType: string, detail: ImageDetail): number {
    const { width, height } = getImageDimensionsFromBytes(bytes, mimeType);
    return calculateOpenAIVisionImageTokenCost(width, height, detail);
}
