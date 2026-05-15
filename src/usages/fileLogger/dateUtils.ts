/*---------------------------------------------------------------------------------------------
 *  Date Utility Class
 *  Unified management of date formatting and related operations
 *--------------------------------------------------------------------------------------------*/

/**
 * Date Utility Class
 * Provides unified date formatting and calculation methods
 */
export class DateUtils {
    /**
     * Format Date as YYYY-MM-DD
     * @param date Date object
     * @returns Formatted date string
     */
    static formatDate(date: Date): string {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    /**
     * Get Today's Date String
     */
    static getTodayDateString(): string {
        return this.formatDate(new Date());
    }

    /**
     * Get Date String for Specified Number of Days Ago
     * @param daysAgo Number of days ago (positive number)
     */
    static getDateStringDaysAgo(daysAgo: number): string {
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        return this.formatDate(date);
    }

    /**
     * Parse Date Range (start and end timestamps) from Date String
     * @param dateStr Date string in YYYY-MM-DD format
     */
    static parseDateRange(dateStr: string): { start: number; end: number } {
        const date = new Date(dateStr);
        const start = date.getTime();
        const end = start + 86400000 - 1; // 86400000 = 24 * 60 * 60 * 1000
        return { start, end };
    }

    /**
     * Check if Two Dates Are the Same Day
     */
    static isSameDay(date1: Date, date2: Date): boolean {
        return this.formatDate(date1) === this.formatDate(date2);
    }

    /**
     * Check if Date Is Today
     */
    static isToday(date: Date): boolean {
        return this.isSameDay(date, new Date());
    }
}
