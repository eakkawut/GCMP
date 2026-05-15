/*---------------------------------------------------------------------------------------------
 *  JSON Schema Provider
 *  Dynamically generates JSON Schema for CCMP configuration to provide intelligent suggestions for settings.json
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderConfig } from '../types/sharedTypes';
import { ConfigManager } from './configManager';
import { Logger } from './logger';
import type { JSONSchema7 } from 'json-schema';
import { KnownProviders } from './knownProviders';
import { CompatibleModelManager } from './compatibleModelManager';

/**
 * Extended JSON Schema interface supporting VS Code-specific enumDescriptions property
 */
declare module 'json-schema' {
    interface JSONSchema7 {
        enumDescriptions?: string[];
        deprecationMessage?: string;
        errorMessage?: string;
    }
}

/**
 * JSON Schema Provider class
 * Dynamically generates JSON Schema for CCMP configuration to provide intelligent suggestions for settings.json
 */
export class JsonSchemaProvider {
    private static readonly SCHEMA_URI = 'ccmp-settings://root/schema.json';
    private static readonly SCHEMA_VSCODE_URI = vscode.Uri.parse(JsonSchemaProvider.SCHEMA_URI);
    private static fsProviderDisposable: vscode.Disposable | null = null;
    private static onDidChangeFileEmitter: vscode.EventEmitter<vscode.FileChangeEvent[]> | null = null;
    private static eventDisposables: vscode.Disposable[] = [];

    // File metadata only used for FileSystemProvider.stat: avoid Date.now() jitter on every stat
    private static schemaCtime = Date.now();
    private static schemaMtime = Date.now();

    private static isSchemaUri(uri: vscode.Uri): boolean {
        return uri.scheme === 'ccmp-settings' && uri.authority === 'root' && uri.path === '/schema.json';
    }
    private static throwReadOnly(): never {
        throw vscode.FileSystemError.NoPermissions('ccmp-settings is read-only');
    }

    /**
     * Initialize JSON Schema Provider
     */
    static initialize(): void {
        if (this.fsProviderDisposable) {
            this.fsProviderDisposable.dispose();
        }

        this.schemaCtime = Date.now();
        this.schemaMtime = Date.now();

        // Clean up previously registered event listeners
        this.eventDisposables.forEach(d => d.dispose());
        this.eventDisposables = [];

        // Rebuild file change notification emitter
        if (this.onDidChangeFileEmitter) {
            this.onDidChangeFileEmitter.dispose();
        }
        this.onDidChangeFileEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();

        // Register read-only file system provider: let JSON language service get schema via "file read"
        const provider: vscode.FileSystemProvider = {
            onDidChangeFile: this.onDidChangeFileEmitter.event,
            watch: () => new vscode.Disposable(() => undefined),
            stat: (uri: vscode.Uri) => {
                if (!this.isSchemaUri(uri)) {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
                return {
                    type: vscode.FileType.File,
                    ctime: this.schemaCtime,
                    mtime: this.schemaMtime,
                    // Schema is actually dynamic content; give a non-zero size here to avoid being mistaken for an empty file
                    size: 1
                };
            },
            readDirectory: (uri: vscode.Uri) => {
                // Only support root directory
                if (
                    uri.scheme !== 'ccmp-settings' ||
                    uri.authority !== 'root' ||
                    (uri.path !== '/' && uri.path !== '')
                ) {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
                return [['schema.json', vscode.FileType.File]];
            },
            createDirectory: () => this.throwReadOnly(),
            readFile: (uri: vscode.Uri) => {
                if (!this.isSchemaUri(uri)) {
                    throw vscode.FileSystemError.FileNotFound(uri);
                }
                const schema = this.getSettingsSchema();
                const text = JSON.stringify(schema, null, 2);
                return Buffer.from(text, 'utf8');
            },
            writeFile: () => this.throwReadOnly(),
            delete: () => this.throwReadOnly(),
            rename: () => this.throwReadOnly()
        };

        this.fsProviderDisposable = vscode.workspace.registerFileSystemProvider('ccmp-settings', provider, {
            isReadonly: true,
            isCaseSensitive: true
        });

        // Listen for configuration changes and update schema promptly
        this.eventDisposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('ccmp')) {
                    this.invalidateCache();
                }
            })
        );

        Logger.debug('Dynamic JSON Schema Provider initialized');
    }

    /**
     * Invalidate cache and trigger schema update
     */
    private static invalidateCache(): void {
        this.updateSchema();
    }

    /**
     * Update Schema
     */
    private static updateSchema(): void {
        try {
            // Configuration changes are rare events: directly notify VS Code to re-fetch schema content
            this.schemaMtime = Date.now();
            this.onDidChangeFileEmitter?.fire([
                {
                    type: vscode.FileChangeType.Changed,
                    uri: this.SCHEMA_VSCODE_URI
                }
            ]);
            Logger.info('JSON Schema updated');
        } catch (error) {
            Logger.error('Failed to update JSON Schema:', error);
        }
    }

    /**
     * Get base JSON Schema for family field
     * Used for family field definition in model configuration
     */
    private static getFamilySchema(): JSONSchema7 {
        return {
            type: 'string',
            description: [
                'Model family identifier used to determine editing tool mode.',
                'If not set, default value will be automatically inferred from sdkMode:',
                '- anthropic → claude-sonnet-4.6',
                '- openai/openai-sse/openai-responses → claude-sonnet-4.6',
                '- gemini-sse → gemini-3-pro'
            ].join('\n'),
            enum: ['claude-sonnet-4.6', 'gpt-5.2', 'gemini-3-pro'],
            enumDescriptions: [
                'Claude-style editing tool (replace_string_in_file) - efficient and precise single replacement, supports multi-file replacement',
                'GPT-5-style editing tool (apply_patch) - batch diff application, supports complex refactoring',
                'Gemini-style editing tool (replace_string_in_file) - efficient and precise single replacement'
            ]
        };
    }

    /**
     * Get complete JSON Schema for CCMP configuration
     * Provide intelligent suggestions and validation for settings.json
     */
    static getSettingsSchema(): JSONSchema7 {
        const providerConfigs = ConfigManager.getConfigProvider();
        const patternProperties: Record<string, JSONSchema7> = {};
        const propertyNames: JSONSchema7 = {
            type: 'string',
            description: 'Provider configuration key name',
            enum: Object.keys(providerConfigs),
            enumDescriptions: Object.entries(providerConfigs).map(([key, config]) => config.displayName || key)
        };

        // Generate schema for each provider
        for (const [providerKey, config] of Object.entries(providerConfigs)) {
            patternProperties[`^${providerKey}$`] = this.createProviderSchema(providerKey, config);
        }

        // Get all available provider IDs (used for other configuration items, e.g., fim/nes/compatibleModels.provider)
        const { providerIds, enumDescriptions: allProviderDescriptions } = this.getAllAvailableProviders();

        // Commit model selection: provider is the vendor of VS Code Language Model API (provider ID registered with VS Code)
        const commitSchema = this.getCommitModelSchema();

        return {
            $schema: 'http://json-schema.org/draft-07/schema#',
            $id: this.SCHEMA_URI,
            title: 'CCMP Configuration Schema',
            description: 'Schema for CCMP configuration with dynamic model ID suggestions',
            type: 'object',
            properties: {
                'ccmp.retry.maxAttempts': {
                    type: 'number',
                    description: 'Maximum number of automatic retry attempts after request failure, only effective for retryable errors. Default 3, maximum 5.',
                    default: 3,
                    minimum: 1,
                    maximum: 5
                },
                'ccmp.providerOverrides': {
                    type: 'object',
                    description:
                        'Provider configuration override. Allows overriding provider baseUrl and model configuration, supports adding new models or overriding existing model parameters.',
                    patternProperties,
                    propertyNames
                },
                'ccmp.fimCompletion.modelConfig': {
                    type: 'object',
                    description: 'FIM (Fill-in-the-Middle) completion mode configuration',
                    properties: {
                        provider: {
                            type: 'string',
                            description: 'Provider ID used for FIM completion',
                            enum: providerIds,
                            enumDescriptions: allProviderDescriptions
                        }
                    },
                    additionalProperties: true
                },
                'ccmp.nesCompletion.modelConfig': {
                    type: 'object',
                    description: 'NES (Next Edit Suggestion) completion mode configuration',
                    properties: {
                        provider: {
                            type: 'string',
                            description: 'Provider ID used for NES completion',
                            enum: providerIds,
                            enumDescriptions: allProviderDescriptions
                        }
                    },
                    additionalProperties: true
                },
                'ccmp.compatibleModels': {
                    type: 'array',
                    description: 'Custom model configuration for Compatible Provider.',
                    default: [],
                    items: {
                        type: 'object',
                        properties: {
                            id: {
                                type: 'string',
                                description: 'Model ID',
                                minLength: 1
                            },
                            name: {
                                type: 'string',
                                description: 'Model display name',
                                minLength: 1
                            },
                            tooltip: {
                                type: 'string',
                                description: 'Model description'
                            },
                            provider: {
                                description:
                                    'Model provider identifier. Select an existing provider ID from the dropdown, or enter a new ID to create a custom provider.',
                                allOf: [
                                    {
                                        anyOf: [
                                            {
                                                type: 'string',
                                                enum: providerIds,
                                                description: 'Select an existing provider ID'
                                            },
                                            {
                                                type: 'string',
                                                minLength: 3,
                                                maxLength: 100,
                                                pattern: '^[a-zA-Z0-9_-]+$',
                                                description: 'Add new custom provider ID (allows letters, numbers, underscores, hyphens)'
                                            }
                                        ]
                                    },
                                    {
                                        not: {
                                            anyOf: [{ const: 'codex' }, { const: 'gemini' }]
                                        },
                                        errorMessage: '"codex" and "gemini" are CLI-specialized providers and cannot be used in custom models'
                                    }
                                ]
                            },
                            sdkMode: {
                                type: 'string',
                                enum: ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'],
                                enumDescriptions: [
                                    'OpenAI SDK standard mode, using official OpenAI SDK for request-response handling',
                                    'OpenAI SSE compatible mode, using plugin-implemented SSE parsing logic for streaming response handling',
                                    'OpenAI Responses API mode, using Responses API for request-response handling',
                                    'Anthropic SDK standard mode, using official Anthropic SDK for request-response handling',
                                    'Gemini HTTP SSE mode (experimental), using pure HTTP + SSE parsing, compatible with third-party Gemini gateways'
                                ],
                                description: 'SDK mode defaults to openai.',
                                default: 'openai'
                            },
                            baseUrl: {
                                type: 'string',
                                description: 'API base URL',
                                format: 'uri'
                            },
                            model: {
                                type: 'string',
                                description: 'Model name used for API requests (optional, defaults to model ID)'
                            },
                            maxInputTokens: {
                                type: 'number',
                                description: 'Maximum input token count',
                                minimum: 128
                            },
                            maxOutputTokens: {
                                type: 'number',
                                description: 'Maximum output token count',
                                minimum: 8
                            },
                            useInstructions: {
                                type: 'boolean',
                                description:
                                    'Whether to use instructions parameter in Responses API (optional)\n- false: Pass system messages via user messages (default)\n- true: Pass system messages via instructions parameter',
                                default: false
                            },
                            webSearchTool: {
                                type: 'boolean',
                                description: 'Whether to enable Anthropic native web_search tool (only effective when sdkMode=anthropic)',
                                default: false
                            },
                            family: this.getFamilySchema(),
                            thinking: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                    enum: ['disabled', 'enabled', 'auto', 'adaptive'],
                                    enumDescriptions: [
                                        'Force disable deep thinking, model will not output chain of thought',
                                        'Force enable deep thinking, model will be forced to output chain of thought',
                                        'Model decides whether deep thinking is needed',
                                        'Model adaptively adjusts deep thinking mode based on context'
                                    ]
                                },
                                description: 'Deep thinking configuration, controls whether model outputs chain of thought'
                            },
                            thinkingFormat: {
                                type: 'string',
                                enum: ['boolean', 'object'],
                                enumDescriptions: [
                                    'Use boolean format: { enable_thinking: true/false }',
                                    "Use object format: { thinking: { type: 'enabled' | 'disabled' } }"
                                ],
                                default: 'boolean',
                                description:
                                    'Passing format for thinking mode parameters, for compatibility with different model API format requirements (only effective in openai/openai-sse mode)'
                            },
                            reasoningEffort: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                    enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
                                    enumDescriptions: [
                                        'Disable thinking, direct answer',
                                        'Disable thinking, direct answer',
                                        'Lightweight thinking, focus on fast response',
                                        'Balanced mode, balance speed and depth',
                                        'Deep analysis, handle complex problems',
                                        'Maximum reasoning depth, slower speed',
                                        'Absolute highest capability, no limit on token consumption'
                                    ]
                                },
                                description: 'Adjust chain of thought length, balance effects, latency, and cost requirements across different scenarios'
                            },
                            capabilities: {
                                type: 'object',
                                properties: {
                                    toolCalling: {
                                        type: 'boolean',
                                        description: 'Whether tool calls are supported'
                                    },
                                    imageInput: {
                                        type: 'boolean',
                                        description: 'Whether image input is supported'
                                    }
                                },
                                required: ['toolCalling', 'imageInput']
                            },
                            customHeader: {
                                type: 'object',
                                description: 'Custom HTTP header configuration, supports ${APIKEY} placeholder replacement',
                                additionalProperties: {
                                    type: 'string',
                                    description: 'HTTP header value'
                                }
                            },
                            extraBody: {
                                type: 'object',
                                description: 'Additional request body parameters, will be merged into request body in API requests',
                                additionalProperties: {
                                    description: 'Additional request body parameter value'
                                }
                            },
                            includeThinking: {
                                type: 'boolean',
                                description: 'Whether to include thinking content (deprecated, this parameter has been removed)',
                                deprecationMessage: 'includeThinking is deprecated, this parameter is no longer supported'
                            },
                            outputThinking: {
                                type: 'boolean',
                                description: 'Whether to output thinking content (deprecated, this parameter has been removed)',
                                deprecationMessage: 'outputThinking is deprecated, this parameter is no longer supported'
                            }
                        },
                        required: ['id', 'name', 'provider', 'maxInputTokens', 'maxOutputTokens', 'capabilities'],
                        allOf: [
                            {
                                // endpoint is only effective for openai / openai-sse / openai-responses
                                // anthropic and gemini-sse do not prompt, and show red warning when configured
                                if: {
                                    anyOf: [
                                        { not: { required: ['sdkMode'] } },
                                        {
                                            properties: {
                                                sdkMode: { enum: ['openai', 'openai-sse', 'openai-responses'] }
                                            },
                                            required: ['sdkMode']
                                        }
                                    ]
                                },
                                then: {
                                    properties: {
                                        endpoint: {
                                            type: 'string',
                                            description: [
                                                'Custom API endpoint path (optional).',
                                                'Used to replace the path default appended to baseUrl (e.g., /chat/completions, /responses).',
                                                '- Relative path (e.g., /custom/path): concatenated with baseUrl',
                                                '- Full URL: enter the complete address directly as the request URL',
                                                'Only effective for openai, openai-sse, openai-responses modes'
                                            ].join('\n')
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        endpoint: {
                                            deprecationMessage:
                                                'endpoint is only effective for openai, openai-sse, openai-responses modes'
                                        }
                                    }
                                }
                            },
                            {
                                // useInstructions is only effective for openai-responses
                                if: {
                                    properties: {
                                        sdkMode: { const: 'openai-responses' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        useInstructions: {
                                            type: 'boolean',
                                            description:
                                                'Whether to use instructions parameter in Responses API (optional)\n- false: Pass system messages via user messages (default)\n- true: Pass system messages via instructions parameter',
                                            default: false
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        useInstructions: {
                                            deprecationMessage: 'useInstructions is only effective for openai-responses mode'
                                        }
                                    }
                                }
                            },
                            {
                                // webSearchTool is only effective for anthropic
                                if: {
                                    properties: {
                                        sdkMode: { const: 'anthropic' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        webSearchTool: {
                                            type: 'boolean',
                                            description:
                                                'Whether to enable Anthropic native web_search tool. When enabled, web_search will be automatically exposed to the model.',
                                            default: false
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        webSearchTool: {
                                            deprecationMessage: 'webSearchTool is only effective for anthropic mode'
                                        }
                                    }
                                }
                            },
                            {
                                // thinkingFormat is only effective for openai/openai-sse
                                if: {
                                    anyOf: [
                                        { not: { required: ['sdkMode'] } },
                                        {
                                            properties: {
                                                sdkMode: { enum: ['openai', 'openai-sse'] }
                                            },
                                            required: ['sdkMode']
                                        }
                                    ]
                                },
                                then: {
                                    properties: {
                                        thinkingFormat: {
                                            type: 'string',
                                            enum: ['boolean', 'object'],
                                            enumDescriptions: [
                                                'Use boolean format: { enable_thinking: true/false }',
                                                "Use object format: { thinking: { type: 'enabled' | 'disabled' } }"
                                            ],
                                            default: 'boolean',
                                            description: 'Passing format for thinking mode parameters, for compatibility with different model API format requirements'
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        thinkingFormat: {
                                            deprecationMessage: 'thinkingFormat is only effective for openai and openai-sse modes'
                                        }
                                    }
                                }
                            },
                            {
                                // family conditional suggestion: recommend default value based on sdkMode
                                // anthropic mode recommends claude-sonnet-4.6
                                if: {
                                    properties: {
                                        sdkMode: { const: 'anthropic' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        family: {
                                            type: 'string',
                                            description: [
                                                'Model family identifier. Default for anthropic mode: claude-sonnet-4.6',
                                                'Claude-style editing tool (replace_string_in_file) - efficient and precise single replacement'
                                            ].join('\n'),
                                            default: 'claude-sonnet-4.6',
                                            enum: ['claude-sonnet-4.6', 'gpt-5.2', 'gemini-3-pro'],
                                            enumDescriptions: [
                                                'Claude-style editing tool (replace_string_in_file) - Recommended',
                                                'GPT-5-style editing tool (apply_patch)',
                                                'Gemini-style editing tool (replace_string_in_file)'
                                            ]
                                        }
                                    }
                                }
                            },
                            {
                                // gemini-sse mode recommends gemini-3-pro
                                if: {
                                    properties: {
                                        sdkMode: { const: 'gemini-sse' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        family: {
                                            type: 'string',
                                            description: [
                                                'Model family identifier. Default for gemini-sse mode: gemini-3-pro',
                                                'Gemini-style editing tool (replace_string_in_file) - efficient and precise single replacement'
                                            ].join('\n'),
                                            default: 'gemini-3-pro',
                                            enum: ['gemini-3-pro', 'claude-sonnet-4.6', 'gpt-5.2'],
                                            enumDescriptions: [
                                                'Gemini-style editing tool (replace_string_in_file) - Recommended',
                                                'Claude-style editing tool (replace_string_in_file)',
                                                'GPT-5-style editing tool (apply_patch)'
                                            ]
                                        }
                                    }
                                }
                            },
                            {
                                // openai/openai-sse/openai-responses mode (default)
                                if: {
                                    anyOf: [
                                        { not: { required: ['sdkMode'] } },
                                        {
                                            properties: {
                                                sdkMode: { enum: ['openai', 'openai-sse', 'openai-responses'] }
                                            },
                                            required: ['sdkMode']
                                        }
                                    ]
                                },
                                then: {
                                    properties: {
                                        family: {
                                            type: 'string',
                                            description: [
                                                'Model family identifier.',
                                                'Default for openai/openai-sse/openai-responses mode: claude-sonnet-4.6',
                                                'Claude-style editing tool (replace_string_in_file) - efficient and precise single replacement'
                                            ].join('\n'),
                                            enum: ['claude-sonnet-4.6', 'gpt-5.2', 'gemini-3-pro'],
                                            enumDescriptions: [
                                                'Claude-style editing tool (replace_string_in_file) - Recommended',
                                                'GPT-5-style editing tool (apply_patch) - batch diff application',
                                                'Gemini-style editing tool (replace_string_in_file)'
                                            ]
                                        }
                                    }
                                }
                            }
                        ]
                    }
                },
                // Commit model selection: save provider + model
                'ccmp.commit.model': commitSchema
            },
            additionalProperties: true
        };
    }

    /**
     * Create JSON Schema for specific provider
     */
    private static createProviderSchema(providerKey: string, config: ProviderConfig): JSONSchema7 {
        const modelIds = config.models?.map(model => model.id) || [];

        // Create id property schema, supports selecting existing model ID or entering custom ID
        const idProperty: JSONSchema7 = {
            anyOf: [
                {
                    type: 'string',
                    enum: modelIds,
                    description: 'Override existing model ID'
                },
                {
                    type: 'string',
                    minLength: 3,
                    maxLength: 100,
                    pattern: '^[a-zA-Z0-9._-]+$',
                    description: 'Add new custom model ID (allows letters, numbers, underscores, hyphens, and dots)'
                }
            ],
            description: 'Select an existing model ID from the dropdown, or enter a new ID to create custom configuration'
        };

        // Add regex validation for streamlake model field
        const modelProperty: JSONSchema7 = {
            type: 'string',
            minLength: 1,
            description: 'Model name or endpoint ID used for API requests'
        };
        if (providerKey === 'streamlake') {
            modelProperty.pattern = '^ep-[a-zA-Z0-9]{6}-\\d{19}$';
            modelProperty.description = 'Must match format ep-xxxxxx-xxxxxxxxxxxxxxxxxxx';
        }

        return {
            type: 'object',
            description: `${config.displayName || providerKey} configuration override`,
            properties: {
                baseUrl: {
                    type: 'string',
                    description: 'Override provider-level API base URL',
                    format: 'uri'
                },
                customHeader: {
                    type: 'object',
                    description: 'Provider-level custom HTTP headers, supports ${APIKEY} placeholder replacement',
                    additionalProperties: {
                        type: 'string',
                        description: 'HTTP header value'
                    }
                },
                models: {
                    type: 'array',
                    description: 'Model override configuration list',
                    minItems: 1,
                    items: {
                        type: 'object',
                        properties: {
                            id: idProperty,
                            model: modelProperty,
                            name: {
                                type: 'string',
                                minLength: 1,
                                description:
                                    'Friendly name displayed in model selector.\r\nValid for custom model IDs, does not override preset model names.'
                            },
                            tooltip: {
                                type: 'string',
                                minLength: 1,
                                description:
                                    'Detailed description shown as hover tooltip.\r\nValid for custom model IDs, does not override preset model descriptions.'
                            },
                            maxInputTokens: {
                                type: 'number',
                                minimum: 1,
                                maximum: 2000000,
                                description: 'Override maximum input token count'
                            },
                            maxOutputTokens: {
                                type: 'number',
                                minimum: 1,
                                maximum: 200000,
                                description: 'Override maximum output token count'
                            },
                            sdkMode: {
                                type: 'string',
                                enum: ['openai', 'openai-sse', 'openai-responses', 'anthropic', 'gemini-sse'],
                                enumDescriptions: [
                                    'OpenAI SDK standard mode',
                                    'OpenAI SSE compatible mode (custom streaming)',
                                    'OpenAI Responses API mode',
                                    'Anthropic SDK standard mode',
                                    'Gemini HTTP SSE mode (experimental)'
                                ],
                                description: 'Override SDK mode, defaults to openai'
                            },
                            baseUrl: {
                                type: 'string',
                                description: 'Override model-level API base URL',
                                format: 'uri'
                            },
                            capabilities: {
                                type: 'object',
                                description: 'Model capability configuration',
                                properties: {
                                    toolCalling: {
                                        type: 'boolean',
                                        description: 'Whether tool calls are supported'
                                    },
                                    imageInput: {
                                        type: 'boolean',
                                        description: 'Whether image input is supported'
                                    }
                                },
                                required: ['toolCalling', 'imageInput'],
                                additionalProperties: false
                            },
                            customHeader: {
                                type: 'object',
                                description: 'Model custom HTTP headers, supports ${APIKEY} placeholder replacement',
                                additionalProperties: {
                                    type: 'string',
                                    description: 'HTTP header value'
                                }
                            },
                            extraBody: {
                                type: 'object',
                                description: 'Additional request body parameters (optional)',
                                additionalProperties: {
                                    description: 'Additional request body parameter value'
                                }
                            },
                            useInstructions: {
                                type: 'boolean',
                                description:
                                    'Whether to use instructions parameter in Responses API (optional)\n- false: Pass system messages via user messages (default)\n- true: Pass system messages via instructions parameter',
                                default: false
                            },
                            webSearchTool: {
                                type: 'boolean',
                                description: 'Whether to enable Anthropic native web_search tool (only effective when sdkMode=anthropic)',
                                default: false
                            },
                            family: this.getFamilySchema(),
                            thinking: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                    enum: ['disabled', 'enabled', 'auto', 'adaptive'],
                                    enumDescriptions: [
                                        'Force disable deep thinking, model will not output chain of thought',
                                        'Force enable deep thinking, model will be forced to output chain of thought',
                                        'Model decides whether deep thinking is needed',
                                        'Model adaptively adjusts deep thinking mode based on context'
                                    ]
                                },
                                description: 'Deep thinking configuration, controls whether model outputs chain of thought'
                            },
                            thinkingFormat: {
                                type: 'string',
                                enum: ['boolean', 'object'],
                                enumDescriptions: [
                                    'Use boolean format: { enable_thinking: true/false }',
                                    "Use object format: { thinking: { type: 'enabled' | 'disabled' } }"
                                ],
                                default: 'boolean',
                                description:
                                    'Passing format for thinking mode parameters, for compatibility with different model API format requirements (only effective in openai/openai-sse mode)'
                            },
                            reasoningEffort: {
                                type: 'array',
                                items: {
                                    type: 'string',
                                    enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
                                    enumDescriptions: [
                                        'Disable thinking, direct answer',
                                        'Disable thinking, direct answer',
                                        'Lightweight thinking, focus on fast response',
                                        'Balanced mode, balance speed and depth',
                                        'Deep analysis, handle complex problems',
                                        'Maximum reasoning depth, slower speed',
                                        'Absolute highest capability, no limit on token consumption'
                                    ]
                                },
                                description: 'Adjust chain of thought length, balance effects, latency, and cost requirements across different scenarios'
                            },
                            includeThinking: {
                                type: 'boolean',
                                description: 'Whether to include thinking content (deprecated, this parameter has been removed)',
                                deprecationMessage: 'includeThinking is deprecated, this parameter is no longer supported'
                            },
                            outputThinking: {
                                type: 'boolean',
                                description: 'Whether to output thinking content (deprecated, this parameter has been removed)',
                                deprecationMessage: 'outputThinking is deprecated, this parameter is no longer supported'
                            }
                        },
                        required: ['id'],
                        allOf: [
                            {
                                if: {
                                    properties: {
                                        sdkMode: { const: 'anthropic' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        webSearchTool: {
                                            type: 'boolean',
                                            description:
                                                'Whether to enable Anthropic native web_search tool. When enabled, web_search will be automatically exposed to the model.',
                                            default: false
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        webSearchTool: {
                                            deprecationMessage: 'webSearchTool is only effective for anthropic mode'
                                        }
                                    }
                                }
                            },
                            {
                                if: {
                                    properties: {
                                        sdkMode: { const: 'openai-responses' }
                                    },
                                    required: ['sdkMode']
                                },
                                then: {
                                    properties: {
                                        useInstructions: {
                                            type: 'boolean',
                                            description:
                                                'Whether to use instructions parameter in Responses API (optional)\n- false: Pass system messages via user messages (default)\n- true: Pass system messages via instructions parameter',
                                            default: false
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        useInstructions: {
                                            deprecationMessage: 'useInstructions is only effective for openai-responses mode'
                                        }
                                    }
                                }
                            },
                            {
                                if: {
                                    anyOf: [
                                        { not: { required: ['sdkMode'] } },
                                        {
                                            properties: {
                                                sdkMode: { enum: ['openai', 'openai-sse'] }
                                            },
                                            required: ['sdkMode']
                                        }
                                    ]
                                },
                                then: {
                                    properties: {
                                        thinkingFormat: {
                                            type: 'string',
                                            enum: ['boolean', 'object'],
                                            enumDescriptions: [
                                                'Use boolean format: { enable_thinking: true/false }',
                                                "Use object format: { thinking: { type: 'enabled' | 'disabled' } }"
                                            ],
                                            default: 'boolean',
                                            description: 'Passing format for thinking mode parameters, for compatibility with different model API format requirements'
                                        }
                                    }
                                },
                                else: {
                                    properties: {
                                        thinkingFormat: {
                                            deprecationMessage: 'thinkingFormat is only effective for openai and openai-sse modes'
                                        }
                                    }
                                }
                            }
                        ],
                        additionalProperties: false
                    }
                }
            },
            additionalProperties: false
        };
    }

    /** Provider IDs reserved for CLI, prohibited from use in general configuration */
    private static readonly CLI_RESERVED_PROVIDERS = ['codex', 'gemini'];

    /**
     * Get all available provider IDs (including built-in, known, custom, and historical providers)
     * Note: CLI-specialized providers (codex, gemini) will be filtered out
     */
    private static getAllAvailableProviders(): { providerIds: string[]; enumDescriptions: string[] } {
        const providerIds: string[] = [];
        const enumDescriptions: string[] = [];

        try {
            // 1. Get built-in providers
            for (const [providerId, config] of Object.entries(ConfigManager.getConfigProvider())) {
                if (this.CLI_RESERVED_PROVIDERS.includes(providerId)) {
                    continue;
                }
                providerIds.push(providerId);
                enumDescriptions.push(config.displayName || providerId);
            }

            // 2. Get known providers
            for (const [providerId, config] of Object.entries(KnownProviders)) {
                if (!providerIds.includes(providerId)) {
                    providerIds.push(providerId);
                    enumDescriptions.push(config.displayName || providerId);
                }
            }

            // 3. Get historical providers from custom models
            const customModels = CompatibleModelManager.getModels();
            const customProviders = new Set<string>();

            for (const model of customModels) {
                const p = (model.provider || '').trim().toLowerCase();
                if (
                    p &&
                    !providerIds.map(id => id.toLowerCase()).includes(p) &&
                    !this.CLI_RESERVED_PROVIDERS.includes(p)
                ) {
                    customProviders.add(p);
                }
            }

            // Add custom providers
            for (const providerId of Array.from(customProviders).sort()) {
                providerIds.push(providerId);
                enumDescriptions.push('Custom provider: ' + providerId);
            }
        } catch (error) {
            Logger.error('Failed to get available providers list:', error);
        }

        return { providerIds, enumDescriptions };
    }

    private static getCommitModelSchema(): JSONSchema7 {
        // Commit provider is user-friendly providerKey (without ccmp. prefix).
        // At runtime, automatically concatenate to VS Code Language Model vendor based on this providerKey: ccmp.<providerKey>.
        const commitProviderIds: string[] = [];
        const commitProviderDescriptions: string[] = [];

        const providerModelIdsMap: Record<string, string[]> = {};

        // Built-in providers (providerKey) + model list after merging user providerOverrides
        // Note: commit model dropdown should include models added by users via override, not limited to built-in configProviders.
        const providerConfigs = ConfigManager.getConfigProvider();
        for (const [providerKey, originalConfig] of Object.entries(providerConfigs)) {
            commitProviderIds.push(providerKey);
            commitProviderDescriptions.push(originalConfig.displayName || providerKey);

            const effectiveConfig = ConfigManager.applyProviderOverrides(providerKey, originalConfig);
            providerModelIdsMap[providerKey] = (effectiveConfig.models ?? []).map(m => m.id).filter(Boolean);
        }

        // Compatible Provider (providerKey = compatible)
        const compatibleModelIds = CompatibleModelManager.getModels()
            .map(m => m.id)
            .filter(Boolean);
        if (!commitProviderIds.includes('compatible')) {
            commitProviderIds.push('compatible');
            commitProviderDescriptions.push('OpenAI / Anthropic Compatible');
        }
        providerModelIdsMap['compatible'] = compatibleModelIds;

        const base: JSONSchema7 = {
            type: 'object',
            description: 'Commit message generation model configuration (provider + model)',
            properties: {
                provider: {
                    type: 'string',
                    description: 'Language model provider (vendor)',
                    enum: commitProviderIds,
                    enumDescriptions: commitProviderDescriptions
                },
                model: {
                    type: 'string',
                    description: 'Model ID (corresponds to Language Model API model.id)',
                    minLength: 1
                }
            },
            required: ['provider', 'model'],
            additionalProperties: false
        };

        const linkedRules: JSONSchema7[] = [];
        for (const [provider, modelIds] of Object.entries(providerModelIdsMap)) {
            // Copilot or no enumerable models: only validate provider
            if (!modelIds || modelIds.length === 0) {
                continue;
            }

            linkedRules.push({
                if: {
                    properties: {
                        provider: { const: provider }
                    },
                    required: ['provider']
                },
                then: {
                    properties: {
                        model: {
                            type: 'string',
                            enum: modelIds
                        }
                    },
                    required: ['model']
                }
            });
        }

        if (linkedRules.length > 0) {
            base.allOf = linkedRules;
        }

        return base;
    }

    /**
     * Clean up resources
     */
    static dispose(): void {
        if (this.fsProviderDisposable) {
            this.fsProviderDisposable.dispose();
            this.fsProviderDisposable = null;
        }

        this.eventDisposables.forEach(d => d.dispose());
        this.eventDisposables = [];

        if (this.onDidChangeFileEmitter) {
            this.onDidChangeFileEmitter.dispose();
            this.onDidChangeFileEmitter = null;
        }

        Logger.trace('Dynamic JSON Schema Provider cleaned up');
    }
}
