/*---------------------------------------------------------------------------------------------
 *  Commit Module Type Definitions
 *  Type definitions for commit message generation feature
 *--------------------------------------------------------------------------------------------*/

/**
 * Commit message format
 */
export type CommitFormat =
    | 'auto'
    | 'plain'
    | 'custom'
    | 'conventional'
    | 'angular'
    | 'karma'
    | 'semantic'
    | 'emoji'
    | 'emojiKarma'
    | 'google'
    | 'atom';

/**
 * Commit message language
 */
export type CommitLanguage = 'english' | 'chinese';

/**
 * Generated commit message result
 */
export interface CommitMessage {
    /** Generated commit message */
    message: string;
    /** Model used */
    model: string;
}

/**
 * Progress reporter interface
 */
export interface ProgressReporter {
    report(value: { message?: string; increment?: number }): void;
}

/**
 * Commit module configuration key
 */
/**
 * Model selection for commit message generation
 */
export interface CommitModelSelection {
    /** Language model provider (providerKey, e.g.: zhipu / compatible) */
    provider: string;
    /** Model ID (corresponds to LanguageModelChatInformation.id) */
    model: string;
}

/**
 * Custom error types
 */
export class UserCancelledError extends Error {
    constructor(message = 'User cancelled the operation') {
        super(message);
        this.name = 'UserCancelledError';
    }
}

export class NoChangesDetectedError extends Error {
    constructor(message = 'No changes detected') {
        super(message);
        this.name = 'NoChangesDetectedError';
    }
}

export class NoRepositoriesFoundError extends Error {
    constructor(message = 'No Git repositories found') {
        super(message);
        this.name = 'NoRepositoriesFoundError';
    }
}

export class NoRepositorySelectedError extends Error {
    constructor(message = 'No repository selected') {
        super(message);
        this.name = 'NoRepositorySelectedError';
    }
}

export class GitExtensionNotFoundError extends Error {
    constructor(message = 'Git extension not found') {
        super(message);
        this.name = 'GitExtensionNotFoundError';
    }
}

export class ModelNotFoundError extends Error {
    constructor(message = 'No language model available') {
        super(message);
        this.name = 'ModelNotFoundError';
    }
}

export class EmptyCommitMessageError extends Error {
    constructor(message = 'Generated commit message is empty') {
        super(message);
        this.name = 'EmptyCommitMessageError';
    }
}

export interface CommitChatModelOptions {
    readonly commit?: boolean;
}
