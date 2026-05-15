/**
 * Date List Component
 * Responsible for rendering and interacting with the left-side date list
 */

import { DateSummary } from '../types';
import { formatTokens, postToVSCode } from '../utils';
import { createElement } from '../../utils';

// ============= Utility Functions =============

/**
 * Open storage directory
 */
function openStorageDir(): void {
    postToVSCode({ command: 'openStorageDir' });
}

// ============= Component Rendering =============

function createDateListItem(summary: DateSummary): HTMLElement {
    const item = createElement('div', 'date-item');
    item.dataset.date = summary.date;

    const isSelected = window.usagesState?.selectedDate === summary.date;
    const isDateToday = summary.date === window.usagesState?.today;
    const displayDate = isDateToday ? `Today (${summary.date})` : summary.date;
    const totalTokens = summary.total_input + summary.total_output;

    if (isSelected) {
        item.classList.add('selected');
    }

    const inner = createElement('div');
    inner.onclick = () => {
        if (window.usagesState) {
            console.log('selectDate:', summary.date, 'current:', window.usagesState.selectedDate);
            window.usagesState.selectedDate = summary.date;
        }
        // Set loading state
        if (window.usagesSetLoading) {
            window.usagesSetLoading('dateDetails', true);
        }
        postToVSCode({ command: 'selectDate', date: summary.date });
    };

    const title = createElement('div', isDateToday ? 'date-item-title today' : 'date-item-title');
    title.textContent = displayDate;

    const stats = createElement('div', 'date-item-stats');
    stats.textContent = `Requests: ${summary.total_requests} | Tokens: ${formatTokens(totalTokens)}`;

    inner.appendChild(title);
    inner.appendChild(stats);

    item.appendChild(inner);

    return item;
}

export function createSidebar(): HTMLElement {
    const sidebar = createElement('div', 'sidebar');

    // Sidebar header
    const header = createElement('div', 'sidebar-header');
    const headerTop = createElement('div', 'sidebar-header-top');
    const h1 = createElement('h1');
    h1.textContent = 'Token Consumption Statistics';
    const openBtn = createElement('button', 'open-storage-button');
    openBtn.textContent = '📁';
    openBtn.title = 'Open Storage Directory';
    openBtn.onclick = openStorageDir;
    headerTop.appendChild(h1);
    headerTop.appendChild(openBtn);
    header.appendChild(headerTop);

    // Date list container
    const dateListContainer = createElement('div', 'date-list');
    dateListContainer.id = 'date-list';

    sidebar.appendChild(header);
    sidebar.appendChild(dateListContainer);

    return sidebar;
}

export function updateDateList(dateList: DateSummary[]): void {
    const dateListEl = document.getElementById('date-list');
    if (!dateListEl) {
        return;
    }

    const existingItems = dateListEl.children;
    const firstItem = existingItems[0] as HTMLElement;
    const firstItemDate = firstItem?.dataset.date;

    // Check if full re-render is needed
    const needsFullRender = existingItems.length !== dateList.length || firstItemDate !== dateList[0]?.date;

    if (needsFullRender) {
        // Full re-render
        dateListEl.innerHTML = '';
        dateList.forEach(summary => {
            dateListEl.appendChild(createDateListItem(summary));
        });
    } else {
        // Differential update: update the first element's content
        if (existingItems.length > 0 && dateList.length > 0) {
            const todaySummary = dateList[0];
            firstItem.dataset.date = todaySummary.date;
            firstItem.classList.toggle('selected', window.usagesState?.selectedDate === todaySummary.date);

            const title = firstItem.querySelector('.date-item-title') as HTMLElement;
            const stats = firstItem.querySelector('.date-item-stats') as HTMLElement;
            const totalTokens = todaySummary.total_input + todaySummary.total_output;

            if (title) {
                const isToday = todaySummary.date === window.usagesState?.today;
                title.textContent = isToday ? `Today (${todaySummary.date})` : todaySummary.date;
                title.className = isToday ? 'date-item-title today' : 'date-item-title';
            }
            if (stats) {
                stats.textContent = `Requests: ${todaySummary.total_requests} | Tokens: ${formatTokens(totalTokens)}`;
            }
        }

        // Update selection highlight for all items
        Array.from(existingItems).forEach(item => {
            const el = item as HTMLElement;
            const date = el.dataset.date;
            el.classList.toggle('selected', date === window.usagesState?.selectedDate);
        });
    }
}
