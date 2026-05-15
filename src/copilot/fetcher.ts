/*---------------------------------------------------------------------------------------------
 *  Copilot Fetcher - HTTP Request Handling
 *  Implements IFetcher interface for API request handling
 *--------------------------------------------------------------------------------------------*/

import { VersionManager } from '../utils/versionManager';
import type { NESCompletionConfig } from '../utils/configManager';
import {
    FetchOptions,
    PaginationOptions,
    IAbortController,
    IHeaders,
    Response
} from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/fetcherService';
import { IFetcher } from '@vscode/chat-lib/dist/src/_internal/platform/networking/common/networking';
import { StatusBarManager } from '../status';
import { configProviders } from '../providers/config';
import { getCompletionLogger, getApiKeyManager, getConfigManager } from './singletons';

// ============================================================================
// Fetcher - Implements IFetcher Interface
// Reference: TestFetcher in nesProvider.spec.ts
// ============================================================================

/**
 * Custom Fetcher Implementation
 */
export class Fetcher implements IFetcher {
    getUserAgentLibrary(): string {
        return 'Fetcher';
    }

    isNetworkProcessCrashedError(_err: unknown): boolean {
        return false;
    }

    async fetch(url: string, options: FetchOptions): Promise<Response> {
        // Priority from singleton instance in globalThis (ensure cross-bundle singleton)
        const logger = getCompletionLogger();
        const keyManager = getApiKeyManager();

        if (options?.method === 'GET' && url.endsWith('/models')) {
            // Return a response with empty model list
            const emptyModelsResponse = '{"object":"list","data":[]}';
            // Create headers object conforming to IHeaders interface
            const headers: IHeaders = {
                get: (name: string) => {
                    if (name.toLowerCase() === 'content-type') {
                        return 'application/json';
                    }
                    return null;
                },
                [Symbol.iterator]: function* () {
                    yield ['content-type', 'application/json'];
                }
            };
            return Response.fromText(200, 'OK', headers, emptyModelsResponse, 'node-http');
        }

        if (options?.method !== 'POST' || url.endsWith('/completions') === false) {
            throw new Error('Not Support Request');
        }

        let isFimRequest = false; // FIM /completions (not /chat/completions)
        let dashscopeStopChunk = false; // Only capture chunks until stop, Aliyun Bailian completion API

        let fimSseBuffer = '';
        const fimDecoder = new TextDecoder();

        const requestBody: Record<string, unknown> = {}; // as OpenAI.Chat.ChatCompletionCreateParamsStreaming;
        if (options.json) {
            Object.assign(requestBody, options.json);
        } else if (options.body) {
            try {
                Object.assign(requestBody, JSON.parse(options.body));
            } catch (error) {
                throw new Error('Failed to parse request body', { cause: error });
            }
        }

        const ConfigManager = getConfigManager();
        let modelConfig: NESCompletionConfig['modelConfig'];
        if (url.endsWith('/chat/completions')) {
            modelConfig = ConfigManager.getNESConfig().modelConfig;
            if (!modelConfig || !modelConfig.baseUrl) {
                logger.error('[Fetcher] NES model configuration missing');
                throw new Error('NES model configuration is missing');
            }
            url = `${modelConfig.baseUrl}/chat/completions`;
        } else if (url.endsWith('/completions')) {
            modelConfig = ConfigManager.getFIMConfig().modelConfig;
            if (!modelConfig || !modelConfig.baseUrl) {
                logger.error('[Fetcher] FIM model configuration missing');
                throw new Error('FIM model configuration is missing');
            }
            isFimRequest = true;
            url = `${modelConfig.baseUrl}/completions`;
            if (modelConfig.provider === 'dashscope') {
                const { prompt, suffix } = requestBody;
                if (prompt && suffix) {
                    dashscopeStopChunk = true;
                    delete requestBody.suffix;
                    requestBody.prompt = `${prompt}${suffix}`;
                }
            }
        } else {
            throw new Error('Not Support Request URL');
        }

        const { provider, model, maxTokens, extraBody } = modelConfig;

        try {
            const apiKey = await keyManager.getApiKey(provider);
            if (!apiKey) {
                logger.error(`[Fetcher] ${provider} API key not configured`);
                throw new Error('API key not configured');
            }

            const requestHeaders: Record<string, string> = {
                ...(options.headers || {}),
                'Content-Type': 'application/json',
                'User-Agent': VersionManager.getUserAgent(provider),
                Authorization: `Bearer ${apiKey}`
            };

            if (extraBody) {
                for (const key in extraBody) {
                    const value = extraBody[key];
                    if (value) {
                        requestBody[key] = value;
                    } else {
                        delete requestBody[key];
                    }
                }
            }
            // if (Array.isArray(requestBody.messages)) {
            //     const messages = requestBody.messages;
            //     const promptAddition =
            //         '\n IMPORTANT: Do NOT use markdown code blocks (```). Output ONLY the raw code. Do not explain.';
            //     // Try adding to system message
            //     const systemMessage = messages.find(m => m.role === 'system');
            //     if (systemMessage) {
            //         systemMessage.content = (systemMessage.content || '') + promptAddition;
            //     }
            //     CompletionLogger.trace('[Fetcher] Injected Prompt directive to prohibit Markdown');
            // }

            const fetchOptions: RequestInit = {
                method: 'POST',
                headers: requestHeaders,
                body: JSON.stringify({
                    ...requestBody,
                    model,
                    max_tokens: maxTokens
                }),
                signal: options.signal as AbortSignal | undefined
            };

            logger.info(`[Fetcher] Sending request: ${url}`);
            const response = await fetch(url, fetchOptions);
            logger.debug(`[Fetcher] Received response - Status: ${response.status} ${response.statusText}`);

            // Get Web ReadableStream from fetch response
            if (!response.body) {
                throw new Error('Response body is null');
            }

            // Convert Web ReadableStream to Web ReadableStream<Uint8Array>
            const reader = response.body.getReader();
            const encoder = new TextEncoder();
            const enqueueFimLine = (controller: ReadableStreamDefaultController<Uint8Array>, rawLine: string): void => {
                const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
                if (line.trim() === '') {
                    return;
                }

                if (!line.startsWith('data: ')) {
                    controller.enqueue(encoder.encode(`${line}\n`));
                    return;
                }

                const data = line.slice(6);
                if (data === '[DONE]') {
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    return;
                }

                try {
                    const parsed = JSON.parse(data) as Record<string, unknown>;
                    const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
                    const choice = choices?.[0];

                    if (dashscopeStopChunk && choice?.finish_reason !== 'stop') {
                        controller.enqueue(encoder.encode('\n\n'));
                        return;
                    }

                    // Convert delta.content to text (some FIM APIs return chat completion chunk format)
                    if (choice && 'delta' in choice) {
                        const delta = choice.delta as Record<string, unknown> | undefined;
                        if (delta && 'content' in delta) {
                            const newChoice: Record<string, unknown> = { ...choice };
                            delete newChoice.delta;
                            newChoice.text = delta.content;
                            const converted = { ...parsed, choices: [newChoice] };
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify(converted)}\n`));
                            return;
                        }
                    }

                    controller.enqueue(encoder.encode(`${line}\n`));
                } catch {
                    controller.enqueue(encoder.encode(`${line}\n`));
                }
            };
            const bodyStream = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    try {
                        const { done, value } = await reader.read();
                        if (done) {
                            if (isFimRequest) {
                                fimSseBuffer += fimDecoder.decode();
                                if (fimSseBuffer.trim() !== '') {
                                    enqueueFimLine(controller, fimSseBuffer);
                                    fimSseBuffer = '';
                                }
                            }
                            controller.close();
                            return;
                        }

                        if (isFimRequest) {
                            const chunk = fimSseBuffer + fimDecoder.decode(value, { stream: true });
                            const lines = chunk.split('\n');
                            fimSseBuffer = lines.pop() ?? '';

                            for (const line of lines) {
                                enqueueFimLine(controller, line);
                            }
                        } else {
                            controller.enqueue(new Uint8Array(value));
                        }
                    } catch (error) {
                        controller.error(error);
                    }
                },
                cancel() {
                    reader.cancel();
                }
            });

            return new Response(
                response.status,
                response.statusText,
                response.headers as unknown as IHeaders,
                bodyStream,
                'node-http',
                () => { },
                '',
                ''
            );
        } catch (error) {
            // If request aborted, do not log error
            if (!this.isAbortError(error)) {
                logger.error('[Fetcher] Exception:', error);
            }
            throw error;
        } finally {
            if (Object.keys(configProviders).includes(provider)) {
                StatusBarManager.getStatusBar(provider)?.delayedUpdate(200);
            } else {
                StatusBarManager.compatible?.delayedUpdate(provider, 200);
            }
        }
    }

    fetchWithPagination<T>(_baseUrl: string, _options: PaginationOptions<T>): Promise<T[]> {
        throw new Error('Method not implemented.');
    }

    async disconnectAll(): Promise<unknown> {
        return Promise.resolve();
    }

    makeAbortController(): IAbortController {
        return new AbortController() as IAbortController;
    }

    isAbortError(e: unknown): boolean {
        return !!e && typeof e === 'object' && 'name' in e && (e as { name: string }).name === 'AbortError';
    }

    isInternetDisconnectedError(_e: unknown): boolean {
        return false;
    }

    isFetcherError(_e: unknown): boolean {
        return false;
    }

    getUserMessageForFetcherError(err: unknown): string {
        const message = err instanceof Error ? err.message : String(err);
        return `Fetcher error: ${message}`;
    }
}
