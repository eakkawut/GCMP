/*---------------------------------------------------------------------------------------------
 *  Shared Type Definitions
 *  Common type definitions supporting multiple providers
 *--------------------------------------------------------------------------------------------*/

export interface ModelChatResponseOptions {
    /**
     * Deep thinking mode
     * - disabled: Force disable deep thinking, model will not output chain of thought
     * - enabled: Force enable deep thinking, model will be forced to output chain of thought
     * - auto: Model decides whether deep thinking is needed
     * - adaptive: Model adaptively adjusts deep thinking mode based on context
     */
    readonly thinking?: 'disabled' | 'enabled' | 'auto' | 'adaptive';
    /**
     * Reasoning effort
     * - none: Disable thinking, direct answer
     * - minimal: Disable thinking, direct answer
     * - low: Lightweight thinking, focus on fast response
     * - medium: Balanced mode, balance speed and depth
     * - high: Deep analysis, handle complex problems
     * - xhigh: Maximum reasoning depth, slower speed
     * - max: Absolute highest capability, no limit on token consumption
     */
    readonly reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * Model configuration interface
 */
export interface ModelConfig {
    id: string;
    name: string;
    tooltip: string;
    maxInputTokens: number;
    maxOutputTokens: number;
    version?: string;
    capabilities: {
        toolCalling: boolean;
        imageInput: boolean;
    };
    /**
     * SDK mode selection (optional)
     * - "anthropic": Use Anthropic SDK
     * - "openai": Use OpenAI SDK (default)
     * - "openai-sse": Use OpenAI SSE compatible mode (custom implementation for streaming response handling)
     * - "openai-responses": Use OpenAI Responses API (use Responses API for request-response handling)
     * - "gemini-sse": Use Gemini HTTP SSE compatible mode (custom implementation for streaming response handling)
     */
    sdkMode?: 'anthropic' | 'openai' | 'openai-sse' | 'openai-responses' | 'gemini-sse';
    /**
     * Model-specific baseUrl (optional)
     * If provided, will override provider-level baseUrl
     */
    baseUrl?: string;
    /**
     * Custom API endpoint path (optional)
     * Used to replace the path default appended to baseUrl (e.g., /chat/completions, /responses).
     * - Relative path (e.g., /custom/path): concatenated with baseUrl
     * - Full URL (e.g., https://api.example.com/custom): used directly as request URL
     * Only effective for openai, openai-sse, openai-responses modes.
     */
    endpoint?: string;
    /**
     * Model-specific request model name (optional)
     * If provided, this model name will be used instead of model ID to initiate requests
     */
    model?: string;
    /**
     * Model family identifier (optional)
     * Used to determine the editing tool mode used by the model
     * If not set, default value will be automatically inferred from sdkMode:
     * - anthropic → claude-sonnet-4.6
     * - openai/openai-sse: id/model contains gpt → gpt-5.2, otherwise → claude-sonnet-4.6
     * - openai-responses → gpt-5.2
     * - gemini-sse → gemini-3-pro
     */
    family?: string;
    /**
     * Deep thinking mode option list (optional)
     * Used for UI configuration selection, determines the range of thinking modes users can select:
     * - disabled: Force disable deep thinking, model will not output chain of thought
     * - enabled: Force enable deep thinking, model will be forced to output chain of thought
     * - auto: Model decides whether deep thinking is needed
     */
    thinking?: Required<ModelChatResponseOptions>['thinking'][];
    /**
     * Passing format for thinking mode parameters (optional)
     * - boolean: Use boolean format { enable_thinking: true/false }
     * - object: Use object format { thinking: { type: 'enabled' | 'disabled' } }
     * Default value is 'boolean'
     */
    thinkingFormat?: 'boolean' | 'object';
    /**
     * Reasoning effort option list (optional)
     * Used for UI configuration selection, balance effects, latency, and cost requirements across different scenarios:
     * - none: Disable thinking, direct answer
     * - minimal: Disable thinking, direct answer
     * - low: Lightweight thinking, focus on fast response
     * - medium: Balanced mode, balance speed and depth
     * - high: Deep analysis, handle complex problems
     */
    reasoningEffort?: Required<ModelChatResponseOptions>['reasoningEffort'][];
    /**
     * Model-specific custom HTTP headers (optional)
     * If provided, these custom headers will be attached to API requests
     */
    customHeader?: Record<string, string>;
    /**
     * Model-specific provider identifier (optional)
     * Used for custom models, specifies which provider to use for API key lookup
     * If provided, Handler will preferentially obtain API key from this provider
     */
    provider?: string;
    /**
     * Additional request body parameters (optional)
     * If provided, will be merged into request body in API requests
     */
    extraBody?: Record<string, unknown>;
    /**
     * Whether to use instructions parameter in Responses API (optional)
     *  - Default value is false, meaning use user messages to pass system message instructions
     *  - When set to true, use instructions parameter to pass system instructions
     */
    useInstructions?: boolean;
    /**
     * Whether to enable Anthropic native web_search tool (optional)
     * Only effective for models with sdkMode=anthropic.
     */
    webSearchTool?: boolean;
}

/**
 * Model override configuration interface - for user configuration overrides
 */
export interface ModelOverride {
    id: string;
    /** Override display name (mainly for adding new models) */
    name?: string;
    /** Override description (mainly for adding new models) */
    tooltip?: string;
    /** Override model name */
    model?: string;
    /** Override maximum input token count */
    maxInputTokens?: number;
    /** Override maximum output token count */
    maxOutputTokens?: number;
    /** Override SDK mode */
    sdkMode?: ModelConfig['sdkMode'];
    /** Merge capabilities (will be merged with original capabilities) */
    capabilities?: {
        toolCalling?: boolean;
        imageInput?: boolean;
    };
    /** Override baseUrl */
    baseUrl?: string;
    /** Model family identifier (optional) */
    family?: string;
    /** Deep thinking mode option list (optional) */
    thinking?: ModelConfig['thinking'];
    /** Passing format for thinking mode parameters (optional) */
    thinkingFormat?: ModelConfig['thinkingFormat'];
    /** Reasoning effort option list (optional) */
    reasoningEffort?: ModelConfig['reasoningEffort'];
    /**
     * Model-specific custom HTTP headers (optional)
     * If provided, these custom headers will be attached to API requests
     */
    customHeader?: Record<string, string>;
    /**
     * Additional request body parameters (optional)
     * If provided, will be merged into request body in API requests
     */
    extraBody?: Record<string, unknown>;
    /** Whether to use instructions parameter in Responses API (only effective when sdkMode=openai-responses) */
    useInstructions?: boolean;
    /** Whether to enable Anthropic native web_search tool (only effective when sdkMode=anthropic) */
    webSearchTool?: boolean;
}

/**
 * Provider override configuration interface - for user configuration overrides
 */
export interface ProviderOverride {
    /** Override provider-level baseUrl */
    baseUrl?: string;
    /** Provider-level custom HTTP headers (optional) */
    customHeader?: Record<string, string>;
    /** Model override configuration list */
    models?: ModelOverride[];
}

/**
 * Provider configuration interface
 */
export interface ProviderConfig {
    displayName: string;
    baseUrl: string;
    apiKeyTemplate: string;
    codingKeyTemplate?: string;
    tokenKeyTemplate?: string;
    models: ModelConfig[];
    /**
     * Provider-level custom HTTP headers (optional)
     * If provided, these custom headers will be attached to all API requests for this provider
     * Model-level customHeader overrides provider-level headers with the same name
     */
    customHeader?: Record<string, string>;
}

/**
 * Complete configuration provider structure
 */
export type ConfigProvider = Record<string, ProviderConfig>;

/**
 * User configuration override interface - from VS Code settings
 */
export type UserConfigOverrides = Record<string, ProviderOverride>;

/**
 * API key validation result
 */
export interface ApiKeyValidation {
    isValid: boolean;
    error?: string;
    isEmpty?: boolean;
}
