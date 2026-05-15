/*---------------------------------------------------------------------------------------------
 *  Commit Module Exports
 *  AI-driven commit message generation feature
 *--------------------------------------------------------------------------------------------*/

// Type exports
export * from './types';

// Service exports
export { GitService, checkGitAvailability } from './gitService';
export { PromptService } from './promptService';
export { GeneratorService } from './generatorService';

// Template exports
export { getTemplate } from './templates';

// Command exports
export { registerCommitCommands } from './commands';
export { CommitMessage } from './commitMessage';
