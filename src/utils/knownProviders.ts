import { ModelOverride, ProviderConfig, ProviderOverride } from '../types/sharedTypes';

export interface KnownProviderConfig extends Partial<ProviderConfig & ProviderOverride> {
    /** Compatibility strategy for OpenAI SDK */
    openai?: Omit<ModelOverride, 'id'>;
    /** Compatibility strategy for Anthropic SDK */
    anthropic?: Omit<ModelOverride, 'id'>;
}

/**
 * Built-in known providers and partial adaptation information
 *
 * During model config merge, priority order: model config > provider config > known provider config
 * Processed merge parameters include:
 *   - customHeader,
 *   - override.extraBody
 *
 * @static
 * @type {(Record<string, KnownProviderConfig>)}
 * @memberof CompatibleModelManager
 */
export const KnownProviders: Record<string, KnownProviderConfig> = {
    aihubmix: {
        displayName: 'AIHubMix',
        customHeader: { 'APP-Code': 'TFUV4759' },
        openai: {
            baseUrl: 'https://aihubmix.com/v1'
        },
        anthropic: {
            baseUrl: 'https://aihubmix.com',
            extraBody: {
                top_p: null
            }
        }
    },
    aiping: { displayName: 'AIPing' },
    openrouter: { displayName: 'OpenRouter' },
    siliconflow: { displayName: 'SiliconFlow' },
    infini: { displayName: 'Infini' },
    mistral: { displayName: 'MistralAI' }
};
