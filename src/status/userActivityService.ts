import * as vscode from 'vscode';
import { StatusLogger } from '../utils/statusLogger';

/**
 * User activity information structure
 */
interface UserActivityInfo {
    lastActiveTime: number; // Timestamp of last activity
    instanceId: string; // Instance ID of last activity
    recentActivityCount: number; // Recent activity count (used to evaluate activity level)
    lastActivityType?: ActivityType; // Type of last active operation
}

/**
 * User operation type enum
 */
type ActivityType = 'windowFocus' | 'editorChange' | 'textEdit' | 'textSelection' | 'terminalChange';

/**
 * Throttle configuration for different operation types (milliseconds)
 */
const ACTIVITY_THROTTLE_CONFIG: Record<ActivityType, number> = {
    windowFocus: 5000, // Window focus change: 5 seconds
    editorChange: 3000, // Editor switch: 3 seconds
    textEdit: 5000, // Text edit: 5 seconds
    textSelection: 2000, // Text selection: 2 seconds (most reliable user operation)
    terminalChange: 3000 // Terminal switch: 3 seconds
};

/**
 * User activity status detection service (pure static class)
 * Responsible for monitoring and recording user activity status in VS Code
 * Supports multi-instance shared activity status
 */
export class UserActivityService {
    private static readonly USER_ACTIVITY_KEY = 'ccmp.user.activity'; // User activity status storage key
    private static readonly ACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes activity timeout
    private static readonly ACTIVITY_COUNT_WINDOW = 5 * 60 * 1000; // Activity count statistics window: 5 minutes
    private static readonly CACHE_VALIDITY = 5000; // Cache validity: 5 seconds

    // Static member variables
    private static instanceId: string;
    private static context: vscode.ExtensionContext | undefined;
    private static activityDisposables: vscode.Disposable[] = []; // Activity status listeners
    private static lastRecordedActivityByType = new Map<ActivityType, number>(); // Last activity time recorded by type
    private static cachedActivityInfo: UserActivityInfo | null = null; // Memory cache
    private static lastCacheUpdate = 0; // Cache update time
    private static initialized = false;

    /**
     * Private constructor - prevent instantiation
     */
    private constructor() {
        throw new Error('UserActivityService is a static class and cannot be instantiated');
    }

    /**
     * Initialize activity detection service
     * @param context VS Code extension context
     * @param instanceId Current instance ID (provided by caller)
     */
    public static initialize(context: vscode.ExtensionContext, instanceId: string): void {
        if (this.initialized) {
            return;
        }

        this.context = context;
        this.instanceId = instanceId;

        // Register user activity status listeners
        this.registerActivityListeners();

        this.initialized = true;
        StatusLogger.debug('[UserActivityService] User activity detection service initialized');
    }

    /**
     * Stop activity detection service
     */
    public static stop(): void {
        // Clean up activity status listeners
        this.activityDisposables.forEach(d => d.dispose());
        this.activityDisposables = [];

        // Clean up cache and status
        this.cachedActivityInfo = null;
        this.lastCacheUpdate = 0;
        this.lastRecordedActivityByType.clear();

        this.initialized = false;
        StatusLogger.debug('[UserActivityService] User activity detection service stopped');
    }

    /**
     * Register user activity status listeners
     * Only listen to real user operations, filter out automatic operations or non-user actual operations
     */
    private static registerActivityListeners(): void {
        if (!this.context) {
            return;
        }

        // Listen for window state changes (only user actively focuses window)
        this.activityDisposables.push(
            vscode.window.onDidChangeWindowState(state => {
                if (state.focused) {
                    this.recordUserActivity('windowFocus');
                }
            })
        );

        // Listen for user actively switching editors (filter out program-triggered switches)
        this.activityDisposables.push(
            vscode.window.onDidChangeActiveTextEditor(editor => {
                if (vscode.window.state.focused && editor) {
                    const scheme = editor.document.uri.scheme;
                    if (scheme === 'file' || scheme === 'untitled') {
                        this.recordUserActivity('editorChange');
                    }
                }
            })
        );

        // Listen for document content changes (only user edits, filter out auto-formatting etc.)
        this.activityDisposables.push(
            vscode.workspace.onDidChangeTextDocument(event => {
                if (event.contentChanges.length === 0) {
                    return;
                }
                if (!vscode.window.state.focused) {
                    return;
                }
                const scheme = event.document.uri.scheme;
                if (scheme !== 'file' && scheme !== 'untitled') {
                    return;
                }
                const totalChanges = event.contentChanges.reduce((sum, c) => sum + c.text.length + c.rangeLength, 0);
                if (totalChanges > 1000) {
                    return;
                }
                this.recordUserActivity('textEdit');
            })
        );

        // Listen for user selection changes (cursor movement, text selection) - this is the most reliable user operation signal
        this.activityDisposables.push(
            vscode.window.onDidChangeTextEditorSelection(event => {
                if (!vscode.window.state.focused) {
                    return;
                }
                const scheme = event.textEditor.document.uri.scheme;
                if (scheme !== 'file' && scheme !== 'untitled') {
                    return;
                }
                if (
                    event.kind === vscode.TextEditorSelectionChangeKind.Keyboard ||
                    event.kind === vscode.TextEditorSelectionChangeKind.Mouse
                ) {
                    this.recordUserActivity('textSelection');
                }
            })
        );

        // Listen for user actively switching terminal
        this.activityDisposables.push(
            vscode.window.onDidChangeActiveTerminal(terminal => {
                if (vscode.window.state.focused && terminal) {
                    this.recordUserActivity('terminalChange');
                }
            })
        );

        // If window is focused during initialization, record once
        if (vscode.window.state.focused) {
            this.recordUserActivity('windowFocus');
        }

        StatusLogger.debug('[UserActivityService] User activity status listeners registered (only listening to real user operations)');
    }

    /**
     * Check if specified operation type needs throttling
     * @param activityType Operation type
     * @returns true if needs throttling (skip recording), false if can record
     */
    private static shouldThrottle(activityType: ActivityType): boolean {
        const now = Date.now();
        const lastRecorded = this.lastRecordedActivityByType.get(activityType) || 0;
        const throttleInterval = ACTIVITY_THROTTLE_CONFIG[activityType];
        return now - lastRecorded < throttleInterval;
    }

    /**
     * Record user activity status to globalState (with differentiated throttling)
     * Activity status of any instance will update the global last activity time
     * Different operation types use different throttle intervals
     * @param activityType Operation type that triggered activity
     */
    private static async recordUserActivity(activityType: ActivityType): Promise<void> {
        if (!this.context) {
            return;
        }

        // Differentiated throttling: decide whether to record based on operation type
        if (this.shouldThrottle(activityType)) {
            return;
        }

        const now = Date.now();
        this.lastRecordedActivityByType.set(activityType, now);

        // Get current activity info, calculate activity count
        const currentInfo = this.getCachedActivityInfo();
        let recentActivityCount = 1;

        if (
            currentInfo &&
            typeof currentInfo.recentActivityCount === 'number' &&
            !isNaN(currentInfo.recentActivityCount)
        ) {
            // If last activity is within statistics window, accumulate count; otherwise reset
            if (now - currentInfo.lastActiveTime < this.ACTIVITY_COUNT_WINDOW) {
                recentActivityCount = Math.min(currentInfo.recentActivityCount + 1, 100); // Upper limit 100
            }
        }

        const activityInfo: UserActivityInfo = {
            lastActiveTime: now,
            instanceId: this.instanceId,
            recentActivityCount: recentActivityCount,
            lastActivityType: activityType
        };

        // Update cache
        this.cachedActivityInfo = activityInfo;
        this.lastCacheUpdate = now;

        await this.context.globalState.update(this.USER_ACTIVITY_KEY, activityInfo);
        StatusLogger.trace(
            `[UserActivityService] Recorded user activity status: type=${activityType}, count=${recentActivityCount}, time=${now}`
        );
    }

    /**
     * Get cached activity information (reduce globalState reads)
     */
    private static getCachedActivityInfo(): UserActivityInfo | null {
        const now = Date.now();

        // Check if cache is valid
        if (this.cachedActivityInfo && now - this.lastCacheUpdate < this.CACHE_VALIDITY) {
            return this.cachedActivityInfo;
        }

        // Cache expired, read from globalState
        if (!this.context) {
            return null;
        }

        const activityInfo = this.context.globalState.get<UserActivityInfo>(this.USER_ACTIVITY_KEY);
        if (activityInfo) {
            // Data validation and repair: ensure recentActivityCount is a valid number
            const isValidCount =
                typeof activityInfo.recentActivityCount === 'number' &&
                activityInfo.recentActivityCount >= 0 &&
                !isNaN(activityInfo.recentActivityCount);

            const validatedInfo: UserActivityInfo = {
                lastActiveTime: activityInfo.lastActiveTime ?? Date.now(),
                instanceId: activityInfo.instanceId ?? '',
                recentActivityCount: isValidCount ? activityInfo.recentActivityCount : 0,
                lastActivityType: activityInfo.lastActivityType
            };
            this.cachedActivityInfo = validatedInfo;
            this.lastCacheUpdate = now;
            return validatedInfo;
        }
        return null;
    }

    /**
     * Check if user was active in the last 30 minutes
     * @returns true if user was active within 30 minutes, false if inactive for over 30 minutes
     */
    public static isUserActive(): boolean {
        const activityInfo = this.getCachedActivityInfo();
        if (!activityInfo) {
            // No activity records, consider inactive
            return false;
        }

        const now = Date.now();
        const inactiveTime = now - activityInfo.lastActiveTime;
        const isActive = inactiveTime <= this.ACTIVITY_TIMEOUT;

        StatusLogger.trace(
            `[UserActivityService] Checking user activity status: lastActive=${activityInfo.lastActiveTime}, ` +
            `inactiveTime=${inactiveTime}ms, activityCount=${activityInfo.recentActivityCount}, isActive=${isActive}`
        );

        return isActive;
    }

    /**
     * Get user last active time
     * @returns Last active timestamp, returns undefined if no records
     */
    public static getLastActiveTime(): number | undefined {
        const activityInfo = this.getCachedActivityInfo();
        return activityInfo?.lastActiveTime;
    }

    /**
     * Get user inactive duration (milliseconds)
     * @returns Inactive duration, returns Infinity if no records
     */
    public static getInactiveTime(): number {
        const lastActiveTime = this.getLastActiveTime();
        if (lastActiveTime === undefined) {
            return Infinity;
        }
        return Date.now() - lastActiveTime;
    }
}
