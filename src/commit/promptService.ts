/*---------------------------------------------------------------------------------------------
 *  Prompt Service
 *  Generates complete AI prompts
 *--------------------------------------------------------------------------------------------*/

import { CommitFormat, CommitLanguage } from './types';
import { ConfigManager } from '../utils';
import { getTemplate } from './templates';

/**
 * Prompt Service
 * Responsible for generating complete AI prompts
 */
export class PromptService {
    /**
     * Generate final commit message prompt.
     * Note: diff snippets, historical context etc. have been passed upstream in "separate message/attachment" format,
     * here we only generate the final instructions (keep as short as possible).
     */
    static generateCommitPrompt(): string {
        const commit = ConfigManager.getCommitConfig();
        const format = commit.format;
        const customInstructions = commit.customInstructions;
        const language = commit.language;

        // Custom mode: primarily user instructions, but still append context (snippets/history)
        if (format === 'custom' && customInstructions.trim()) {
            return this.generateCustomPrompt(customInstructions);
        }

        // auto: do not make any inferences on the extension side.
        // Upstream will provide "recent commit history" to the model as a separate user message, the model should infer repository style on its own.
        if (format === 'auto') {
            return this.generateAutoPrompt(language);
        }

        // custom but no custom instructions provided: fallback to plain
        const effectiveFormat = format === 'custom' ? 'plain' : format;
        return this.generateStandardPrompt(effectiveFormat, language);
    }

    /**
     * Auto mode: let the model independently infer the repository's commit conventions based on "recent commit history", and output in the same style.
     * Note: historical content is provided by upstream in separate message format.
     */
    private static generateAutoPrompt(language: CommitLanguage): string {
        const fallbackLanguage = language === 'chinese' ? 'Chinese' : 'English';

        let prompt = `Generate a commit message that matches this repository's existing commit message style.

You may be given recent commit history in a previous message.

Rules:
    1. If recent commit history is provided, infer the predominant commit message format/style AND language from it.
    2. If the inferred language is clear, write the commit message in that language.
    3. If the inferred language is mixed or unclear (or no history is provided), write the commit message in ${fallbackLanguage}.
    4. Produce ONE commit message for the current changes using the inferred style.
    5. If the inferred style is mixed or unclear (or no history is provided), fall back to a single plain sentence (no prefixes, no emojis, no issue refs).
    6. Keep it concise (ideally <= 72 characters for the first line).
    7. Output the commit message only.`;

        prompt += `
IMPORTANT: Please provide ONLY the commit message, without any additional text, explanations, or markdown formatting (no \`\`\` blocks).`;

        return prompt;
    }

    /**
     * Generate custom instruction prompt
     */
    private static generateCustomPrompt(customInstructions: string): string {
        let prompt = customInstructions;

        prompt += `
Please provide ONLY the commit message, without any additional text, explanations, or markdown formatting (no \`\`\` blocks).`;

        return prompt;
    }

    /**
     * Generate standard template prompt
     */
    private static generateStandardPrompt(format: CommitFormat, language: CommitLanguage): string {
        const languagePrompt = this.getLanguagePrompt(language);
        const template = getTemplate(format);

        let prompt = template;

        // Keep whitespace predictable, avoid indentation accidentally seeping into prompt content.
        prompt += `\n\n${languagePrompt}\n`;

        prompt += `
IMPORTANT: Please provide ONLY the commit message, without any additional text, explanations, or markdown formatting (no \`\`\` blocks).`;

        return prompt;
    }

    /**
     * Get language prompt
     */
    static getLanguagePrompt(language: CommitLanguage): string {
        switch (language) {
            case 'chinese':
                // Prompt instructions remain in English; only the output language requirement changes.
                return 'Please write the commit message in Chinese.';
            case 'english':
            default:
                return 'Please write the commit message in English.';
        }
    }

    /**
     * Generate System Role message for commit scenarios.
     * Some models require the first message to be system role, used to set basic behavior constraints.
     */
    static generateCommitSystemMessage(): string {
        return 'You are an expert at writing concise, accurate git commit messages. Analyze the provided diffs and generate a single commit message that summarizes the changes.';
    }

    /**
     * Normalize commit message output from model.
     */
    static normalizeCommitMessage(message: string): string {
        let cleaned = (message ?? '').trim();

        // Only remove the case where "the entire content is wrapped in a fenced code block", to avoid accidentally deleting ``` in the body.
        const fenced = cleaned.match(/^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
        if (fenced) {
            cleaned = fenced[1].trim();
        }

        // Remove excess blank lines
        cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
        return cleaned.trim();
    }
}
