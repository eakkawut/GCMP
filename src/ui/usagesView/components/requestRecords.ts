/**
 * Request Records Component
 * Responsible for rendering the request records table
 */

import type { ExtendedTokenRequestLog } from '../types';
import { createElement } from '../../utils';
import { formatTokens, getProviderDisplayName } from '../utils';

// ============= Global State =============

// Save current page number
let currentPage = 1;

// ============= Utility Functions =============

/**
 * Change page number (directly update DOM, without VS Code communication)
 */
export function changePage(page: number): void {
    if (!window.usagesState?.dateDetails?.records) {
        return;
    }

    // Update global page number
    currentPage = page;

    // Re-render request records section (using container reuse)
    const recordsContainer = document.querySelector('#records-container') as HTMLElement;
    if (recordsContainer) {
        createRequestRecordsSection(window.usagesState.dateDetails.records, currentPage, recordsContainer);
    }
}

/**
 * Create pagination component
 */
function createPagination(currentPage: number, totalPages: number, totalRecords: number): HTMLElement {
    const container = createElement('div', 'pagination');

    // Previous page button
    const prevBtn = createElement('button') as HTMLButtonElement;
    prevBtn.textContent = 'Previous';
    prevBtn.disabled = currentPage <= 1;
    prevBtn.onclick = () => {
        if (currentPage > 1) {
            changePage(currentPage - 1);
        }
    };
    container.appendChild(prevBtn);

    // Page 1 button (first page)
    const firstPageBtn = createElement('button') as HTMLButtonElement;
    firstPageBtn.textContent = '1';
    firstPageBtn.className = `page-number${currentPage === 1 ? ' active' : ''}`;
    firstPageBtn.onclick = () => {
        if (currentPage !== 1) {
            changePage(1);
        }
    };
    container.appendChild(firstPageBtn);

    // Page number buttons (middle section)
    const maxPages = 5;
    let startPage = Math.max(2, currentPage - Math.floor(maxPages / 2));
    const endPage = Math.min(totalPages - 1, startPage + maxPages - 1);

    // Adjust starting position
    if (endPage - startPage < maxPages - 1) {
        startPage = Math.max(2, endPage - maxPages + 1);
    }

    // Show leading ellipsis (if there's a gap between page 1 and the first displayed page number)
    if (startPage > 2) {
        const ellipsis = createElement('span');
        ellipsis.textContent = '...';
        container.appendChild(ellipsis);
    }

    for (let i = startPage; i <= endPage; i++) {
        const pageBtn = createElement('button') as HTMLButtonElement;
        pageBtn.textContent = String(i);
        pageBtn.className = `page-number${i === currentPage ? ' active' : ''}`;
        pageBtn.onclick = () => {
            if (i !== currentPage) {
                changePage(i);
            }
        };
        container.appendChild(pageBtn);
    }

    // Show trailing ellipsis (if there's a gap between the last displayed page number and the last page)
    if (endPage < totalPages - 1) {
        const ellipsis = createElement('span');
        ellipsis.textContent = '...';
        container.appendChild(ellipsis);
    }

    // Last page button (last page) - only shown when totalPages > 1
    if (totalPages > 1) {
        const lastPageBtn = createElement('button') as HTMLButtonElement;
        lastPageBtn.textContent = String(totalPages);
        lastPageBtn.className = `page-number${currentPage === totalPages ? ' active' : ''}`;
        lastPageBtn.onclick = () => {
            if (currentPage !== totalPages) {
                changePage(totalPages);
            }
        };
        container.appendChild(lastPageBtn);
    }

    // Next page button
    const nextBtn = createElement('button') as HTMLButtonElement;
    nextBtn.textContent = 'Next';
    nextBtn.disabled = currentPage >= totalPages;
    nextBtn.onclick = () => {
        if (currentPage < totalPages) {
            changePage(currentPage + 1);
        }
    };
    container.appendChild(nextBtn);

    // Page info
    const info = createElement('span', 'pagination-info');
    const start = (currentPage - 1) * 20 + 1;
    const end = Math.min(currentPage * 20, totalRecords);
    info.textContent = `${start}-${end} / ${totalRecords}`;
    container.appendChild(info);

    return container;
}

// ============= Component Rendering =============

/**
 * Create request records table
 */
function createRequestRecordsTable(records: ExtendedTokenRequestLog[]): HTMLElement {
    const table = createElement('table', 'records-table');

    // Table header
    const thead = createElement('thead');
    const headerRow = createElement('tr');

    const headers = [
        'Time',
        'Provider',
        'Model',
        'Input Tokens',
        'Cache Hit',
        'Output Tokens',
        'Consumed Tokens',
        'First Token Latency + Output Duration',
        'Output Speed',
        'Status'
    ];
    headers.forEach(h => {
        const th = createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Table body
    const tbody = createElement('tbody');

    if (records && records.length > 0) {
        records.forEach(record => {
            const row = createElement('tr');

            const time = createElement('td');
            if (record.timestamp) {
                try {
                    const date = new Date(record.timestamp);
                    time.textContent = date.toLocaleTimeString();
                } catch {
                    time.textContent = '-';
                }
            } else {
                time.textContent = '-';
            }

            const provider = createElement('td');
            provider.textContent = getProviderDisplayName(record.providerKey, record.providerName) || '-';

            const model = createElement('td');
            model.textContent = record.modelName || '-';

            const input = createElement('td');
            // Decide whether to display actual value or estimate based on status
            if (record.status === 'completed' && record.rawUsage && record.totalTokens > 0) {
                // Completed status with actual value: display actual value
                input.textContent = formatTokens(record.actualInput);
            } else {
                // Estimate or failed status or no actual value: display estimate (with ~ prefix), otherwise display '-'
                if (record.estimatedInput !== undefined && record.estimatedInput > 0) {
                    input.textContent = `~${formatTokens(record.estimatedInput)}`;
                } else {
                    input.textContent = '-';
                }
            }

            const cache = createElement('td');
            if (record.status === 'completed' && record.cacheReadTokens > 0) {
                cache.textContent = formatTokens(record.cacheReadTokens);
            } else {
                cache.textContent = '-';
            }

            const output = createElement('td');
            if (record.status === 'completed' && record.outputTokens > 0) {
                output.textContent = formatTokens(record.outputTokens);
            } else {
                output.textContent = '-';
            }

            const total = createElement('td');
            if (record.status === 'completed' && record.totalTokens > 0) {
                total.textContent = formatTokens(record.totalTokens);
            } else {
                total.textContent = '-';
            }

            const firstTokenLatency = createElement('td');
            // Prioritize using streamDuration (already calculated duration)
            if (record.streamDuration !== undefined && record.streamDuration > 0) {
                let durationStr: string;
                if (record.streamDuration >= 1000) {
                    durationStr = `<span>${(record.streamDuration / 1000).toFixed(1)}s</span>`;
                } else {
                    durationStr = `<span>${Math.round(record.streamDuration)}ms</span>`;
                }
                // Only display when both first token latency and timestamp are available
                if (record.streamStartTime !== undefined && record.timestamp !== undefined) {
                    const latency = record.streamStartTime - record.timestamp;
                    if (Number.isFinite(latency) && latency >= 0) {
                        let latencyStr: string;
                        if (latency >= 1000) {
                            latencyStr = `<span>${(latency / 1000).toFixed(1)}s</span>`;
                        } else {
                            latencyStr = `<span>${Math.round(latency)}ms</span>`;
                        }
                        firstTokenLatency.innerHTML = latencyStr + ' + ' + durationStr;
                    } else {
                        firstTokenLatency.innerHTML = '- + ' + durationStr;
                    }
                } else {
                    // Only duration, no first token latency
                    firstTokenLatency.innerHTML = '- + ' + durationStr;
                }
            } else {
                firstTokenLatency.textContent = '-';
            }

            const status = createElement('td');
            status.className = record.status === 'completed' ? 'status-completed' : '';
            status.textContent = record.status === 'completed' ? '✅' : record.status === 'failed' ? '❌' : '⏳';

            const speed = createElement('td');
            if (record.outputSpeed !== undefined && record.outputSpeed > 0) {
                speed.textContent = `${record.outputSpeed.toFixed(1)} t/s`;
            } else {
                speed.textContent = '-';
            }

            row.appendChild(time);
            row.appendChild(provider);
            row.appendChild(model);
            row.appendChild(input);
            row.appendChild(cache);
            row.appendChild(output);
            row.appendChild(total);
            row.appendChild(firstTokenLatency);
            row.appendChild(speed);
            row.appendChild(status);
            tbody.appendChild(row);
        });
    } else {
        const emptyRow = createElement('tr');
        const emptyCell = createElement('td', '', { colSpan: 10 });
        emptyCell.textContent = 'No request records available';
        emptyCell.style.textAlign = 'center';
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
    }

    table.appendChild(tbody);

    return table;
}

/**
 * Create request records section
 * @param records All request records
 * @param page Current page number (optional, uses saved page number if not provided)
 * @param existingContainer Existing container (for reuse, to avoid flickering)
 */
export function createRequestRecordsSection(
    records: ExtendedTokenRequestLog[],
    page?: number,
    existingContainer?: HTMLElement
): HTMLElement {
    // If page number is provided, update global page number; otherwise use saved page number
    if (page !== undefined) {
        currentPage = page;
    }

    // If existing container is provided, reuse it directly
    if (existingContainer) {
        existingContainer.innerHTML = '';
        const wrapper = createElement('div');

        const totalRecords = records.length;
        const totalPages = Math.ceil(totalRecords / 20) || 1;

        // Ensure current page number is within valid range
        if (currentPage > totalPages) {
            currentPage = Math.max(1, totalPages);
        }

        // Pagination component
        const paginationTop = createPagination(currentPage, totalPages, totalRecords);
        wrapper.appendChild(paginationTop);

        // Table
        const startIndex = (currentPage - 1) * 20;
        const endIndex = Math.min(startIndex + 20, totalRecords);
        const pageRecords = records.slice(startIndex, endIndex);
        wrapper.appendChild(createRequestRecordsTable(pageRecords));

        // Pagination component (bottom)
        const paginationBottom = createPagination(currentPage, totalPages, totalRecords);
        wrapper.appendChild(paginationBottom);

        existingContainer.appendChild(wrapper);
        return existingContainer;
    }

    // Create new container
    const section = createElement('div');
    section.id = 'records-container';

    const wrapper = createElement('div');

    const totalRecords = records.length;
    const totalPages = Math.ceil(totalRecords / 20) || 1;

    // Ensure current page number is within valid range
    if (currentPage > totalPages) {
        currentPage = Math.max(1, totalPages);
    }

    // Pagination component
    const paginationTop = createPagination(currentPage, totalPages, totalRecords);
    wrapper.appendChild(paginationTop);

    // Table
    const startIndex = (currentPage - 1) * 20;
    const endIndex = Math.min(startIndex + 20, totalRecords);
    const pageRecords = records.slice(startIndex, endIndex);
    wrapper.appendChild(createRequestRecordsTable(pageRecords));

    // Pagination component (bottom)
    const paginationBottom = createPagination(currentPage, totalPages, totalRecords);
    wrapper.appendChild(paginationBottom);

    section.appendChild(wrapper);

    return section;
}
