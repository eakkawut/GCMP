/**
 * Hourly Statistics Component
 * Responsible for rendering hourly usage statistics, including provider and model details
 */

import type { HourlyStats, ModelData, ProviderData } from '../types';
import { createElement } from '../../utils';
import {
    formatTokens,
    calculateAverageSpeed,
    calculateAverageFirstTokenLatency,
    getProviderDisplayName
} from '../utils';

// ============= Type Definitions =============

type ViewMode = 'hour' | 'provider' | 'model';

// Save the currently selected view mode
let currentViewMode: ViewMode = 'hour';

// ============= Helper Functions =============

/**
 * Create a statistics cell
 * @param value Cell value
 * @param isBold Whether to make bold
 * @returns HTMLTableCellElement
 */
function createStatCell(value: string, isBold: boolean = false): HTMLTableCellElement {
    const cell = createElement('td') as HTMLTableCellElement;
    if (isBold) {
        cell.innerHTML = `<strong>${value}</strong>`;
    } else {
        cell.textContent = value;
    }
    return cell;
}

/**
 * Append statistics cells to a row (input, cache, output, total, requests, latency, speed)
 * @param row Table row
 * @param stats Statistics data
 * @param isBold Whether to make bold
 */
function appendStatCells(
    row: HTMLTableRowElement,
    stats: ProviderData | ModelData | HourlyStats,
    isBold: boolean = false
): void {
    const totalTokens = stats.actualInput + stats.outputTokens;
    row.appendChild(createStatCell(formatTokens(stats.actualInput), isBold));
    row.appendChild(createStatCell(formatTokens(stats.cacheTokens), isBold));
    row.appendChild(createStatCell(formatTokens(stats.outputTokens), isBold));
    row.appendChild(createStatCell(formatTokens(totalTokens), isBold));
    row.appendChild(createStatCell(String(stats.requests), isBold));
    row.appendChild(createStatCell(calculateAverageFirstTokenLatency(stats), isBold));
    row.appendChild(createStatCell(calculateAverageSpeed(stats), isBold));
}

// ============= Component Rendering =============

/**
 * Create hour detail row (used in provider/model mode to display data for a specific hour)
 */
function createHourDetailRow(
    hour: string,
    stats: ProviderData | ModelData,
    isLast: boolean = false
): HTMLTableRowElement {
    const row = createElement('tr', 'hour-detail-row') as HTMLTableRowElement;

    const nameCell = createElement('td');
    const prefix = isLast ? '└─' : '├─';
    nameCell.innerHTML = `<span class="hour-detail"><strong>${prefix} ${String(hour).padStart(2, '0')}:00</strong></span>`;
    row.appendChild(nameCell);

    appendStatCells(row, stats, false);

    return row;
}

/**
 * Render table content
 */
function renderTable(
    tableContainer: HTMLElement,
    providers: ProviderData[],
    hourlyStats: Record<string, HourlyStats>,
    mode: ViewMode
): void {
    tableContainer.innerHTML = '';
    const table = createElement('table', 'hourly-stats-table');
    const thead = createElement('thead');
    const headerRow = createElement('tr');

    const headers = ['Time', 'Input Tokens', 'Cache Hit', 'Output Tokens', 'Consumed Tokens', 'Requests', 'Avg Latency', 'Avg Speed'];
    headers.forEach(h => {
        const th = createElement('th');
        th.textContent = h;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = createElement('tbody');

    if (mode === 'hour') {
        // Mode 1: Hourly list
        Object.entries(hourlyStats)
            .sort(([a], [b]) => Number(a) - Number(b))
            .forEach(([hour, stats]) => {
                if (stats.requests === 0) {
                    return;
                }

                const row = createElement('tr', 'hour-row') as HTMLTableRowElement;

                const timeCell = createElement('td');
                timeCell.innerHTML = `<strong>${String(hour).padStart(2, '0')}:00</strong>`;
                row.appendChild(timeCell);

                appendStatCells(row, stats, false);

                tbody.appendChild(row);
            });
    } else if (mode === 'provider') {
        // Mode 2: Group by provider
        providers.forEach(provider => {
            if (provider.requests === 0) {
                return;
            }

            const providerRow = createElement('tr', 'provider-row') as HTMLTableRowElement;
            const nameCell = createElement('td');
            nameCell.innerHTML = `<strong class="provider-name">📦 ${getProviderDisplayName(provider.providerKey, provider.providerName)}</strong>`;
            providerRow.appendChild(nameCell);

            appendStatCells(providerRow, provider, true);

            tbody.appendChild(providerRow);

            // Collect all hourly data for this provider
            const providerHourlyData: Array<[string, ProviderData]> = [];
            Object.entries(hourlyStats).forEach(([hour, stats]) => {
                if (!stats.providers) {
                    return;
                }
                // Lookup using providerKey
                const providerInHour = provider.providerKey ? stats.providers[provider.providerKey] : undefined;
                if (providerInHour && providerInHour.requests > 0) {
                    // Add providerKey field to convert to ProviderData type
                    providerHourlyData.push([hour, { ...providerInHour, providerKey: provider.providerKey }]);
                }
            });

            providerHourlyData.sort(([a], [b]) => Number(a) - Number(b));
            providerHourlyData.forEach(([hour, hourStats], index) => {
                const isLast = index === providerHourlyData.length - 1;
                tbody.appendChild(createHourDetailRow(hour, hourStats, isLast));
            });
        });
    } else if (mode === 'model') {
        // Mode 3: Group by provider -> model
        providers.forEach(provider => {
            if (provider.requests === 0) {
                return;
            }

            const providerRow = createElement('tr', 'provider-row') as HTMLTableRowElement;
            const nameCell = createElement('td');
            nameCell.innerHTML = `<strong class="provider-name">📦 ${getProviderDisplayName(provider.providerKey, provider.providerName)}</strong>`;
            providerRow.appendChild(nameCell);

            appendStatCells(providerRow, provider, true);

            tbody.appendChild(providerRow);

            const modelEntries = Object.entries(provider.models).sort(([, a], [, b]) => b.requests - a.requests);

            modelEntries.forEach(([modelId, modelData], modelIndex) => {
                if (modelData.requests === 0) {
                    return;
                }

                const isLastModel = modelIndex === modelEntries.length - 1;

                const modelRow = createElement('tr', 'model-row') as HTMLTableRowElement;
                const modelNameCell = createElement('td');
                const modelPrefix = isLastModel ? '└─' : '├─';
                modelNameCell.innerHTML = `<span class="model-name"><strong>${modelPrefix} 🔧 ${modelData.modelName}</strong></span>`;
                modelRow.appendChild(modelNameCell);

                appendStatCells(modelRow, modelData, true);

                tbody.appendChild(modelRow);

                const modelHourlyData: Array<[string, ModelData]> = [];
                Object.entries(hourlyStats).forEach(([hour, stats]) => {
                    if (!stats.providers) {
                        return;
                    }
                    const providerInHour = provider.providerKey ? stats.providers[provider.providerKey] : undefined;
                    if (providerInHour && providerInHour.models && providerInHour.models[modelId]) {
                        const modelStats = providerInHour.models[modelId];
                        if (modelStats.requests > 0) {
                            modelHourlyData.push([hour, modelStats]);
                        }
                    }
                });

                modelHourlyData.sort(([a], [b]) => Number(a) - Number(b));
                modelHourlyData.forEach(([hour, hourStats], hourIndex) => {
                    const isLastHour = hourIndex === modelHourlyData.length - 1;
                    const hourRow = createElement('tr', 'hour-detail-row model-hour-detail') as HTMLTableRowElement;

                    const hourNameCell = createElement('td');
                    const hourPrefix = isLastHour ? '└─' : '├─';
                    hourNameCell.innerHTML = `<span class="hour-detail"><strong>${hourPrefix} ${String(hour).padStart(2, '0')}:00</strong></span>`;
                    hourRow.appendChild(hourNameCell);

                    appendStatCells(hourRow, hourStats, false);

                    tbody.appendChild(hourRow);
                });
            });
        });
    }

    table.appendChild(tbody);
    tableContainer.appendChild(table);
}

/**
 * Create hourly statistics section
 * If container already exists, only update data; otherwise create a new component
 */
export function createHourlyStats(
    providers: ProviderData[],
    hourlyStats: Record<string, HourlyStats>,
    existingContainer?: HTMLElement
): HTMLElement {
    // If an existing container is provided, only update data
    if (existingContainer) {
        const tableContainer = existingContainer.querySelector('.table-container') as HTMLElement;
        if (tableContainer) {
            // Container exists, only update table data
            setTimeout(() => {
                renderTable(tableContainer, providers, hourlyStats, currentViewMode);
            }, 0);
            return existingContainer;
        }
    }

    // Create new container
    const section = createElement('section', 'hourly-stats-section');

    const h2 = createElement('h2');
    h2.textContent = 'Hourly Usage';
    section.appendChild(h2);

    if (!hourlyStats || Object.keys(hourlyStats).length === 0) {
        const empty = createElement('div', 'empty-message');
        empty.textContent = 'No hourly statistics data available';
        section.appendChild(empty);
        return section;
    }

    // Create toggle buttons
    const toggleContainer = createElement('div', 'stats-toggle-container');
    const hourButton = createElement('button', 'stats-toggle-button active');
    hourButton.textContent = '📊 Hourly';
    const providerButton = createElement('button', 'stats-toggle-button');
    providerButton.textContent = '📦 Provider';
    const modelButton = createElement('button', 'stats-toggle-button');
    modelButton.textContent = '🔧 Model';
    toggleContainer.appendChild(hourButton);
    toggleContainer.appendChild(providerButton);
    toggleContainer.appendChild(modelButton);
    section.appendChild(toggleContainer);

    // Create table container
    const tableContainer = createElement('div', 'table-container');

    // Initial render (using saved mode)
    renderTable(tableContainer, providers, hourlyStats, currentViewMode);

    section.appendChild(tableContainer);

    // Add toggle events
    setTimeout(() => {
        hourButton.onclick = () => {
            currentViewMode = 'hour';
            hourButton.classList.add('active');
            providerButton.classList.remove('active');
            modelButton.classList.remove('active');
            renderTable(tableContainer, providers, hourlyStats, 'hour');
        };

        providerButton.onclick = () => {
            currentViewMode = 'provider';
            providerButton.classList.add('active');
            hourButton.classList.remove('active');
            modelButton.classList.remove('active');
            renderTable(tableContainer, providers, hourlyStats, 'provider');
        };

        modelButton.onclick = () => {
            currentViewMode = 'model';
            modelButton.classList.add('active');
            hourButton.classList.remove('active');
            providerButton.classList.remove('active');
            renderTable(tableContainer, providers, hourlyStats, 'model');
        };
    }, 100);

    return section;
}
