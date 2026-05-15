/*---------------------------------------------------------------------------------------------
 *  Gemini HTTP Handler
 *  Pure fetch + custom stream parsing (compatible with SSE data: and JSON line streaming), no Google SDK dependency
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiKeyManager } from '../utils/apiKeyManager';
import { ConfigManager } from '../utils/configManager';
import { Logger } from '../utils/logger';
import { TokenUsagesManager } from '../usages/usagesManager';
import type { ModelConfig, ProviderConfig } from '../types/sharedTypes';
import type { GenericUsageData, RawUsageData } from '../usages/fileLogger/types';
import { convertMessagesToGemini, convertToolsToGemini } from './geminiConverter';
import { getStatefulMarkerAndIndex } from './statefulMarker';
import { StreamReporter } from './streamReporter';
import type { GenericModelProvider } from '../providers/genericModelProvider';
import type {
    GeminiGenerationConfig,
    GeminiGenerateContentRequest,
    GeminiGenerateContentResponse,
    GeminiPart,
    GeminiTool
} from './geminiType';

export class GeminiHandler {
    /** Cache managed project obtained from loadCodeAssist (key = baseUrl:tokenSuffix) */
    private readonly codeAssistProjectCache = new Map<string, string>();
    /** Cache extension version */
    private static extensionVersion: string | null = null;
    /** Cache available Gemini model list */
    private static availableModels: string[] | null = null;

    /** Default Gemini CLI version */
    private static readonly defaultCliVersion = '0.37.2';

    constructor(private readonly providerInstance: GenericModelProvider) { }

    private get provider(): string {
        return this.providerInstance.provider;
    }
    private get providerConfig(): ProviderConfig | undefined {
        return this.providerInstance.providerConfig;
    }
    private get displayName(): string {
        return this.providerConfig?.displayName || this.provider;
    }

    /**
     * Normalize baseUrl: remove leading/trailing whitespace and trailing `/`.
     * Purpose: Avoid URL construction failure caused by `//` or empty string when concatenating paths.
     */
    private normalizeBaseUrl(baseUrl: string | undefined): string {
        const v = typeof baseUrl === 'string' ? baseUrl.trim() : '';
        return v.endsWith('/') ? v.slice(0, -1) : v;
    }

    private isCodeAssistBaseUrl(baseUrl: string): boolean {
        const normalized = this.normalizeBaseUrl(baseUrl);
        try {
            const u = new URL(normalized);
            return u.hostname.toLowerCase() === 'cloudcode-pa.googleapis.com';
        } catch {
            return normalized.toLowerCase().includes('cloudcode-pa.googleapis.com');
        }
    }

    private buildCodeAssistEndpoint(baseUrl: string, stream: boolean): string {
        const normalized = this.normalizeBaseUrl(baseUrl);
        if (!normalized) {
            return '';
        }

        // Code Assist API uses `v1internal:{method}`
        const method = stream ? 'streamGenerateContent' : 'generateContent';

        try {
            const u0 = new URL(normalized);
            // If already configured as a complete endpoint, preserve it and only normalize the method.
            let p = (u0.pathname || '').replace(/\/+$/, '') || '/';
            if (/:generateContent$/i.test(p) || /:streamGenerateContent$/i.test(p)) {
                u0.pathname = p.replace(/:(streamGenerateContent|generateContent)$/i, `:${method}`);
            } else {
                // Normalize if `/v1internal` prefix exists, otherwise default to `/v1internal`.
                // Important: Code Assist methods are appended as `/v1internal:{method}` (no additional '/').
                const pLower = p.toLowerCase();
                const idx = pLower.indexOf('/v1internal');

                if (idx >= 0) {
                    // Trim any extra segments that may have accidentally appeared after /v1internal in baseUrl.
                    p = p.slice(0, idx + '/v1internal'.length);
                } else {
                    p = this.joinPathPrefix(p, '/v1internal');
                }

                const basePath = (p || '').replace(/\/+$/, '');
                u0.pathname = `${basePath}:${method}`;
            }

            if (stream) {
                u0.searchParams.set('alt', 'sse');
            }
            return u0.toString();
        } catch {
            const join = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
            const url = `${join}/v1internal:${method}`;
            return stream ? `${url}${url.includes('?') ? '&' : '?'}alt=sse` : url;
        }
    }

    /**
     * Build Gemini `:streamGenerateContent` SSE endpoint (streaming paths only).
     *
     * Key compatibility points:
     * - baseUrl may be: domain root, with /v1beta prefix, or even complete `:generateContent/:streamGenerateContent` endpoint.
     * - Streaming mode automatically adds `alt=sse` (compatible with official and third-party Gemini gateways).
     */
    private buildEndpoint(baseUrl: string, modelId: string, stream: boolean): string {
        const normalized = this.normalizeBaseUrl(baseUrl);
        if (!normalized) {
            return '';
        }

        // Special handling for Gemini Code Assist endpoint.
        if (this.isCodeAssistBaseUrl(normalized)) {
            return this.buildCodeAssistEndpoint(normalized, stream);
        }

        const method = stream ? 'streamGenerateContent' : 'generateContent';

        try {
            const u0 = new URL(normalized);
            let basePath = (u0.pathname || '').replace(/\/+$/, '') || '/';

            // If already configured as a complete endpoint, preserve it (switch method based on streaming only).
            if (/:generateContent$/i.test(basePath) || /:streamGenerateContent$/i.test(basePath)) {
                u0.pathname = basePath.replace(/:(streamGenerateContent|generateContent)$/i, `:${method}`);
                if (stream) {
                    u0.searchParams.set('alt', 'sse');
                }
                return u0.toString();
            }

            const modelPath = this.normalizeGeminiModelPath(modelId);
            if (!modelPath) {
                return '';
            }

            // If the base path already contains a version segment, do not append again.
            if (!/\/v1beta$/i.test(basePath) && !/\/v1beta\//i.test(`${basePath}/`)) {
                basePath = this.joinPathPrefix(basePath, '/v1beta');
            }

            u0.pathname = this.joinPathPrefix(basePath, `/${modelPath}:${method}`);
            if (stream) {
                u0.searchParams.set('alt', 'sse');
            }
            return u0.toString();
        } catch {
            // Non-URL baseUrl (best-effort fallback)
            const modelPath = this.normalizeGeminiModelPath(modelId);
            if (!modelPath) {
                return '';
            }
            const suffix = stream ? ':streamGenerateContent' : ':generateContent';
            const join = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
            const url = `${join}/v1beta/${modelPath}${suffix}`;
            return stream ? `${url}${url.includes('?') ? '&' : '?'}alt=sse` : url;
        }
    }

    private joinPathPrefix(basePath: string, nextPath: string): string {
        const a = basePath || '';
        const b = nextPath || '';
        const aTrim = a.endsWith('/') ? a.slice(0, -1) : a;
        const bTrim = b.startsWith('/') ? b : `/${b}`;
        return `${aTrim || ''}${bTrim}`;
    }

    private normalizeGeminiModelPath(modelId: string): string {
        const raw = (modelId || '').trim();
        if (!raw) {
            return 'models/gemini-2.5-flash';
        }

        if (raw.includes('..') || raw.includes('?') || raw.includes('&') || raw.includes('#')) {
            return '';
        }

        // Accept user-provided "models/..." or "tunedModels/..."
        if (/^(models|tunedModels)\//i.test(raw)) {
            return raw;
        }

        // If user accidentally passed full path like "/v1beta/models/xxx", try to recover the tail.
        const m = raw.match(/\b(models|tunedModels)\/[A-Za-z0-9._-]+/i);
        if (m && typeof m[0] === 'string' && m[0]) {
            return m[0];
        }

        return `models/${raw}`;
    }

    private isPlainObject(value: unknown): value is Record<string, unknown> {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        const proto = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
    }

    private deepMergePlainObjects(
        base: Record<string, unknown>,
        override: Record<string, unknown>
    ): Record<string, unknown> {
        const out: Record<string, unknown> = { ...base };
        for (const [key, value] of Object.entries(override)) {
            if (value === undefined) {
                continue;
            }
            const existing = out[key];
            if (this.isPlainObject(existing) && this.isPlainObject(value)) {
                out[key] = this.deepMergePlainObjects(existing, value);
                continue;
            }
            out[key] = value;
        }
        return out;
    }

    private extractGenerationConfigOverrides(extraBody: Record<string, unknown>): Record<string, unknown> {
        const overrides: Record<string, unknown> = {};
        // Compatible with old style: extraBody.generationConfig
        const nested = (extraBody as Record<string, unknown>).generationConfig;
        if (this.isPlainObject(nested)) {
            Object.assign(overrides, nested);
        }
        // New style: extraBody directly as supplementary fields of generationConfig
        for (const [k, v] of Object.entries(extraBody)) {
            // Code Assist wrapper specific fields: should not enter generationConfig
            if (k === 'project' || k === 'generationConfig') {
                continue;
            }
            overrides[k] = v;
        }
        return overrides;
    }

    private parseDotEnv(text: string): Record<string, string> {
        const out: Record<string, string> = {};
        const lines = (text || '').split(/\r?\n/);
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) {
                continue;
            }
            const eq = line.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            const key = line.slice(0, eq).trim();
            let value = line.slice(eq + 1).trim();
            if (!key) {
                continue;
            }
            // Remove quotes
            if (value.startsWith('"') && value.endsWith('"')) {
                value = value.slice(1, -1);
            }
            out[key] = value;
        }
        return out;
    }

    private async discoverProjectId(modelConfig: ModelConfig): Promise<string | undefined> {
        // 1) Explicit configuration
        const fromExtra = modelConfig?.extraBody?.project;
        if (typeof fromExtra === 'string' && fromExtra.trim()) {
            return fromExtra.trim();
        }

        // 2) Environment variables
        const envCandidates = [
            process.env.GOOGLE_CLOUD_PROJECT,
            process.env.GOOGLE_CLOUD_PROJECT_ID,
            process.env.CLOUDSDK_CORE_PROJECT,
            process.env.GCLOUD_PROJECT
        ];
        for (const c of envCandidates) {
            if (typeof c === 'string' && c.trim()) {
                return c.trim();
            }
        }

        // 3) ~/.gemini/.env file
        try {
            const envPath = path.join(os.homedir(), '.gemini', '.env');
            if (!fs.existsSync(envPath)) {
                return undefined;
            }
            const text = await fs.promises.readFile(envPath, 'utf-8');
            const parsed = this.parseDotEnv(text);
            const v =
                parsed.GOOGLE_CLOUD_PROJECT ||
                parsed.GOOGLE_CLOUD_PROJECT_ID ||
                parsed.CLOUDSDK_CORE_PROJECT ||
                parsed.GCLOUD_PROJECT;
            if (typeof v === 'string' && v.trim()) {
                return v.trim();
            }
        } catch (err) {
            Logger.trace('[Gemini] Failed to read ~/.gemini/.env:', err);
        }
        return undefined;
    }

    /**
     * Build User-Agent for Code Assist requests (aligned with Gemini CLI).
     */
    /**
     * Get actual Gemini CLI version (by executing `gemini --version`).
     * This fully mimics Gemini CLI and automatically uses new version when CLI is updated.
     */
    private static async getGeminiCliVersion(): Promise<string> {
        if (GeminiHandler.extensionVersion) {
            return GeminiHandler.extensionVersion;
        }
        try {
            const output = execSync('gemini --version', { encoding: 'utf-8', timeout: 5000 }).trim();
            // Gemini CLI --version usually outputs format like "0.33.0" or "gemini-cli v0.33.0" etc.
            const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
            if (versionMatch) {
                const version = versionMatch[1];
                GeminiHandler.extensionVersion = version;
                Logger.info(`[Gemini] Detected Gemini CLI version: ${version}`);
                return version;
            }
        } catch (e) {
            Logger.warn('[Gemini] Unable to get Gemini CLI version, will use default version', e);
        }
        // Default version: aligned with current latest Gemini CLI version
        const defaultVersion = GeminiHandler.defaultCliVersion;
        GeminiHandler.extensionVersion = defaultVersion;
        return defaultVersion;
    }

    private buildCodeAssistUserAgent(modelId: string): string {
        const platform = process.platform;
        const arch = process.arch;
        const version = GeminiHandler.extensionVersion || GeminiHandler.defaultCliVersion;
        return `GeminiCLI/${version}/${modelId} (${platform}; ${arch})`;
    }

    /**
     * Call loadCodeAssist interface to obtain Google-managed cloudaicompanionProject.
     * Mimics Gemini CLI personal OAuth mode behavior: call this interface first to let server assign project on first request.
     * Results cached by baseUrl+token suffix to avoid calling on every request.
     */
    private async callLoadCodeAssist(
        baseUrl: string,
        accessToken: string,
        modelId: string
    ): Promise<string | undefined> {
        const cacheKey = `${baseUrl}::${accessToken.slice(-12)}`;
        const cached = this.codeAssistProjectCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const endpoint = `${baseUrl}/v1internal:loadCodeAssist`;
        try {
            const body = {
                metadata: {
                    ideType: 'IDE_UNSPECIFIED',
                    platform: 'PLATFORM_UNSPECIFIED',
                    pluginType: 'GEMINI'
                }
            };
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${accessToken}`,
                    'User-Agent': this.buildCodeAssistUserAgent(modelId)
                },
                body: JSON.stringify(body)
            });
            const text = await res.text();
            if (!res.ok) {
                Logger.warn(`[Gemini] loadCodeAssist failed (${res.status}): ${text.slice(0, 200)}`);
                return undefined;
            }
            let data: Record<string, unknown> = {};
            try {
                data = JSON.parse(text) as Record<string, unknown>;
            } catch {
                return undefined;
            }
            const project = data.cloudaicompanionProject;
            if (typeof project === 'string' && project.trim()) {
                const projectId = project.trim();
                this.codeAssistProjectCache.set(cacheKey, projectId);
                Logger.info(`[Gemini] loadCodeAssist retrieved managed project: ${projectId}`);
                return projectId;
            }
            return undefined;
        } catch (err) {
            Logger.warn('[Gemini] callLoadCodeAssist exception:', err);
            return undefined;
        }
    }

    /**
     * Code Assist specific project discovery logic.
     * Priority: static config > loadCodeAssist API (mimics Gemini CLI personal OAuth flow).
     */
    private async discoverCodeAssistProjectId(
        modelConfig: ModelConfig,
        accessToken: string,
        modelId: string,
        baseUrl: string
    ): Promise<string | undefined> {
        const staticProject = await this.discoverProjectId(modelConfig);
        if (staticProject) {
            return staticProject;
        }
        return this.callLoadCodeAssist(baseUrl, accessToken, modelId);
    }

    /**
     * Ensure Gemini CLI version is loaded (async initialization).
     * First call will actually execute `gemini --version`, subsequent calls return cached value.
     */
    private static async ensureCliVersionLoaded(): Promise<void> {
        if (!GeminiHandler.extensionVersion) {
            await GeminiHandler.getGeminiCliVersion();
        }
    }

    /**
     * Get available Gemini model list.
     * Currently uses static list (extracted from gemini.json) as fallback.
     *
     * Note: If @google/genai SDK is installed in dependencies, this method can be upgraded
     * to call models.list() API to get real-time model list:
     *
     *   const { GoogleAIFileManager } = require('@google/genai');
     *   const fileManager = new GoogleAIFileManager(accessToken);
     *   const { models } = await fileManager.listCachedFiles();
     *
     * Currently Gemini CLI 0.33.0 uses the following model list:
     * - gemini-3.1-pro-preview
     * - gemini-3.1-pro-preview-customtools
     * - gemini-3-pro-preview
     * - gemini-3-flash-preview
     * - gemini-2.5-pro
     * - gemini-2.5-flash
     * - gemini-2.5-flash-lite
     */
    static async getAvailableModels(
        _accessToken?: string // Reserved parameter, used if upgraded to SDK API call
    ): Promise<string[]> {
        if (GeminiHandler.availableModels) {
            return GeminiHandler.availableModels;
        }

        // Static model list (current approach)
        const staticModels = [
            'gemini-3.1-pro-preview',
            'gemini-3.1-pro-preview-customtools',
            'gemini-3-pro-preview',
            'gemini-3-flash-preview',
            'gemini-2.5-pro',
            'gemini-2.5-flash',
            'gemini-2.5-flash-lite'
        ];
        GeminiHandler.availableModels = staticModels;
        return staticModels;
    }

    private async getApiKey(modelConfig?: ModelConfig): Promise<string> {
        const providerKey = modelConfig?.provider || this.provider;
        const currentApiKey = await ApiKeyManager.getApiKey(providerKey);
        if (!currentApiKey) {
            throw new Error(`Missing ${this.displayName} API key`);
        }
        return currentApiKey;
    }

    async handleRequest(
        model: vscode.LanguageModelChatInformation,
        modelConfig: ModelConfig,
        messages: readonly vscode.LanguageModelChatMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
        token: vscode.CancellationToken,
        requestId?: string | null
    ): Promise<void> {
        // Ensure Gemini CLI version number is loaded (first call will execute `gemini --version`, subsequent calls return cached).
        await GeminiHandler.ensureCliVersionLoaded();

        const apiKey = await this.getApiKey(modelConfig);

        // Gemini HTTP mode requires baseUrl: prefer model-level baseUrl, fallback to provider-level baseUrl.
        const baseUrl = modelConfig.baseUrl || this.providerConfig?.baseUrl;

        // Merge provider-level & model-level customHeader, and replace ${APIKEY}
        const mergedCustomHeader = {
            ...(this.providerConfig?.customHeader || {}),
            ...(modelConfig.customHeader || {})
        };
        // By default use extension built-in stored apiKey to inject auth header; also allow user to override auth method via customHeader.
        const processedHeaders = ApiKeyManager.processCustomHeader(mergedCustomHeader, apiKey);

        // Purpose: Convert VS Code's messages / tools to structures acceptable by Gemini HTTP API.
        const { contents, systemInstruction } = convertMessagesToGemini(messages);
        const tools: GeminiTool[] = convertToolsToGemini(options.tools);

        const abortController = new AbortController();
        const cancelSub = token.onCancellationRequested(() => abortController.abort());

        const modelId = modelConfig.model || modelConfig.id;

        // Override User-Agent to use dynamic version (instead of potentially hardcoded value in customHeader)
        const dynamicUserAgent = this.buildCodeAssistUserAgent(modelId);
        const headersWithDynamicUA = { ...processedHeaders, 'User-Agent': dynamicUserAgent };
        const normalizedBaseUrl = this.normalizeBaseUrl(baseUrl);
        if (!normalizedBaseUrl) {
            throw new Error('Gemini mode requires baseUrl to be specified in modelInfo');
        }

        let generationConfig: GeminiGenerationConfig = {
            maxOutputTokens: ConfigManager.getMaxTokensForModel(model.maxOutputTokens)
        };

        // extraBody: no longer merged to top level of request body, but merged into generationConfig.
        // Merge strategy: if value is an object, perform object merge override (instead of directly replacing object).
        if (modelConfig.extraBody) {
            const overrides = this.extractGenerationConfigOverrides(modelConfig.extraBody);
            generationConfig = this.deepMergePlainObjects(
                generationConfig as Record<string, unknown>,
                overrides
            ) as GeminiGenerationConfig;
        }

        // Use statefulMarker to get session state
        const markerAndIndex = getStatefulMarkerAndIndex(model.id, 'gemini', messages);
        const statefulMarker = markerAndIndex?.statefulMarker;
        const sessionId = statefulMarker?.sessionId || crypto.randomUUID();
        Logger.debug(`🎯 ${model.name} Using session_id: ${sessionId}`);

        // Purpose: Assemble request body (Gemini v1beta / Code Assist v1internal both reuse contents + generationConfig).
        const baseRequest: GeminiGenerateContentRequest = {
            contents,
            ...(systemInstruction ? { systemInstruction: { role: 'user', parts: [{ text: systemInstruction }] } } : {}),
            ...(tools.length > 0 ? { tools } : {}),
            generationConfig,
            session_id: sessionId
        };

        // Code Assist expects wrapped format: { model, project, user_prompt_id, request: { ... } }
        // Keep Gemini v1beta as direct request body.
        let requestBody: unknown = baseRequest;
        if (this.isCodeAssistBaseUrl(normalizedBaseUrl)) {
            const projectId = await this.discoverCodeAssistProjectId(modelConfig, apiKey, modelId, normalizedBaseUrl);
            const userPromptId = crypto.randomUUID();
            requestBody = {
                model: modelId,
                ...(projectId ? { project: projectId } : {}),
                user_prompt_id: userPromptId,
                request: baseRequest
            };
        }

        Logger.info(`🚀 ${model.name} Sending ${this.displayName} Gemini HTTP request (model=${modelId})`);

        try {
            // Purpose: Build streaming SSE endpoint usable by third-party Gemini gateways.
            const endpoint = this.buildEndpoint(normalizedBaseUrl, modelId, true);
            if (!endpoint) {
                throw new Error('Unable to build Gemini request URL (please check baseUrl / model configuration)');
            }

            // Create unified stream reporter
            const reporter = new StreamReporter({
                modelName: model.name,
                modelId: model.id,
                provider: this.provider,
                sdkMode: 'gemini',
                progress,
                sessionId
            });

            // Purpose: Execute fetch request
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                    ...headersWithDynamicUA
                },
                body: JSON.stringify(requestBody),
                signal: abortController.signal
            });

            // Purpose: For non-2xx, directly extract readable error message and throw.
            if (!response.ok) {
                const text = await response.text();
                const message = this.extractErrorMessage(text || '', response.status, response.statusText);
                throw new Error(message);
            }

            // Purpose: SSE/line-stream response must have response.body.
            if (!response.body) {
                throw new Error('Response body is empty');
            }

            // Purpose: Handle streaming response
            await this.processStream(response.body, reporter, requestId || '', token);

            Logger.debug(`✅ ${model.name} ${this.displayName} Gemini HTTP request completed`);
        } catch (error) {
            if (
                token.isCancellationRequested ||
                error instanceof vscode.CancellationError ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                Logger.warn(`[${model.name}] User cancelled the request`);
                throw new vscode.CancellationError();
            }

            Logger.error(`[${model.name}] Gemini HTTP error:`, error);

            if (requestId) {
                try {
                    const usagesManager = TokenUsagesManager.instance;
                    await usagesManager.updateActualTokens({ requestId, status: 'failed' });
                } catch (err) {
                    Logger.warn('Failed to update Token statistics:', err);
                }
            }

            throw error;
        } finally {
            cancelSub.dispose();
        }
    }

    /**
     * Handle Gemini HTTP streaming response, parse SSE/line-stream incremental output.
     *
     * Output content includes:
     * - Text: LanguageModelTextPart
     * - Thinking: LanguageModelThinkingPart
     * - Tool calls: LanguageModelToolCallPart
     * - Usage: Pass through usageMetadata as-is for subsequent statistics parsing
     */
    private async processStream(
        body: ReadableStream<Uint8Array>,
        reporter: StreamReporter,
        requestId: string,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Purpose: Read Web ReadableStream, decode chunk by chunk and split by line.
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // Token statistics: Collect usage information
        let finalUsage: RawUsageData | undefined;
        // Record stream processing start time (recorded when first data is received)
        let streamStartTime: number | undefined = undefined;

        // Purpose: Process one line of SSE/line-stream.
        // Key compatibility points:
        // - Standard SSE: `data: {json}` or `data: [DONE]`
        // - SSE-like/gateway implementations: may output JSON lines directly (without data:)
        // - Here parsing by "line", so if gateway splits JSON into multiple lines, may still need subsequent enhancement (currently following existing compatibility strategy).
        const processRawLine = (rawLine: string): void => {
            const line = rawLine.trim();
            if (!line) {
                return;
            }

            // Parse SSE `data:` prefix (if not present, treat as pure JSON line).
            const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
            if (!payload) {
                return;
            }
            if (payload === '[DONE]') {
                return;
            }

            // Key note: Gateway may interleave non-JSON lines/heartbeats, parsing failure is directly ignored.
            const chunk = this.safeJsonParse(payload);
            if (!chunk) {
                return;
            }

            // Record the time of first receipt of valid data
            if (streamStartTime === undefined) {
                streamStartTime = Date.now();
            }

            // Compatible with Code Assist wrapping: may be { response: GenerateContentResponse }.
            const wrapped = chunk as { response?: unknown; error?: { message?: string } };
            const inner = wrapped && typeof wrapped === 'object' && wrapped.response ? wrapped.response : chunk;

            const event = inner as GeminiGenerateContentResponse;

            // Check if error exists, if so serialize entire error object
            const errorObj = event?.error || wrapped?.error;
            if (errorObj) {
                const errorMsg = typeof errorObj === 'object' ? JSON.stringify(errorObj, null, 2) : String(errorObj);
                throw new Error(errorMsg);
            }

            // Purpose: Convert Gemini incremental chunk to VS Code's incremental response parts (text/thinking/tool).
            const eventUsage = this.processGeminiEvent(event, reporter);
            if (eventUsage) {
                finalUsage = eventUsage;
            }
        };

        try {
            while (true) {
                if (token.isCancellationRequested) {
                    break;
                }
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                buffer += decoder.decode(value, { stream: true });

                // Split by \n: process complete lines, keep trailing fragment for next chunk round.
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const rawLine of lines) {
                    processRawLine(rawLine);
                }
            }

            if (buffer.trim()) {
                processRawLine(buffer);
            }
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                Logger.warn(`[${reporter.getModelName()}] User cancelled the request`);
                throw new vscode.CancellationError();
            }
            throw error;
        } finally {
            reader.releaseLock();
        }

        // Record stream end time
        const streamEndTime = Date.now();

        // Stream ended, output all remaining content
        reporter.flushAll(null, {
            sessionId: reporter.getSessionId(),
            responseId: reporter.getResponseId() as string
        });

        // Token statistics: Update actual tokens
        if (finalUsage) {
            try {
                const usagesManager = TokenUsagesManager.instance;
                await usagesManager.updateActualTokens({
                    requestId,
                    rawUsage: finalUsage,
                    status: 'completed',
                    streamStartTime,
                    streamEndTime
                });
            } catch (err) {
                Logger.warn('Failed to update token statistics:', err);
            }
        }
    }

    /**
     * Process single Gemini stream event (one JSON chunk).
     *
     * Parsing flow:
     * 1) candidates[0].content.parts[]: Output text / thinking / functionCall by part type.
     * 2) thoughtSignature: Used to associate "thinking segment" with subsequent tool call (VS Code thinking signature).
     * 3) usageMetadata: Pass through to usage logger as-is.
     * 4) responseId: Extract and set to reporter, used for session tracking.
     *
     * @returns usage data (if exists)
     */
    private processGeminiEvent(
        event: GeminiGenerateContentResponse,
        reporter: StreamReporter
    ): RawUsageData | undefined {
        if (event.responseId && typeof event.responseId === 'string') {
            reporter.setResponseId(event.responseId);
        }

        // Key note: Streaming scenarios usually only care about first candidate, other candidates (if any) are not output for now.
        const candidates = Array.isArray(event.candidates) ? event.candidates : [];
        const cand = candidates.length > 0 ? candidates[0] : undefined;
        const parts = Array.isArray(cand?.content?.parts) ? (cand?.content?.parts as GeminiPart[]) : [];

        for (const part of parts) {
            // Parse thoughtSignature: Used to associate "thinking about to be output" with subsequent tool call.
            const sig =
                (typeof part.thoughtSignature === 'string' && part.thoughtSignature ? part.thoughtSignature : '') ||
                (typeof part.thought_signature === 'string' && part.thought_signature ? part.thought_signature : '');
            if (sig) {
                reporter.setThoughtSignature(sig);
            }

            // Parse thinking: Output to UI.
            if (part.thought === true && typeof part.text === 'string' && part.text) {
                reporter.bufferThinking(part.text);
                // Each thought part in Gemini is an independent thinking block, end immediately after processing
                reporter.flushThinking('Gemini thought part completed');
                reporter.endThinkingChain();
                continue;
            }

            // Parse normal text: Output incrementally directly.
            if (typeof part.text === 'string' && part.text) {
                reporter.reportText(part.text);
                continue;
            }

            // Parse tool calls: Gemini returns complete tool call, output directly
            if (part.functionCall && typeof part.functionCall.name === 'string' && part.functionCall.name) {
                // Use UUID to generate unique ID, avoid duplication in parallel calls
                const callId = crypto.randomUUID();
                const args =
                    part.functionCall.args && typeof part.functionCall.args === 'object'
                        ? (part.functionCall.args as Record<string, unknown>)
                        : {};
                // Gemini directly outputs ToolCallPart, no accumulation needed
                reporter.reportToolCall(callId, part.functionCall.name, args);
                continue;
            }
        }

        if (event.usageMetadata) {
            // Purpose: Record usage as-is.
            // Key note: Usage fields returned by different Gemini gateways may not be completely consistent, preserving as-is facilitates subsequent statistics parsing/debugging.
            return event.usageMetadata as GenericUsageData;
        }

        return undefined;
    }

    /**
     * Safe JSON parsing: return null on parsing failure (used to ignore heartbeats/noise lines).
     */
    private safeJsonParse(text: string): unknown | null {
        try {
            return JSON.parse(text);
        } catch {
            return null;
        }
    }

    private extractErrorMessage(bodyText: string, status: number, statusText: string): string {
        let msg = `API request failed: ${status} ${statusText}`;
        const parsed = this.safeJsonParse(bodyText);
        let isExtracted = false;
        if (parsed && typeof parsed === 'object' && 'error' in parsed) {
            const err = (parsed as { error?: unknown }).error;
            if (err && typeof err === 'object' && 'message' in err) {
                const m = (err as { message?: unknown }).message;
                if (typeof m === 'string' && m.trim()) {
                    msg = m;
                    isExtracted = true;
                }
            }
        }
        if (parsed && typeof parsed === 'object' && 'detail' in parsed && !isExtracted) {
            const detail = (parsed as { detail?: unknown }).detail;
            if (typeof detail === 'string' && detail.trim()) {
                msg = detail;
                isExtracted = true;
            }
        }
        if (!isExtracted && bodyText.trim()) {
            msg = `${msg} - ${bodyText}`;
        }
        return msg;
    }
}
