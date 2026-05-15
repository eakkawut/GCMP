/*---------------------------------------------------------------------------------------------
 *  Copilot Log Target - Log Target Implementation
 *  Implements ILogTarget interface
 *  Reference: NullLogTarget in getInlineCompletions.spec.ts
 *  Reference: TestLogTarget in nesProvider.spec.ts
 *--------------------------------------------------------------------------------------------*/

import { ILogTarget, LogLevel } from '@vscode/chat-lib';
import { getCompletionLogger } from './singletons';

/**
 * Log Target Implementation
 */
export class CopilotLogTarget implements ILogTarget {
    logIt(level: LogLevel, metadataStr: string, ...extra: unknown[]): void {
        const CompletionLogger = getCompletionLogger();
        switch (level) {
            case LogLevel.Error:
                CompletionLogger.error(`[CopilotLogTarget] ${metadataStr}`, ...extra);
                return;
            case LogLevel.Warning:
                CompletionLogger.warn(`[CopilotLogTarget] ${metadataStr}`, ...extra);
                return;
            case LogLevel.Info:
                // CompletionLogger.info(`[CopilotLogTarget] ${metadataStr}`, ...extra);
                // return;
                // case LogLevel.Debug:
                CompletionLogger.debug(`[CopilotLogTarget] ${metadataStr}`, ...extra);
                return;
            // case LogLevel.Trace:
            //     CompletionLogger.trace(`[CopilotLogTarget] ${metadataStr}`, ...extra);
            //     return;
        }
    }
}
