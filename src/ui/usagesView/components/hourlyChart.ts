/*---------------------------------------------------------------------------------------------
 *  Hourly Statistics Chart Component
 *  Uses Chart.js to display provider performance metric trends
 *--------------------------------------------------------------------------------------------*/

import type { HourlyStats } from '../types';
import { createElement } from '../../utils';
import { getProviderDisplayName } from '../utils';
import { Chart } from 'chart.js/auto';

// Save chart instance references to avoid flickering from repeated creation
let speedChartInstance: Chart | null = null;
let latencyChartInstance: Chart | null = null;

/**
 * Create or update hourly statistics chart (includes three sub-charts)
 * If container already exists, only update data; otherwise create a new chart
 */
export function createHourlyChart(
    hourlyStats: Record<string, HourlyStats>,
    existingContainer?: HTMLElement
): HTMLElement {
    // If an existing container is provided, only update data
    if (existingContainer) {
        const speedCanvas = existingContainer.querySelector('#speed-chart') as HTMLCanvasElement;
        const latencyCanvas = existingContainer.querySelector('#latency-chart') as HTMLCanvasElement;

        if (speedCanvas && latencyCanvas) {
            // Container exists, only update chart data
            setTimeout(() => {
                initSpeedChart(speedCanvas, hourlyStats);
                initLatencyChart(latencyCanvas, hourlyStats);
            }, 0);
            return existingContainer;
        }
    }

    // Create new container
    const section = createElement('section', 'hourly-chart-section');

    const h2 = createElement('h2');
    h2.textContent = '📊 Provider Performance Metrics Trend';
    section.appendChild(h2);

    if (!hourlyStats || Object.keys(hourlyStats).length === 0) {
        const empty = createElement('div', 'empty-message');
        empty.textContent = 'No hourly statistics data available';
        section.appendChild(empty);
        return section;
    }

    // Check if there is valid data (hours containing speed-related data)
    // Old data may not have speed fields, needs filtering
    const validHoursCount = Object.values(hourlyStats).filter(stats => {
        if (!stats.providers || Object.keys(stats.providers).length === 0) {
            return false;
        }
        // Check if any provider contains speed-related data
        return Object.values(stats.providers).some(provider => provider.outputSpeeds || provider.firstTokenLatency);
    }).length;

    if (validHoursCount < 1) {
        const empty = createElement('div', 'empty-message');
        empty.textContent = 'No valid speed data available';
        section.appendChild(empty);
        return section;
    }

    // Create toggle buttons
    const toggleContainer = createElement('div', 'chart-toggle-container');
    const speedButton = createElement('button', 'chart-toggle-button active');
    speedButton.textContent = '⚡ Speed';
    const latencyButton = createElement('button', 'chart-toggle-button');
    latencyButton.textContent = '⏱️ Latency';
    toggleContainer.appendChild(speedButton);
    toggleContainer.appendChild(latencyButton);
    section.appendChild(toggleContainer);

    // Create two independent chart containers
    const chartsWrapper = createElement('div', 'charts-wrapper');

    // 1. Output speed chart
    const speedSection = createElement('div', 'chart-item chart-visible');
    const speedTitle = createElement('h3');
    speedTitle.textContent = '⚡ Average Output Speed (tokens/sec)';
    speedSection.appendChild(speedTitle);
    const speedContainer = createElement('div', 'chart-container');
    const speedCanvas = createElement('canvas', 'speed-chart') as HTMLCanvasElement;
    speedCanvas.id = 'speed-chart'; // Add id for later lookup
    speedContainer.appendChild(speedCanvas);
    speedSection.appendChild(speedContainer);
    chartsWrapper.appendChild(speedSection);

    // 2. Latency chart
    const latencySection = createElement('div', 'chart-item chart-hidden');
    const latencyTitle = createElement('h3');
    latencyTitle.textContent = '⏱️ Average First Token Latency (milliseconds)';
    latencySection.appendChild(latencyTitle);
    const latencyContainer = createElement('div', 'chart-container');
    const latencyCanvas = createElement('canvas', 'latency-chart') as HTMLCanvasElement;
    latencyCanvas.id = 'latency-chart'; // Add id for later lookup
    latencyContainer.appendChild(latencyCanvas);
    latencySection.appendChild(latencyContainer);
    chartsWrapper.appendChild(latencySection);

    section.appendChild(chartsWrapper);

    // Delay chart initialization (ensure DOM is rendered)
    setTimeout(() => {
        initSpeedChart(speedCanvas, hourlyStats);
        initLatencyChart(latencyCanvas, hourlyStats);

        // Add toggle events
        speedButton.onclick = () => {
            speedButton.classList.add('active');
            latencyButton.classList.remove('active');
            speedSection.classList.remove('chart-hidden');
            speedSection.classList.add('chart-visible');
            latencySection.classList.remove('chart-visible');
            latencySection.classList.add('chart-hidden');
        };

        latencyButton.onclick = () => {
            latencyButton.classList.add('active');
            speedButton.classList.remove('active');
            latencySection.classList.remove('chart-hidden');
            latencySection.classList.add('chart-visible');
            speedSection.classList.remove('chart-visible');
            speedSection.classList.add('chart-hidden');
        };
    }, 100);

    return section;
}

/**
 * Calculate average first token latency
 */
function calcFirstTokenLatency(stats: { firstTokenLatency?: number }): number {
    if (!stats.firstTokenLatency || stats.firstTokenLatency <= 0) {
        return 0;
    }
    return stats.firstTokenLatency; // milliseconds
}

/**
 * Initialize output speed chart
 */
function initSpeedChart(canvas: HTMLCanvasElement, hourlyStats: Record<string, HourlyStats>): void {
    const hourKeys = Object.keys(hourlyStats).sort((a, b) => {
        const hourA = parseInt(a, 10);
        const hourB = parseInt(b, 10);
        return hourA - hourB;
    });

    const hours = hourKeys.map(h => parseInt(h, 10));

    // Map structure: providerId -> { name: string, data: Map<hour, value> }
    const providerMap = new Map<string, { name: string; data: Map<number, number> }>();

    hourKeys.forEach(hourKey => {
        const stats = hourlyStats[hourKey];
        if (stats && stats.providers) {
            const hour = parseInt(hourKey, 10);
            Object.entries(stats.providers).forEach(([providerId, providerStats]) => {
                // Use providerId as unique identifier to avoid merging providers with the same name
                if (!providerMap.has(providerId)) {
                    providerMap.set(providerId, {
                        name: getProviderDisplayName(providerId, providerStats.providerName),
                        data: new Map()
                    });
                }
                const outputSpeed =
                    providerStats.outputSpeeds && providerStats.outputSpeeds > 0 ? providerStats.outputSpeeds : 0;
                providerMap.get(providerId)!.data.set(hour, outputSpeed);
            });
        }
    });

    const datasets = createDatasetsFromMap(providerMap, hours);

    // Check if existing chart instance is valid (canvas still in DOM)
    if (speedChartInstance && speedChartInstance.canvas === canvas) {
        updateChartData(speedChartInstance, hours, datasets);
    } else {
        // If canvas doesn't match, destroy old instance and create new chart
        if (speedChartInstance) {
            speedChartInstance.destroy();
            speedChartInstance = null;
        }
        speedChartInstance = createSingleChart(canvas, hours, datasets, 'Output Speed (tokens/sec)', 'tokens/sec');
    }
}

/**
 * Initialize latency chart
 */
function initLatencyChart(canvas: HTMLCanvasElement, hourlyStats: Record<string, HourlyStats>): void {
    const hourKeys = Object.keys(hourlyStats).sort((a, b) => {
        const hourA = parseInt(a, 10);
        const hourB = parseInt(b, 10);
        return hourA - hourB;
    });

    const hours = hourKeys.map(h => parseInt(h, 10));

    // Map structure: providerId -> { name: string, data: Map<hour, value> }
    const providerMap = new Map<string, { name: string; data: Map<number, number> }>();

    hourKeys.forEach(hourKey => {
        const stats = hourlyStats[hourKey];
        if (stats && stats.providers) {
            const hour = parseInt(hourKey, 10);
            Object.entries(stats.providers).forEach(([providerId, providerStats]) => {
                // Use providerId as unique identifier to avoid merging providers with the same name
                if (!providerMap.has(providerId)) {
                    providerMap.set(providerId, {
                        name: getProviderDisplayName(providerId, providerStats.providerName),
                        data: new Map()
                    });
                }
                const latency = calcFirstTokenLatency(providerStats);
                providerMap.get(providerId)!.data.set(hour, latency);
            });
        }
    });

    const datasets = createDatasetsFromMap(providerMap, hours);

    // Check if existing chart instance is valid (canvas still in DOM)
    if (latencyChartInstance && latencyChartInstance.canvas === canvas) {
        updateChartData(latencyChartInstance, hours, datasets);
    } else {
        // If canvas doesn't match, destroy old instance and create new chart
        if (latencyChartInstance) {
            latencyChartInstance.destroy();
            latencyChartInstance = null;
        }
        latencyChartInstance = createSingleChart(canvas, hours, datasets, 'First Token Latency (milliseconds)', 'milliseconds');
    }
}

/**
 * Create datasets from data map
 */
function createDatasetsFromMap(
    providerMap: Map<string, { name: string; data: Map<number, number> }>,
    hours: number[]
): Array<{
    label: string;
    data: (number | null)[];
    borderColor: string;
    backgroundColor: string;
    tension: number;
    borderWidth: number;
    pointRadius: number;
    pointHoverRadius: number;
}> {
    const datasets: Array<{
        label: string;
        data: (number | null)[];
        borderColor: string;
        backgroundColor: string;
        tension: number;
        borderWidth: number;
        pointRadius: number;
        pointHoverRadius: number;
    }> = [];

    const providerColors = [
        { border: 'rgb(59, 130, 246)', bg: 'rgba(59, 130, 246, 0.1)' }, // Blue
        { border: 'rgb(34, 197, 94)', bg: 'rgba(34, 197, 94, 0.1)' }, // Green
        { border: 'rgb(249, 115, 22)', bg: 'rgba(249, 115, 22, 0.1)' }, // Orange
        { border: 'rgb(234, 179, 8)', bg: 'rgba(234, 179, 8, 0.1)' }, // Yellow
        { border: 'rgb(20, 184, 166)', bg: 'rgba(20, 184, 166, 0.1)' }, // Cyan
        { border: 'rgb(139, 92, 246)', bg: 'rgba(139, 92, 246, 0.1)' }, // Violet
        { border: 'rgb(6, 182, 212)', bg: 'rgba(6, 182, 212, 0.1)' }, // Light Blue
        { border: 'rgb(132, 204, 22)', bg: 'rgba(132, 204, 22, 0.1)' }, // Lime
        { border: 'rgb(99, 102, 241)', bg: 'rgba(99, 102, 241, 0.1)' }, // Indigo
        { border: 'rgb(21, 128, 61)', bg: 'rgba(21, 128, 61, 0.1)' }, // Dark Green
        { border: 'rgb(124, 45, 18)', bg: 'rgba(124, 45, 18, 0.1)' }, // Brown
        { border: 'rgb(107, 114, 128)', bg: 'rgba(107, 114, 128, 0.1)' }, // Gray
        { border: 'rgb(128, 0, 128)', bg: 'rgba(128, 0, 128, 0.1)' }, // Purple
        { border: 'rgb(0, 100, 0)', bg: 'rgba(0, 100, 0, 0.1)' }, // Dark Green
        { border: 'rgb(70, 130, 180)', bg: 'rgba(70, 130, 180, 0.1)' } // Steel Blue
    ];

    let colorIndex = 0;
    providerMap.forEach((providerInfo, _providerId) => {
        const { name: providerName, data: hourData } = providerInfo;
        const data = hours.map(hour => {
            const value = hourData.get(hour) || 0;
            return value > 0 ? value : null; // null will make Chart.js skip this point and connect adjacent valid points
        });

        if (data.some(v => v !== null && v > 0)) {
            const color = providerColors[colorIndex % providerColors.length];
            datasets.push({
                label: providerName, // Use friendly name as display label
                data: data,
                borderColor: color.border,
                backgroundColor: color.bg,
                tension: 0.3,
                borderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6
            });
            colorIndex++;
        }
    });

    datasets.sort((a, b) => {
        const sumA = a.data.reduce((s: number, v) => s + (v || 0), 0);
        const sumB = b.data.reduce((s: number, v) => s + (v || 0), 0);
        return sumB - sumA;
    });

    return datasets;
}

/**
 * Update chart data
 */
function updateChartData(
    chart: Chart,
    hours: number[],
    datasets: Array<{
        label: string;
        data: (number | null)[];
        borderColor: string;
        backgroundColor: string;
        tension: number;
        borderWidth: number;
        pointRadius: number;
        pointHoverRadius: number;
    }>
): void {
    const labels = hours.map(h => `${String(h).padStart(2, '0')}:00`);

    // Set different point styles based on chart type
    // Determine chart type by checking canvas id
    const canvasId = chart.canvas.id;
    const isSpeedChart = canvasId === 'speed-chart';
    const pointStyle = isSpeedChart ? 'circle' : 'rectRot';

    chart.data.labels = labels;
    chart.data.datasets = datasets.map(ds => ({
        ...ds,
        pointStyle: pointStyle
    }));

    // Use 'none' mode: disable animation, update immediately
    chart.update('none');
}

/**
 * Create single chart
 */
function createSingleChart(
    canvas: HTMLCanvasElement,
    hours: number[],
    datasets: Array<{
        label: string;
        data: (number | null)[];
        borderColor: string;
        backgroundColor: string;
        tension: number;
        borderWidth: number;
        pointRadius: number;
        pointHoverRadius: number;
    }>,
    yAxisTitle: string,
    unit: string
): Chart {
    const labels = hours.map(h => `${String(h).padStart(2, '0')}:00`);

    // Set different point styles based on chart type
    const isSpeedChart = unit === 'tokens/sec';
    const pointStyle = isSpeedChart ? 'circle' : 'rectRot';

    const chart = new Chart(canvas, {
        type: 'line',
        data: {
            labels: labels,
            datasets: datasets.map(ds => ({
                ...ds,
                pointStyle: pointStyle
            }))
        },
        options: {
            responsive: true,
            maintainAspectRatio: false, // Disable auto aspect ratio, use fixed height
            animation: false, // Disable all animations
            spanGaps: true, // Automatically skip null values and connect adjacent valid data points
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        usePointStyle: true,
                        padding: 15,
                        font: {
                            size: 11
                        }
                    }
                },
                tooltip: {
                    enabled: true,
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleFont: {
                        size: 14,
                        weight: 'bold'
                    },
                    bodyFont: {
                        size: 12
                    },
                    padding: 12,
                    callbacks: {
                        label: function (context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            const value = context.parsed.y;
                            if (value !== null && value !== undefined && value > 0) {
                                label += formatValue(value, unit);
                            }
                            return label;
                        }
                    }
                },
                title: {
                    display: false
                }
            },
            scales: {
                x: {
                    display: true,
                    title: {
                        display: true,
                        text: 'Time',
                        font: {
                            size: 11,
                            weight: 'bold'
                        }
                    },
                    grid: {
                        display: false
                    },
                    ticks: {
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 24
                    }
                },
                y: {
                    display: true,
                    title: {
                        display: true,
                        text: yAxisTitle,
                        font: {
                            size: 11,
                            weight: 'bold'
                        }
                    },
                    grid: {
                        color: 'rgba(0, 0, 0, 0.05)'
                    },
                    ticks: {
                        callback: function (value) {
                            if (typeof value === 'number') {
                                return formatValue(value, unit);
                            }
                            return String(value);
                        }
                    }
                }
            }
        }
    });

    return chart;
}

/**
 * Format numeric value display
 */
function formatValue(value: number, unit: string): string {
    if (unit === 'Tokens') {
        if (value >= 1e6) {
            return `${(value / 1e6).toFixed(1)}M`;
        }
        if (value >= 1e3) {
            return `${(value / 1e3).toFixed(1)}K`;
        }
        return String(value);
    }

    if (unit === 'milliseconds') {
        if (value >= 1000) {
            return `${(value / 1000).toFixed(1)}s`;
        }
        return `${Math.round(value)}ms`;
    }

    // tokens/sec
    if (value >= 1000) {
        return `${(value / 1000).toFixed(1)}k`;
    }
    return `${value.toFixed(1)}`;
}
