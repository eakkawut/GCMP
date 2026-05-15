/**
 * UsagesView Native TypeScript Entry
 */

import './style.less';
import 'chart.js/auto'; // Import Chart.js

import type { HostMessage, State } from './types';
import { getTodayDateString, postToVSCode } from './utils';
import { createElement } from '../utils';

// Import components
import { createSidebar, updateDateList } from './components/dateList';
import { createMainContent, updateMainContent } from './components/mainContent';
import { createRequestRecordsSection } from './components/requestRecords';

// ============= Global State Management =============

/**
 * Global state
 */
const state: State = {
    selectedDate: '',
    today: '',
    dateList: [],
    dateDetails: null,
    loading: {
        dateDetails: false
    }
};

// Track previous date for detecting date changes
let lastDateDetailsDate: string | null = null;

/**
 * State listener list
 */
const listeners: ((state: State) => void)[] = [];

/**
 * Set state and notify listeners
 */
function setState(newState: Partial<State>): void {
    Object.assign(state, newState);
    listeners.forEach(listener => listener(state));

    // If loading state is updated, synchronously update overlay
    if (newState.loading) {
        updateLoadingOverlay();
    }
}

/**
 * Subscribe to state changes
 */
function subscribeState(listener: (state: State) => void): () => void {
    listeners.push(listener);
    return () => {
        const index = listeners.indexOf(listener);
        if (index > -1) {
            listeners.splice(index, 1);
        }
    };
}

/**
 * Set loading state
 */
function setLoading(type: 'dateDetails', isLoading: boolean): void {
    setState({
        loading: {
            ...state.loading,
            [type]: isLoading
        }
    });

    // Update loading-overlay display state
    updateLoadingOverlay();
}

/**
 * Update loading overlay display state
 */
function updateLoadingOverlay(): void {
    let overlay = document.getElementById('loading-overlay');

    // Create if loading needed but overlay doesn't exist
    const isLoading = state.loading.dateDetails;

    if (isLoading) {
        if (!overlay) {
            overlay = createElement('div', 'loading-overlay');
            overlay.id = 'loading-overlay';

            const content = createElement('div', 'loading-content');
            const spinner = createElement('div', 'loading-spinner');
            const text = createElement('div', 'loading-text');
            text.textContent = 'Loading...';

            content.appendChild(spinner);
            content.appendChild(text);
            overlay.appendChild(content);
            document.body.appendChild(overlay);
        }

        // Use setTimeout to ensure DOM updates before adding visible class
        setTimeout(() => {
            overlay?.classList.add('visible');
        }, 0);
    } else {
        // Hide and remove overlay
        if (overlay) {
            overlay.classList.remove('visible');
            setTimeout(() => {
                overlay?.remove();
            }, 200); // Wait for transition animation to complete
        }
    }
}

/**
 * Handle messages from VSCode
 */
function handleVSCodeMessage(event: MessageEvent): void {
    const message = event.data as HostMessage;
    console.log('[UsagesView] Received message:', message.command, message);

    switch (message.command) {
        case 'updateDateList':
            setState({
                dateList: message.dateList,
                selectedDate: message.selectedDate || state.selectedDate,
                today: message.today || getTodayDateString()
            });
            break;

        case 'updateDateDetails':
            setState({
                dateDetails: {
                    date: message.date,
                    isToday: message.isToday,
                    providers: message.providers,
                    hourlyStats: message.hourlyStats,
                    records: message.records
                },
                loading: {
                    ...state.loading,
                    dateDetails: false
                }
            });

            // For small screen mode, auto-hide sidebar after date switch
            if (window.innerWidth <= 768) {
                toggleSidebar(false);
            }
            break;
    }
}

// ============= View Updates =============

/**
 * Update request records
 */
function updateRequestRecords(): void {
    // Find request records container, create if not exists
    let recordsSection = document.querySelector('#records-section')?.parentElement;
    if (!recordsSection) {
        const content = document.querySelector('.content');
        if (content) {
            recordsSection = createElement('section');
            const h2 = createElement('h2', '', { id: 'records-section' });
            h2.textContent = 'Request Records';
            const container = createElement('div', '', { id: 'records-container' });
            recordsSection.appendChild(h2);
            recordsSection.appendChild(container);
            content.appendChild(recordsSection);
        }
    }

    if (recordsSection) {
        const existingContainer = recordsSection.querySelector('#records-container') as HTMLElement;
        if (existingContainer && state.dateDetails) {
            // Detect if date changed
            const dateChanged = lastDateDetailsDate !== state.dateDetails.date;
            lastDateDetailsDate = state.dateDetails.date;

            // Reset page number if date changed; otherwise keep current page
            const page = dateChanged ? 1 : undefined;

            // Use container reuse
            createRequestRecordsSection(
                state.dateDetails.records,
                page, // Reset page number on date change, otherwise keep current page
                existingContainer
            );
        }
    }
}

/**
 * Refresh all views
 */
function refreshViews(): void {
    console.log('[UsagesView] State change:', {
        state,
        selectedDate: state.selectedDate,
        dateListLength: state.dateList.length,
        hasDetails: !!state.dateDetails
    });
    updateDateList(state.dateList);
    updateMainContent();
    updateRequestRecords();
}

// ============= Main Application =============

/**
 * Toggle sidebar show/hide
 */
function toggleSidebar(show?: boolean): void {
    const sidebar = document.querySelector('.sidebar') as HTMLElement;
    const content = document.querySelector('.content') as HTMLElement;
    const toggleBtn = document.querySelector('.sidebar-toggle') as HTMLElement;

    if (!sidebar || !content) {
        return;
    }

    const isHidden = sidebar.classList.contains('hidden');
    const shouldShow = show !== undefined ? show : isHidden;

    if (shouldShow) {
        sidebar.classList.remove('hidden');
        content.classList.add('sidebar-open');
        if (toggleBtn) {
            toggleBtn.innerHTML = '<span class="toggle-icon">◀</span> Collapse List';
        }
        // Create overlay
        createOrUpdateOverlay();
    } else {
        sidebar.classList.add('hidden');
        content.classList.remove('sidebar-open');
        if (toggleBtn) {
            toggleBtn.innerHTML = '<span class="toggle-icon">☰</span> Date List';
        }
        // Remove overlay
        removeOverlay();
    }
}

/**
 * Create or update overlay
 */
function createOrUpdateOverlay(): void {
    let overlay = document.getElementById('sidebar-overlay');
    if (!overlay) {
        overlay = createElement('div', 'sidebar-overlay');
        overlay.id = 'sidebar-overlay';
        // Click overlay to close sidebar
        overlay.onclick = () => toggleSidebar(false);
        document.body.appendChild(overlay);
    }
}

/**
 * Remove overlay
 */
function removeOverlay(): void {
    const overlay = document.getElementById('sidebar-overlay');
    if (overlay) {
        overlay.remove();
    }
}

/**
 * Create sidebar toggle button
 */
function createSidebarToggle(): HTMLElement {
    const button = createElement('button', 'sidebar-toggle');
    button.innerHTML = '<span class="toggle-icon">☰</span> Date';
    button.onclick = () => toggleSidebar();
    return button;
}

/**
 * Initialize application
 */
function initApp(): void {
    console.log('[UsagesView] Initializing native JS application');

    // Attach state and utility functions to window object for all components to access
    window.usagesState = state;
    window.usagesSetLoading = setLoading;

    // Create main container
    const container = createElement('div', 'container');
    container.id = 'usages-view-container';

    // Create sidebar and main content area
    const sidebar = createSidebar();
    const mainContent = createMainContent();

    container.appendChild(sidebar);
    container.appendChild(mainContent);

    // Add to document
    document.body.innerHTML = '';
    document.body.appendChild(container);

    // Add sidebar toggle button
    const content = document.querySelector('.content');
    if (content) {
        const toggleBtn = createSidebarToggle();
        content.insertBefore(toggleBtn, content.firstChild);
    }

    // Check window width, hide sidebar by default if less than 768px
    if (window.innerWidth <= 768) {
        toggleSidebar(false);
    }

    // Listen for window resize events
    window.addEventListener('resize', () => {
        const sidebar = document.querySelector('.sidebar') as HTMLElement;
        if (!sidebar) {
            return;
        }

        if (window.innerWidth <= 768) {
            // On small screens, hide sidebar by default
            if (!sidebar.classList.contains('hidden')) {
                toggleSidebar(false);
            }
        } else {
            // On large screens, show sidebar by default and remove overlay
            if (sidebar.classList.contains('hidden')) {
                sidebar.classList.remove('hidden');
                const content = document.querySelector('.content') as HTMLElement;
                const toggleBtn = document.querySelector('.sidebar-toggle') as HTMLElement;
                if (content) {
                    content.classList.remove('sidebar-open');
                }
                if (toggleBtn) {
                    toggleBtn.innerHTML = '<span class="toggle-icon">☰</span> Date';
                }
            }
            // Ensure overlay is removed
            removeOverlay();
        }
    });

    // Set today's date
    state.today = getTodayDateString();

    // Subscribe to state changes
    subscribeState(() => refreshViews());

    // Register message listener
    window.addEventListener('message', handleVSCodeMessage);

    // Request initial data
    postToVSCode({ command: 'getInitialData' });
}

// ============= Startup =============

// Start application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
