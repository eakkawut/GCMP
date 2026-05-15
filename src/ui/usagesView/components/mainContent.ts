/**
 * Main Content Area Component
 * Responsible for rendering the right-side main content area
 */

import { createProviderStats } from './providerStats';
import { createHourlyStats } from './hourlyStats';
import { createHourlyChart } from './hourlyChart';
import { createElement } from '../../utils';

// ============= Utility Functions =============

/**
 * Check if the date is today
 */
function isToday(date: string): boolean {
    return date === window.usagesState?.today;
}

// ============= Component Rendering =============

/**
 * Create empty content placeholder
 */
function createEmptyContent(dateText: string): HTMLElement {
    const content = createElement('div', 'empty-message');
    content.innerHTML = `💡 No Token consumption records for ${dateText}`;
    return content;
}

/**
 * Create main content area
 */
export function createMainContent(): HTMLElement {
    const content = createElement('div', 'content');

    const title = createElement('h2', '', { id: 'details-title' });
    title.textContent = 'Loading...';

    const detailsContent = createElement('div', '', { id: 'details-content' });

    content.appendChild(title);
    content.appendChild(detailsContent);

    return content;
}

/**
 * Update main content area
 */
export function updateMainContent(): void {
    const content = document.querySelector('.content');
    if (!content || !window.usagesState) {
        return;
    }

    const title = content.querySelector('#details-title') as HTMLElement;
    const detailsContent = content.querySelector('#details-content') as HTMLElement;

    // Update title
    const dateDetails = window.usagesState.dateDetails;
    const displayText = dateDetails?.date && isToday(dateDetails.date) ? 'Today' : dateDetails?.date || 'Loading...';
    title.textContent = `${displayText} Usage Details`;

    // Update content
    if (dateDetails && dateDetails.providers && dateDetails.providers.length > 0) {
        // Find and remove existing containers (to prevent them from being cleared by innerHTML)
        const existingChartSection = detailsContent.querySelector('.hourly-chart-section') as HTMLElement;
        const existingStatsSection = detailsContent.querySelector('.hourly-stats-section') as HTMLElement;

        if (existingChartSection) {
            existingChartSection.remove();
        }
        if (existingStatsSection) {
            existingStatsSection.remove();
        }

        // Clear content
        detailsContent.innerHTML = '';

        // Create each section
        const providerSection = createProviderStats(dateDetails.providers);
        const hourlyChartSection = createHourlyChart(dateDetails.hourlyStats, existingChartSection || undefined);
        const hourlySection = createHourlyStats(
            dateDetails.providers,
            dateDetails.hourlyStats,
            existingStatsSection || undefined
        );

        // Append to DOM
        detailsContent.appendChild(providerSection);
        detailsContent.appendChild(hourlyChartSection);
        detailsContent.appendChild(hourlySection);
    } else {
        const displayText2 = dateDetails?.date && isToday(dateDetails.date) ? 'Today' : dateDetails?.date || 'Today';
        detailsContent.innerHTML = '';
        detailsContent.appendChild(createEmptyContent(displayText2));
    }
}
