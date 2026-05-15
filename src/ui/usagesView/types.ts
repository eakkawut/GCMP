/**
 * UsagesView Unified Type Definitions
 * Directly use storage service's raw data types, avoiding duplicate definitions and conversions
 */

// ============= Import Raw Types from Storage Service =============

import type { DateSummary } from '../../usages/types';
import type {
    FileLoggerProviderStats,
    FileLoggerModelStats as ModelData,
    HourlyStats,
    TokenRequestLog as RequestRecord
} from '../../usages/fileLogger/types';
import type { ExtendedTokenRequestLog } from '../../usages/fileLogger/usageParser';

// ============= UI Layer Data Types =============

/**
 * UI layer provider data type
 * Extended from FileLoggerProviderStats with added providerKey field
 * Since array form is used in UI layer, need to preserve providerKey information
 */
export interface ProviderData extends FileLoggerProviderStats {
    providerKey: string;
}

// ============= Re-export Types for External Use =============

export type { DateSummary, ModelData, HourlyStats, RequestRecord };
export type { ExtendedTokenRequestLog };

// ============= Message Type Definitions =============

/**
 * Message types sent from WebView to VSCode
 */
export type WebViewMessage =
    | { command: 'getInitialData' }
    | { command: 'refresh'; date?: string }
    | { command: 'selectDate'; date: string }
    | { command: 'openStorageDir' };

/**
 * Message types sent from VSCode to WebView
 */
export interface UpdateDateListMessage {
    command: 'updateDateList';
    dateList: DateSummary[];
    selectedDate: string;
    today: string;
}

export interface UpdateDateDetailsMessage {
    command: 'updateDateDetails';
    date: string;
    isToday: boolean;
    providers: ProviderData[];
    hourlyStats: Record<string, HourlyStats>;
    records: ExtendedTokenRequestLog[];
}

export type HostMessage = UpdateDateListMessage | UpdateDateDetailsMessage;

// ============= Application State Type =============

/**
 * Simplified state (for internal state management)
 */
export interface State {
    selectedDate: string;
    today: string;
    dateList: DateSummary[];
    dateDetails: DateDetails | null;
    loading: {
        dateDetails: boolean;
    };
}

/**
 * Date details (for internal state management)
 */
export interface DateDetails {
    date: string;
    isToday: boolean;
    providers: ProviderData[];
    hourlyStats: Record<string, HourlyStats>;
    records: ExtendedTokenRequestLog[];
}

/**
 * Extend Window interface with application state
 */
declare global {
    interface Window {
        usagesState: State;
        usagesSetLoading: (type: 'dateDetails', isLoading: boolean) => void;
    }
}
