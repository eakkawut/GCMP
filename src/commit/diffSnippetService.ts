/*---------------------------------------------------------------------------------------------
 *  Diff Snippet Service
 *  Extracts "per-file" snippets from unified diff (patch format output by git diff).
 *--------------------------------------------------------------------------------------------*/

/**
 * Diff snippet for a single file
 */
export interface FileDiffSnippet {
    filePath: string;
    /** Snippet content (maintains unified diff-like header and hunk structure). */
    excerpt: string;
    /** Approximate size (character count), used for chunking/splitting decisions. */
    charCount: number;
}

export class DiffSnippetService {
    /**
     * Build per-file diff snippets.
     * Description: Split unified diff by `diff --git` into "one snippet per file".
     * - Only truncate when a single file snippet exceeds the limit
     * - Number of snippets is at most maxFiles (excess is discarded)
     */
    static buildSnippets(
        unifiedDiff: string,
        options?: {
            maxExcerptCharsPerFile?: number;
            maxFiles?: number;
        }
    ): FileDiffSnippet[] {
        const maxExcerptCharsPerFile = options?.maxExcerptCharsPerFile ?? 12000;
        const maxFiles = options?.maxFiles ?? 50;

        const lines = unifiedDiff.split(/\r?\n/);
        const snippets: FileDiffSnippet[] = [];

        let currentLines: string[] | null = null;
        let currentFilePath = '';

        const flush = () => {
            if (!currentLines || currentLines.length === 0) {
                currentLines = null;
                currentFilePath = '';
                return;
            }
            let excerpt = currentLines.join('\n').trim();
            if (excerpt && excerpt.length > maxExcerptCharsPerFile) {
                excerpt = excerpt.slice(0, maxExcerptCharsPerFile) + '\n... [file excerpt truncated]';
            }
            if (excerpt) {
                snippets.push({
                    filePath: currentFilePath || '(unknown-file)',
                    excerpt,
                    charCount: excerpt.length
                });
            }
            currentLines = null;
            currentFilePath = '';
        };

        for (const line of lines) {
            if (line.startsWith('diff --git ')) {
                flush();
                if (snippets.length >= maxFiles) {
                    break;
                }
                currentLines = [line];
                const paths = this.parseDiffGitHeaderPaths(line);
                currentFilePath = paths[1] || paths[0] || '';
                continue;
            }

            if (!currentLines) {
                continue;
            }
            currentLines.push(line);
        }

        flush();
        return snippets.slice(0, maxFiles);
    }

    /**
     * Tokenize the remaining path portion in the `diff --git` header.
     *
     * Goal: Reconstruct the two path tokens output by git (aPath/bPath) as much as possible without relying on shell tokenization.
     * - Compatible with quoted path tokens (git may output C-style quoted strings)
     * - Compatible with backslash escaping (preserve `\` for subsequent decoding)
     *
     * Note: This only handles token splitting, not removing a/、b/ prefixes or decoding quotes/escapes.
     */
    private static tokenizeDiffGitPaths(rest: string): string[] {
        // Tokenization should be compatible with quoted paths (git uses C-style quoted strings for paths with special characters).
        const out: string[] = [];
        let cur = '';
        let inQuotes = false;
        let escape = false;
        for (const ch of rest) {
            if (escape) {
                cur += ch;
                escape = false;
                continue;
            }
            if (ch === '\\') {
                // Preserve backslash so JSON.parse (handling quoted tokens) can correctly decode escapes.
                cur += ch;
                escape = true;
                continue;
            }
            if (ch === '"') {
                cur += ch;
                inQuotes = !inQuotes;
                continue;
            }
            if (!inQuotes && ch === ' ') {
                if (cur) {
                    out.push(cur);
                    cur = '';
                }
                continue;
            }
            cur += ch;
        }
        if (cur) {
            out.push(cur);
        }
        return out;
    }

    /**
     * Decode a single path token.
     *
     * - If token is wrapped in double quotes: try to decode escapes using JSON.parse (e.g., `\n`, `\t`, `\"`, etc.)
     * - Otherwise: a lightweight fallback that only restores `\ ` to space (git may escape spaces this way in non-quoted scenarios)
     */
    private static decodeGitPathToken(token: string): string {
        const t = token.trim();
        if (t.startsWith('"') && t.endsWith('"')) {
            try {
                return JSON.parse(t);
            } catch {
                return t.slice(1, -1);
            }
        }
        // Non-quoted scenario: git may escape spaces and other characters with backslashes.
        return t.replace(/\\ /g, ' ');
    }

    /**
     * Parse a single line `diff --git ...` header, returns [aPath, bPath].
     *
     * Line format examples:
     * - `diff --git a/src/a.ts b/src/a.ts`
     * - `diff --git "a/space file.txt" "b/space file.txt"`
     *
     * Behavior:
     * - Use tokenizeDiffGitPaths to split the latter half of the header into two path tokens
     * - Use decodeGitPathToken to decode quotes/escapes
     * - Return values will have leading `a/` and `b/` prefixes removed (if present)
     *
     * Returns ['', ''] on parse failure (unable to obtain two tokens).
     */
    private static parseDiffGitHeaderPaths(line: string): [string, string] {
        const rest = line.slice('diff --git '.length);
        const tokens = this.tokenizeDiffGitPaths(rest);
        if (tokens.length < 2) {
            return ['', ''];
        }

        const aRaw = this.decodeGitPathToken(tokens[0]);
        const bRaw = this.decodeGitPathToken(tokens[1]);
        const aPath = aRaw.startsWith('a/') ? aRaw.slice(2) : aRaw;
        const bPath = bRaw.startsWith('b/') ? bRaw.slice(2) : bRaw;
        return [aPath || '', bPath || ''];
    }
}
