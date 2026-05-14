/**
 * Model Editor - Client Script
 * Responsible for DOM creation, event binding, and VSCode communication
 */

// VSCode API
const vscode = acquireVsCodeApi();

// Type Definitions
/**
 * @typedef {Object} Provider
 * @property {string} id - Provider ID
 * @property {string} name - Provider Name
 */

/**
 * @typedef {Object} ModelCapabilities
 * @property {boolean} toolCalling - Whether tool calling is supported
 * @property {boolean} imageInput - Whether image input is supported
 */

/**
 * @typedef {Object} ModelData
 * @property {string} id - Model ID
 * @property {string} name - Display name
 * @property {string} [tooltip] - Description (optional)
 * @property {string} provider - Provider identifier
 * @property {string} [baseUrl] - API base URL (optional)
 * @property {string} [model] - Request model ID (optional)
 * @property {'openai'|'openai-sse'|'openai-responses'|'anthropic'|'gemini-sse'} sdkMode - SDK compatibility mode
 * @property {number} maxInputTokens - Maximum input tokens
 * @property {number} maxOutputTokens - Maximum output tokens
 * @property {ModelCapabilities} capabilities - Capability configuration
 * @property {boolean} useInstructions - Whether to use instructions parameter (only valid for openai-responses)
 * @property {boolean} webSearchTool - Whether to enable Anthropic native web_search tool (only valid for anthropic)
 * @property {Object} [customHeader] - Custom HTTP headers (optional)
 * @property {Object} [extraBody] - Extra request body parameters (optional)
 */

// Global Variables
/** @type {Provider[]} */
let allProviders = [];
/** @type {string[]} */
let availableModels = [];
/** @type {ModelData} */
let modelData = {};
/** @type {boolean} */
let isCreateMode = false;
/** @type {boolean} */
let isLoadingModels = false;

/** Provider IDs reserved for CLI, prohibited in general configuration */
const CLI_RESERVED_PROVIDERS = ['codex', 'gemini'];

/**
 * Initialize Editor
 * @param {ModelData} data - Model data
 * @param {boolean} createMode - Whether in create mode
 * @returns {void}
 */
function initializeEditor(data, createMode) {
    modelData = data;
    isCreateMode = createMode;

    // Create DOM
    createDOM();

    // Bind events
    bindEvents();

    // Request provider list
    vscode.postMessage({ command: 'getProviders' });

    // Initialize JSON validation
    validateJSON_UI('customHeader');
    validateJSON_UI('extraBody');
}

/**
 * Create DOM structure
 * @returns {void}
 */
function createDOM() {
    const container = document.getElementById('app');

    // Create Basic Information Section
    const basicSection = createSection('Basic Information', [
        createFormGroup(
            'modelId',
            `Model ID${isCreateMode ? ' *' : ''}`,
            'id',
            'input',
            {
                type: 'text',
                placeholder: 'e.g., zhipu:glm-4.6',
                value: modelData.id,
                readonly: !isCreateMode
            },
            isCreateMode ? 'Unique model identifier, cannot be changed after creation' : 'Unique model identifier, cannot be modified. Please edit the configuration file directly if changes are needed.'
        ),
        createFormGroup('modelName', 'Display Name *', 'name', 'input', {
            type: 'text',
            placeholder: 'e.g., GLM-4.6 (Zhipu AI)',
            value: modelData.name
        }, 'Name displayed in the model selector'),
        createFormGroup('modelTooltip', 'Description', 'tooltip', 'textarea', {
            rows: 2,
            placeholder: 'Detailed model description (optional)',
            value: modelData.tooltip
        }, 'Tooltip displayed on hover')
    ]);

    // Create API Configuration Section
    const apiSection = createSection('API Configuration', [
        createProviderFormGroup(),
        createFormGroup('sdkMode', 'SDK Mode', 'sdkMode', 'select', {
            options: [
                { value: 'openai', label: 'OpenAI SDK (Stream data processing using official SDK)', selected: modelData.sdkMode === 'openai' },
                { value: 'openai-sse', label: 'OpenAI SSE (Stream data processing using built-in compatibility parser)', selected: modelData.sdkMode === 'openai-sse' },
                { value: 'openai-responses', label: 'OpenAI Responses (Experimental support, request response handling using Responses API)', selected: modelData.sdkMode === 'openai-responses' },
                { value: 'anthropic', label: 'Anthropic SDK (Stream data processing using official SDK)', selected: modelData.sdkMode === 'anthropic' },
                { value: 'gemini-sse', label: 'Gemini HTTP SSE (Experimental support, stream data processing using built-in compatibility parser, compatible with third-party gateways)', selected: modelData.sdkMode === 'gemini-sse' }
            ]
        }, 'Compatibility mode used for model communication'),
        createFormGroup('baseUrl', 'BASE URL *', 'baseUrl', 'input', {
            type: 'url',
            placeholder: 'e.g., https://api.openai.com/v1 or https://api.anthropic.com',
            value: modelData.baseUrl
        }, 'Base URL for API requests, must start with http:// or https://\ne.g., https://api.openai.com/v1 or https://api.anthropic.com'),
        createFormGroup('apiKey', 'API Key', 'apiKey', 'input', {
            type: 'password',
            placeholder: 'Leave empty to keep the saved key unchanged',
            value: modelData.apiKey
        }, 'API key (optional). Setting here will automatically update the key.'),
        createModelComboboxFormGroup()
    ]);

    // Create Performance Settings Section
    const perfSection = createSection('Model Performance', [
        createFormGroup('maxInputTokens', 'Maximum Request Input Tokens', 'maxInputTokens', 'input', {
            type: 'number',
            min: 128,
            value: modelData.maxInputTokens
        }, 'Maximum input context limit supported by the model'),
        createFormGroup('maxOutputTokens', 'Maximum Response Output Tokens', 'maxOutputTokens', 'input', {
            type: 'number',
            min: 8,
            value: modelData.maxOutputTokens
        }, 'Maximum output token limit supported by the model')
    ]);

    // Create Capability Configuration Section
    const capSection = createSection('Model Capabilities', [
        createCheckboxFormGroup('toolCalling', 'Support Tool Calling', 'capabilities.toolCalling', modelData.toolCalling),
        createCheckboxFormGroup('imageInput', 'Support Image Input', 'capabilities.imageInput', modelData.imageInput)
    ]);

    // Create Advanced Settings Section
    const advSection = createSection('Advanced Settings', [
        createCheckboxFormGroup(
            'useInstructions',
            'Use instructions parameter (only valid for openai-responses)',
            'useInstructions',
            modelData.useInstructions,
            'When SDK mode is openai-responses, use instructions parameter to pass system messages (by default, user messages are used).'
        ),
        createCheckboxFormGroup(
            'webSearchTool',
            'Enable Anthropic native web_search tool (only valid for anthropic)',
            'webSearchTool',
            modelData.webSearchTool,
            'Enable when the interface is compatible with Anthropic native web_search tool. Once enabled, web_search will be automatically exposed to the model.'
        ),
        createJSONFormGroup('customHeader', 'Custom HTTP Headers (JSON format)', 'customHeader', modelData.customHeader,
            '{"Authorization": "Bearer ${APIKEY}", "X-Custom-Header": "value"}',
            'Optional custom HTTP headers configuration. Supports ${APIKEY} placeholder for automatic replacement with actual API key.'
        ),
        createJSONFormGroup('extraBody', 'Extra Request Body Parameters (JSON format)', 'extraBody', modelData.extraBody,
            '{"temperature": 1, "top_p": null}',
            'Extra request body parameters that will be merged into the request body during API requests. If the model does not support certain parameters, set them to null to remove the corresponding values.'
        )
    ]);

    // Create button group
    const buttonGroup = createButtonGroup();

    // Create global error banner
    const errorBanner = createErrorBanner();

    // Add to container (error banner at the top)
    container.appendChild(errorBanner);
    container.appendChild(basicSection);
    container.appendChild(apiSection);
    container.appendChild(perfSection);
    container.appendChild(capSection);
    container.appendChild(advSection);
    container.appendChild(buttonGroup);
}

/**
 * Create section element
 * @param {string} title - Section title
 * @param {Array<HTMLElement>} formGroups - Array of form group elements
 * @returns {HTMLElement} Created section element
 */
function createSection(title, formGroups) {
    const section = document.createElement('div');
    section.className = 'section';

    const h3 = document.createElement('h3');
    h3.textContent = title;
    section.appendChild(h3);

    formGroups.forEach(group => section.appendChild(group));

    return section;
}

/**
 * Create form group
 * @param {string} id - Form element ID
 * @param {string} labelText - Label display text
 * @param {string} fieldName - Field name (displayed in parentheses)
 * @param {string} elementType - Element type: 'input', 'textarea', or 'select'
 * @param {Object} attrs - Element attribute object
 * @param {string} [helpText] - Help text (optional)
 * @returns {HTMLElement} Created form group element
 */
function createFormGroup(id, labelText, fieldName, elementType, attrs, helpText) {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerHTML = `${labelText} <span class="field-name">(${fieldName})</span>`;
    group.appendChild(label);

    let element;
    if (elementType === 'input') {
        element = document.createElement('input');
        Object.entries(attrs).forEach(([key, value]) => {
            if (key === 'readonly' && value) {
                element.setAttribute('readonly', '');
                element.classList.add('readonly');
            } else if (key !== 'readonly') {
                element.setAttribute(key, value || '');
            }
        });
    } else if (elementType === 'textarea') {
        element = document.createElement('textarea');
        Object.entries(attrs).forEach(([key, value]) => {
            if (key === 'value') {
                element.textContent = value || '';
            } else {
                element.setAttribute(key, value || '');
            }
        });
    } else if (elementType === 'select') {
        element = document.createElement('select');
        attrs.options.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            if (opt.selected) option.selected = true;
            element.appendChild(option);
        });
    }

    element.id = id;
    group.appendChild(element);

    if (helpText) {
        const help = document.createElement('div');
        help.className = 'help-text detailed';
        help.textContent = helpText;
        group.appendChild(help);
    }

    return group;
}

/**
 * Create checkbox form group
 * @param {string} id - Checkbox element ID
 * @param {string} labelText - Label display text
 * @param {string} fieldName - Field name (displayed in parentheses)
 * @param {boolean} checked - Whether checkbox is checked
 * @param {string} [detailedHelp] - Detailed help text (optional)
 * @returns {HTMLElement} Created checkbox form group element
 */
function createCheckboxFormGroup(id, labelText, fieldName, checked, detailedHelp) {
    const group = document.createElement('div');
    group.className = 'form-group';

    const checkboxGroup = document.createElement('div');
    checkboxGroup.className = 'checkbox-group';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = id;
    checkbox.checked = checked || false;

    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerHTML = `${labelText} <span class="field-name">(${fieldName})</span>`;

    checkboxGroup.appendChild(checkbox);
    checkboxGroup.appendChild(label);
    group.appendChild(checkboxGroup);

    if (detailedHelp) {
        const help = document.createElement('div');
        help.className = 'help-text detailed';
        help.textContent = detailedHelp;
        group.appendChild(help);
    } else {
        group.classList.add('no-bottom');
    }

    return group;
}



/**
 * Create provider form group
 * @returns {HTMLElement} Created provider form group element
 */
function createProviderFormGroup() {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.htmlFor = 'provider';
    label.innerHTML = 'Provider * <span class="field-name">(provider)</span>';
    group.appendChild(label);

    const dropdown = document.createElement('div');
    dropdown.className = 'provider-dropdown';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'provider';
    input.className = 'provider-input';
    input.value = modelData.provider;
    input.placeholder = 'e.g., zhipu';
    input.autocomplete = 'off';

    const list = document.createElement('div');
    list.className = 'provider-list';
    list.id = 'providerList';

    dropdown.appendChild(input);
    dropdown.appendChild(list);
    group.appendChild(dropdown);

    const help = document.createElement('div');
    help.className = 'help-text';
    help.textContent = 'Model provider identifier (can select built-in/know providers or custom input)';
    group.appendChild(help);

    return group;
}

/**
 * Create request model ID combobox form group
 * @returns {HTMLElement} Created form group element
 */
function createModelComboboxFormGroup() {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.htmlFor = 'requestModel';
    label.innerHTML = 'Request Model ID <span class="field-name">(model)</span>';
    group.appendChild(label);

    const dropdown = document.createElement('div');
    dropdown.className = 'model-dropdown';

    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'model-input-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'requestModel';
    input.className = 'model-input';
    input.value = modelData.model || '';
    input.placeholder = 'e.g., gpt-4';
    input.autocomplete = 'off';

    const fetchButton = document.createElement('button');
    fetchButton.type = 'button';
    fetchButton.className = 'fetch-models-button';
    fetchButton.id = 'fetchModelsButton';
    fetchButton.onclick = fetchModelsFromAPI;
    fetchButton.textContent = 'Fetch Models';
    fetchButton.title = 'Fetch available model list from BASE URL';

    const spinner = document.createElement('span');
    spinner.className = 'fetch-spinner';
    spinner.style.display = 'none';
    fetchButton.appendChild(spinner);

    inputWrapper.appendChild(input);
    inputWrapper.appendChild(fetchButton);

    const list = document.createElement('div');
    list.className = 'model-list';
    list.id = 'modelList';

    dropdown.appendChild(inputWrapper);
    dropdown.appendChild(list);
    group.appendChild(dropdown);

    const help = document.createElement('div');
    help.className = 'help-text detailed';
    help.textContent = 'Model ID used when making requests (optional). If not filled, the Model ID (id) value will be used.\r\nClick the "Fetch Models" button to automatically fetch available model list from BASE URL (may not be supported by some providers).';
    group.appendChild(help);

    const statusDiv = document.createElement('div');
    statusDiv.className = 'model-fetch-status';
    statusDiv.id = 'modelFetchStatus';
    statusDiv.style.display = 'none';
    group.appendChild(statusDiv);

    return group;
}

/**
 * Create JSON form group
 * @param {string} id - Form element ID
 * @param {string} labelText - Label display text
 * @param {string} fieldName - Field name (displayed in parentheses)
 * @param {string} value - JSON string value
 * @param {string} placeholder - Placeholder text
 * @param {string} helpText - Help text
 * @returns {HTMLElement} Created JSON form group element
 */
function createJSONFormGroup(id, labelText, fieldName, value, placeholder, helpText) {
    const group = document.createElement('div');
    group.className = 'form-group';

    const label = document.createElement('label');
    label.htmlFor = id;
    label.innerHTML = `${labelText} <span class="field-name">(${fieldName})</span>`;
    group.appendChild(label);

    const container = document.createElement('div');
    container.className = 'json-container';

    const toolbar = document.createElement('div');
    toolbar.className = 'json-toolbar';

    const formatBtn = document.createElement('button');
    formatBtn.type = 'button';
    formatBtn.className = 'json-button';
    formatBtn.textContent = 'Format';
    formatBtn.onclick = (e) => {
        e.preventDefault();
        formatJSON(id);
    };

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'json-button';
    clearBtn.textContent = 'Clear';
    clearBtn.onclick = (e) => {
        e.preventDefault();
        clearJSON(id);
    };

    const status = document.createElement('div');
    status.className = 'json-status';
    status.id = `${id}Status`;

    const indicator = document.createElement('span');
    indicator.className = 'json-status-indicator';

    const statusText = document.createElement('span');
    statusText.id = `${id}StatusText`;
    statusText.textContent = 'No content';

    status.appendChild(indicator);
    status.appendChild(statusText);

    toolbar.appendChild(formatBtn);
    toolbar.appendChild(clearBtn);
    toolbar.appendChild(status);
    container.appendChild(toolbar);

    const textarea = document.createElement('textarea');
    textarea.id = id;
    textarea.className = 'json-input';
    textarea.placeholder = placeholder;
    textarea.value = value || '';

    container.appendChild(textarea);

    const error = document.createElement('div');
    error.className = 'json-error';
    error.id = `${id}Error`;
    container.appendChild(error);

    group.appendChild(container);

    const help = document.createElement('div');
    help.className = 'help-text detailed';
    help.textContent = helpText;
    group.appendChild(help);

    return group;
}

/**
 * Create global error message area
 * @returns {HTMLElement} Created error message element
 */
function createErrorBanner() {
    const banner = document.createElement('div');
    banner.id = 'globalErrorBanner';
    banner.className = 'error-banner';
    banner.style.display = 'none';

    const messageSpan = document.createElement('span');
    messageSpan.id = 'globalErrorMessage';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'error-banner-close';
    closeBtn.textContent = '×';
    closeBtn.onclick = hideGlobalError;

    banner.appendChild(messageSpan);
    banner.appendChild(closeBtn);

    return banner;
}

/**
 * Create button group
 * @returns {HTMLElement} Created button group element
 */
function createButtonGroup() {
    const group = document.createElement('div');
    group.className = 'button-group';

    // Create inner container for center alignment
    const inner = document.createElement('div');
    inner.className = 'button-group-inner';

    // Left button container (delete button)
    const leftButtons = document.createElement('div');
    leftButtons.style.display = 'flex';
    leftButtons.style.gap = '10px';

    // Right button container (save and cancel buttons)
    const rightButtons = document.createElement('div');
    rightButtons.style.display = 'flex';
    rightButtons.style.gap = '10px';

    // If in edit mode, add delete button to the left
    if (!isCreateMode) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-button';
        deleteBtn.textContent = 'Delete';
        deleteBtn.onclick = deleteModel;
        leftButtons.appendChild(deleteBtn);
    }

    const saveBtn = document.createElement('button');
    saveBtn.className = 'primary-button';
    saveBtn.textContent = isCreateMode ? 'Create' : 'Update';
    saveBtn.onclick = saveModel;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'secondary-button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = cancelEdit;

    rightButtons.appendChild(saveBtn);
    rightButtons.appendChild(cancelBtn);

    inner.appendChild(leftButtons);
    inner.appendChild(rightButtons);
    group.appendChild(inner);

    return group;
}

/**
 * Automatically adjust the height of a single textarea to fit its content
 * @param {HTMLTextAreaElement} textarea - textarea element
 * @returns {void}
 */
function autoResizeTextarea(textarea) {
    if (!textarea) return;

    // Reset height to get correct scrollHeight
    textarea.style.height = 'auto';

    // Set new height (scrollHeight + border)
    const newHeight = textarea.scrollHeight;
    textarea.style.height = newHeight + 'px';
}

/**
 * Add auto-expand height functionality for all textarea elements
 * @returns {void}
 */
function autoResizeAllTextareas() {
    const textareas = document.querySelectorAll('textarea');

    textareas.forEach(textarea => {
        // Adjust height once on initialization
        autoResizeTextarea(textarea);

        // Listen to input event to adjust height in real-time
        textarea.addEventListener('input', function () {
            autoResizeTextarea(this);
        });

        // Listen to change event (e.g., after paste)
        textarea.addEventListener('change', function () {
            autoResizeTextarea(this);
        });

        // Listen to paste event
        textarea.addEventListener('paste', function () {
            // Use setTimeout to ensure content has been pasted
            setTimeout(() => {
                autoResizeTextarea(this);
            }, 0);
        });
    });
}

/**
 * Generic input validation - non-empty validation
 * @param {HTMLElement} element - Input element to validate
 * @returns {void}
 */
function addSimpleValidation(element) {
    element.addEventListener('input', function () {
        if (this.value.trim()) {
            this.classList.remove('invalid');
        } else {
            this.classList.add('invalid');
        }
    });
}

/**
 * Generic number validation - must be a positive integer
 * @param {HTMLElement} element - Input element to validate
 * @returns {void}
 */
function addNumberValidation(element) {
    element.addEventListener('input', function () {
        const value = parseInt(this.value);
        if (value && value > 0) {
            this.classList.remove('invalid');
        } else {
            this.classList.add('invalid');
        }
    });
}

/**
 * Check if it is a valid JSON object (not an array, not null, not a primitive type)
 * @param {*} parsed - Parsed JSON data
 * @returns {boolean} Whether it is a valid JSON object
 */
function isValidJSONObject(parsed) {
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/**
 * Bind events
 */
/**
 * Bind event listeners
 * @returns {void}
 */
function bindEvents() {
    // Real-time validation for required fields
    const modelId = document.getElementById('modelId');
    const modelName = document.getElementById('modelName');
    const provider = document.getElementById('provider');
    const baseUrl = document.getElementById('baseUrl');
    const maxInputTokens = document.getElementById('maxInputTokens');
    const maxOutputTokens = document.getElementById('maxOutputTokens');

    // Add auto-expand height functionality for all textareas
    autoResizeAllTextareas();

    // Model ID validation
    if (modelId && !modelId.readOnly) {
        addSimpleValidation(modelId);
    }

    // Display name validation
    addSimpleValidation(modelName);

    // Provider validation
    addSimpleValidation(provider);

    // Base URL validation (required + URL format)
    baseUrl.addEventListener('input', function () {
        const value = this.value.trim();
        if (!value) {
            this.classList.add('invalid');
            return;
        }
        try {
            const urlObj = new URL(value);
            if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {
                this.classList.remove('invalid');
            } else {
                this.classList.add('invalid');
            }
        } catch (e) {
            this.classList.add('invalid');
        }
    });

    // Token count validation
    addNumberValidation(maxInputTokens);
    addNumberValidation(maxOutputTokens);

    // JSON validation events
    const customHeader = document.getElementById('customHeader');
    const extraBody = document.getElementById('extraBody');

    customHeader.addEventListener('input', () => validateJSON_UI('customHeader'));
    customHeader.addEventListener('change', () => validateJSON_UI('customHeader'));

    extraBody.addEventListener('input', () => validateJSON_UI('extraBody'));
    extraBody.addEventListener('change', () => validateJSON_UI('extraBody'));

    // Provider input event
    const providerInput = document.getElementById('provider');
    const providerList = document.getElementById('providerList');

    providerInput.addEventListener('input', function () {
        const searchText = this.value.toLowerCase();

        // Check if CLI reserved provider ID is entered
        if (CLI_RESERVED_PROVIDERS.some(reserved => reserved.toLowerCase() === searchText)) {
            this.classList.add('invalid');
            showGlobalError(`Provider "${this.value}" is reserved for CLI and cannot be used in custom models`);
        } else if (searchText) {
            this.classList.remove('invalid');
            hideGlobalError();
            const filtered = allProviders.filter(
                p => p.id.toLowerCase().includes(searchText) || p.name.toLowerCase().includes(searchText)
            );
            renderProviderList(filtered);
            providerList.classList.add('show');
        } else {
            this.classList.remove('invalid');
            hideGlobalError();
            providerList.classList.remove('show');
        }
    });

    providerInput.addEventListener('focus', function () {
        if (allProviders && allProviders.length > 0) {
            renderProviderList(allProviders);
            providerList.classList.add('show');
        }
    });

    document.addEventListener('click', function (event) {
        if (!event.target.closest('.provider-dropdown')) {
            providerList.classList.remove('show');
        }
    });

    // VSCode message event
    window.addEventListener('message', function (event) {
        const message = event.data;
        if (message.command === 'setProviders') {
            updateProviderList(message.providers);
        } else if (message.command === 'modelsLoading') {
            handleModelsLoading();
        } else if (message.command === 'modelsLoaded') {
            handleModelsLoaded(message.models);
        } else if (message.command === 'modelsError') {
            handleModelsError(message.error);
        }
    });

    // SDK mode switch event - control visibility of specific options
    const sdkModeSelect = document.getElementById('sdkMode');
    const useInstructionsContainer = document.getElementById('useInstructions')?.closest('.form-group');
    const webSearchToolContainer = document.getElementById('webSearchTool')?.closest('.form-group');
    if (sdkModeSelect && useInstructionsContainer && webSearchToolContainer) {
        const updateSdkSpecificOptionsVisibility = function () {
            if (sdkModeSelect.value === 'openai-responses') {
                useInstructionsContainer.style.display = '';
            } else {
                useInstructionsContainer.style.display = 'none';
            }

            if (sdkModeSelect.value === 'anthropic') {
                webSearchToolContainer.style.display = '';
            } else {
                webSearchToolContainer.style.display = 'none';
            }
        };
        sdkModeSelect.addEventListener('change', updateSdkSpecificOptionsVisibility);
        updateSdkSpecificOptionsVisibility();
    }

    // Request model ID input event
    const requestModelInput = document.getElementById('requestModel');
    const modelList = document.getElementById('modelList');
    const fetchModelsButton = document.getElementById('fetchModelsButton');
    // Sync button style when input field is focused
    requestModelInput.addEventListener('focus', function () {
        fetchModelsButton.classList.add('input-focused');
    });
    requestModelInput.addEventListener('blur', function () {
        fetchModelsButton.classList.remove('input-focused');
    });

    requestModelInput.addEventListener('input', function () {
        const searchText = this.value.toLowerCase();
        if (searchText && availableModels.length > 0) {
            const filtered = availableModels.filter(m => m.toLowerCase().includes(searchText));
            renderModelList(filtered);
            modelList.classList.add('show');
        } else if (availableModels.length > 0) {
            renderModelList(availableModels);
            modelList.classList.add('show');
        } else {
            modelList.classList.remove('show');
        }
    });

    requestModelInput.addEventListener('focus', function () {
        if (availableModels && availableModels.length > 0) {
            renderModelList(availableModels);
            modelList.classList.add('show');
        }
    });

    requestModelInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
            event.preventDefault();
            modelList.classList.remove('show');
        }
    });

    document.addEventListener('click', function (event) {
        if (!event.target.closest('.model-dropdown')) {
            modelList.classList.remove('show');
        }
    });


}

/**
 * JSON validation
 */
/**
 * Validate JSON string format
 * @param {string} jsonString - JSON string to validate
 * @returns {boolean} Whether JSON is valid
 */
/**
 * Validate JSON string format
 * @param {string} jsonString - JSON string to validate
 * @returns {boolean} Whether JSON is valid
 */
function validateJSON(jsonString) {
    if (!jsonString || jsonString.trim() === '') {
        return true;
    }
    try {
        const parsed = JSON.parse(jsonString);
        // Must be an object type, not an array, string, number, etc.
        return isValidJSONObject(parsed);
    } catch (e) {
        return false;
    }
}

/**
 * Parse JSON string
 * @param {string} jsonString - JSON string to parse
 * @returns {Object|undefined} Parsed object, or undefined if parsing fails
 */
/**
 * Parse JSON string
 * @param {string} jsonString - JSON string to parse
 * @returns {Object|undefined} Parsed object, or undefined if parsing fails or it's not an object
 */
function parseJSON(jsonString) {
    if (!jsonString || jsonString.trim() === '') {
        return undefined;
    }
    try {
        const parsed = JSON.parse(jsonString);
        // Must be an object type, not an array, string, number, etc.
        if (isValidJSONObject(parsed)) {
            return parsed;
        }
        return undefined;
    } catch (e) {
        return undefined;
    }
}

/**
 * Validate JSON and update UI state (visual feedback only, no focus)
 * @param {string} fieldId - Form field ID
 * @returns {boolean} Whether JSON is valid
 */
function validateJSON_UI(fieldId) {
    const textarea = document.getElementById(fieldId);
    const statusDiv = document.getElementById(fieldId + 'Status');
    const statusText = document.getElementById(fieldId + 'StatusText');
    const errorDiv = document.getElementById(fieldId + 'Error');
    const content = textarea.value.trim();

    // 移除所有验证状态类
    textarea.classList.remove('json-valid', 'json-invalid');
    if (errorDiv) {
        errorDiv.classList.remove('show');
    }

    if (!content) {
        const indicator = statusDiv.querySelector('.json-status-indicator');
        indicator.className = 'json-status-indicator';
        statusText.textContent = 'No content';
        return true;
    }

    try {
        const parsed = JSON.parse(content);
        // Must be an object type, not an array, string, number, etc.
        if (isValidJSONObject(parsed)) {
            // Validation passed - restore default state (no green style added)
            const indicator = statusDiv.querySelector('.json-status-indicator');
            indicator.className = 'json-status-indicator';
            statusText.textContent = 'Valid ✓';
            return true;
        } else {
            // Not an object type - show red error state
            textarea.classList.add('json-invalid');
            const indicator = statusDiv.querySelector('.json-status-indicator');
            indicator.className = 'json-status-indicator invalid';
            statusText.textContent = 'Invalid ✗';
            if (errorDiv) {
                errorDiv.textContent = 'Must be an object type (e.g., {"key": "value"}), not an array, number, or string';
                errorDiv.classList.add('show');
            }
            return false;
        }
    } catch (e) {
        // JSON parsing error - show red error state
        textarea.classList.add('json-invalid');
        const indicator = statusDiv.querySelector('.json-status-indicator');
        indicator.className = 'json-status-indicator invalid';
        statusText.textContent = 'Invalid ✗';
        if (errorDiv) {
            errorDiv.textContent = 'Error: ' + e.message;
            errorDiv.classList.add('show');
        }
        return false;
    }
}

/**
 * Format JSON string
 * @param {string} fieldId - Form field ID
 * @returns {void}
 */
function formatJSON(fieldId) {
    const textarea = document.getElementById(fieldId);
    const content = textarea.value.trim();

    if (!content) {
        showGlobalError('No content to format');
        return;
    }

    try {
        const parsed = JSON.parse(content);
        // Must be an object type, consistent with validateJSON logic
        if (!isValidJSONObject(parsed)) {
            showGlobalError('JSON format error: must be an object type (e.g., {"key": "value"}), not an array, number, or string');
            return;
        }
        textarea.value = JSON.stringify(parsed, null, 2);
        validateJSON_UI(fieldId);
        // Adjust height after formatting
        autoResizeTextarea(textarea);
        textarea.style.opacity = '0.7';
        setTimeout(() => {
            textarea.style.opacity = '1';
        }, 200);
        // Clear error message on successful formatting
        hideGlobalError();
    } catch (e) {
        showGlobalError('JSON format error, cannot format:\n' + e.message);
    }
}

/**
 * Clear JSON field content
 * @param {string} fieldId - Form field ID
 * @returns {void}
 */
function clearJSON(fieldId) {
    const textarea = document.getElementById(fieldId);
    // Clear directly without confirmation (user can restore via cancel save or Ctrl+Z)
    textarea.value = '';
    validateJSON_UI(fieldId);
    // Adjust height after clearing
    autoResizeTextarea(textarea);
}

/**
 * Provider list management
 * @param {Provider[]} providers - Provider list
 * @returns {void}
 */
function updateProviderList(providers) {
    // Filter out CLI reserved providers
    allProviders = (providers || []).filter(
        p => !CLI_RESERVED_PROVIDERS.includes(p.id.toLowerCase())
    );
    renderProviderList(allProviders);
}

/**
 * Render provider list
 * @param {Provider[]} providers - Provider list
 * @returns {void}
 */
function renderProviderList(providers) {
    const providerListDiv = document.getElementById('providerList');
    const currentValue = document.getElementById('provider').value;

    providerListDiv.innerHTML = '';

    if (!providers || providers.length === 0) {
        const item = document.createElement('div');
        item.className = 'provider-list-item';
        item.textContent = 'No matching providers';
        item.style.pointerEvents = 'none';
        item.style.opacity = '0.5';
        providerListDiv.appendChild(item);
        return;
    }

    providers.forEach(provider => {
        const item = document.createElement('div');
        item.className = 'provider-list-item';
        if (provider.id === currentValue) {
            item.classList.add('selected');
        }
        item.textContent = `${provider.name} (${provider.id})`;
        item.addEventListener('click', function () {
            const providerInput = document.getElementById('provider');
            providerInput.value = provider.id;
            // Remove error style (if any)
            providerInput.classList.remove('invalid');
            providerListDiv.classList.remove('show');
        });
        providerListDiv.appendChild(item);
    });
}

/**
 * Form validation
 */
/**
 * Display global error message
 * @param {string} message - Error message
 * @returns {void}
 */
function showGlobalError(message) {
    const banner = document.getElementById('globalErrorBanner');
    const messageSpan = document.getElementById('globalErrorMessage');

    if (banner && messageSpan) {
        messageSpan.textContent = message;
        banner.style.display = 'flex';
        // Auto scroll to top to ensure user sees error message
        banner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

/**
 * Hide global error message
 * @returns {void}
 */
function hideGlobalError() {
    const banner = document.getElementById('globalErrorBanner');
    if (banner) {
        banner.style.display = 'none';
    }
}

/**
 * Validate form data
 * @returns {boolean} Whether form is valid
 */
function validateForm() {
    const modelId = document.getElementById('modelId').value.trim();
    const modelName = document.getElementById('modelName').value.trim();
    const provider = document.getElementById('provider').value.trim();
    const baseUrl = document.getElementById('baseUrl').value.trim();
    const maxInputTokens = document.getElementById('maxInputTokens').value.trim();
    const maxOutputTokens = document.getElementById('maxOutputTokens').value.trim();

    // Validate required fields
    if (!modelId) {
        showGlobalError('Please enter Model ID');
        document.getElementById('modelId').focus();
        return false;
    }
    if (!modelName) {
        showGlobalError('Please enter Display Name');
        document.getElementById('modelName').focus();
        return false;
    }
    if (!provider) {
        showGlobalError('Please enter Provider');
        document.getElementById('provider').focus();
        return false;
    }

    // Validate provider is not a CLI reserved identifier
    if (CLI_RESERVED_PROVIDERS.includes(provider.toLowerCase())) {
        showGlobalError(`Provider "${provider}" is reserved for CLI and cannot be used in custom models`);
        document.getElementById('provider').focus();
        return false;
    }
    if (!baseUrl) {
        showGlobalError('Please enter BASE URL');
        document.getElementById('baseUrl').focus();
        return false;
    }

    // Validate URL format
    if (baseUrl) {
        try {
            const urlObj = new URL(baseUrl);
            if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
                showGlobalError('BASE URL must start with http:// or https://');
                document.getElementById('baseUrl').focus();
                return false;
            }
        } catch (e) {
            showGlobalError('BASE URL format is incorrect, please enter a valid URL');
            document.getElementById('baseUrl').focus();
            return false;
        }
    }

    // Validate Token count
    if (!maxInputTokens || isNaN(parseInt(maxInputTokens)) || parseInt(maxInputTokens) <= 0) {
        showGlobalError('Maximum Input Tokens must be a number greater than 0');
        document.getElementById('maxInputTokens').focus();
        return false;
    }
    if (!maxOutputTokens || isNaN(parseInt(maxOutputTokens)) || parseInt(maxOutputTokens) <= 0) {
        showGlobalError('Maximum Output Tokens must be a number greater than 0');
        document.getElementById('maxOutputTokens').focus();
        return false;
    }

    // Validate JSON format
    const customHeaderJson = document.getElementById('customHeader').value.trim();
    if (customHeaderJson && !validateJSON(customHeaderJson)) {
        showGlobalError('JSON format for Custom HTTP Headers is incorrect, must be an object type');
        document.getElementById('customHeader').focus();
        return false;
    }

    const extraBodyJson = document.getElementById('extraBody').value.trim();
    if (extraBodyJson && !validateJSON(extraBodyJson)) {
        showGlobalError('JSON format for Extra Request Body Parameters is incorrect, must be an object type');
        document.getElementById('extraBody').focus();
        return false;
    }

    return true;
}

/**
 * Save model
 */
/**
 * Save model configuration
 * @returns {void}
 */
function saveModel() {
    // Clear previous error messages first
    hideGlobalError();

    if (!validateForm()) {
        return;
    }

    const modelId = document.getElementById('modelId').value.trim();
    const modelName = document.getElementById('modelName').value.trim();
    const provider = document.getElementById('provider').value.trim();

    if (!modelId || !modelName || !provider) {
        showGlobalError('Please fill in all required fields');
        return;
    }

    const tooltipText = document.getElementById('modelTooltip').value.trim();
    const requestModelText = document.getElementById('requestModel').value.trim();
    const baseUrlText = document.getElementById('baseUrl').value.trim();
    const apiKeyText = document.getElementById('apiKey').value.trim();

    const sdkMode = document.getElementById('sdkMode').value || 'openai';

    const model = JSON.parse(JSON.stringify(modelData || {}));
    delete model.toolCalling;
    delete model.imageInput;

    model.id = modelId;
    model.name = modelName;
    // tooltip: Use null to clear (undefined will be ignored during JSON serialization)
    model.tooltip = tooltipText || null;
    model.provider = provider;
    // baseUrl: Use null to clear
    model.baseUrl = baseUrlText || null;
    // apiKey: Use null to clear
    model.apiKey = apiKeyText || null;
    // model: Use null to clear
    model.model = requestModelText || null;
    model.sdkMode = sdkMode;
    model.maxInputTokens = parseInt(document.getElementById('maxInputTokens').value) || 12800;
    model.maxOutputTokens = parseInt(document.getElementById('maxOutputTokens').value) || 8192;
    model.capabilities = {
        ...(model.capabilities || {}),
        toolCalling: document.getElementById('toolCalling').checked,
        imageInput: document.getElementById('imageInput').checked
    };

    // Only update useInstructions field when sdkMode is openai-responses.
    // If the old value is true, retain it when switching to other sdkModes to prevent loss of original configuration when switching back to openai-responses.
    if (sdkMode === 'openai-responses') {
        model.useInstructions = document.getElementById('useInstructions')?.checked || false;
    } else if (!model.useInstructions) {
        model.useInstructions = null; // Explicitly set to null to indicate not used
    }

    // Only update webSearchTool field when sdkMode is anthropic.
    // If the old value is true, retain it when switching to other sdkModes to prevent loss of original configuration when switching back to anthropic.
    if (sdkMode === 'anthropic') {
        model.webSearchTool = document.getElementById('webSearchTool')?.checked || false;
    } else if (!model.webSearchTool) {
        model.webSearchTool = null; // Explicitly set to null to indicate not used
    }

    const customHeaderText = document.getElementById('customHeader').value.trim();
    const customHeader = parseJSON(customHeaderText);
    // Explicitly set customHeader, use null to clear (undefined will be ignored during JSON serialization)
    model.customHeader = customHeader || null;

    const extraBodyText = document.getElementById('extraBody').value.trim();
    const extraBody = parseJSON(extraBodyText);
    // Explicitly set extraBody, use null to clear
    model.extraBody = extraBody || null;

    if (!model.id || !model.name || !model.provider) {
        showGlobalError('Model configuration is incomplete, please try again');
        return;
    }

    vscode.postMessage({
        command: 'save',
        model: model
    });
}

/**
 * Cancel editing
 * @returns {void}
 */
function cancelEdit() {
    vscode.postMessage({
        command: 'cancel'
    });
}

/**
 * Delete model
 * @returns {void}
 */
function deleteModel() {
    // Send delete request to VSCode side, VSCode will display confirmation dialog
    vscode.postMessage({
        command: 'delete',
        modelId: document.getElementById('modelId').value.trim(),
        modelName: document.getElementById('modelName').value.trim()
    });
}

/**
 * Fetch model list from API
 * @returns {void}
 */
function fetchModelsFromAPI() {
    const baseUrl = document.getElementById('baseUrl').value.trim();
    const apiKey = document.getElementById('apiKey').value.trim();
    const provider = document.getElementById('provider').value.trim();

    if (!baseUrl) {
        showGlobalError('Please enter BASE URL first');
        return;
    }

    // Validate URL format
    try {
        const urlObj = new URL(baseUrl);
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
            showGlobalError('BASE URL must start with http:// or https://');
            return;
        }
    } catch (e) {
        showGlobalError('BASE URL format is incorrect, please enter a valid URL');
        return;
    }

    // Send request to backend
    vscode.postMessage({
        command: 'fetchModels',
        baseUrl: baseUrl,
        apiKey: apiKey || null,
        provider: provider || null
    });
}

/**
 * Handle model loading state
 * @returns {void}
 */
function handleModelsLoading() {
    isLoadingModels = true;
    const button = document.getElementById('fetchModelsButton');
    const statusDiv = document.getElementById('modelFetchStatus');
    const spinner = button.querySelector('.fetch-spinner');

    button.disabled = true;
    button.classList.add('loading');
    spinner.style.display = 'inline-block';

    statusDiv.textContent = 'Fetching model list...';
    statusDiv.className = 'model-fetch-status loading';
    statusDiv.style.display = 'block';

    hideGlobalError();
}

/**
 * Handle model loading success
 * @param {string[]} models - Model list
 * @returns {void}
 */
function handleModelsLoaded(models) {
    isLoadingModels = false;
    const button = document.getElementById('fetchModelsButton');
    const statusDiv = document.getElementById('modelFetchStatus');
    const spinner = button.querySelector('.fetch-spinner');
    const modelList = document.getElementById('modelList');

    button.disabled = false;
    button.classList.remove('loading');
    spinner.style.display = 'none';

    if (models && models.length > 0) {
        availableModels = models;
        statusDiv.textContent = `Successfully fetched ${models.length} models`;
        statusDiv.className = 'model-fetch-status success';
        statusDiv.style.display = 'block';

        // Automatically display model list
        renderModelList(availableModels);
        modelList.classList.add('show');

        // Hide status prompt after 3 seconds
        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 3000);
    } else {
        availableModels = [];
        statusDiv.textContent = 'No available models found';
        statusDiv.className = 'model-fetch-status warning';
        statusDiv.style.display = 'block';

        setTimeout(() => {
            statusDiv.style.display = 'none';
        }, 3000);
    }
}

/**
 * Handle model loading error
 * @param {string} error - Error message
 * @returns {void}
 */
function handleModelsError(error) {
    isLoadingModels = false;
    const button = document.getElementById('fetchModelsButton');
    const statusDiv = document.getElementById('modelFetchStatus');
    const spinner = button.querySelector('.fetch-spinner');

    button.disabled = false;
    button.classList.remove('loading');
    spinner.style.display = 'none';

    statusDiv.textContent = error || 'Failed to fetch model list';
    statusDiv.className = 'model-fetch-status error';
    statusDiv.style.display = 'block';

    // Hide error message after 5 seconds
    setTimeout(() => {
        statusDiv.style.display = 'none';
    }, 5000);
}

/**
 * Render model list
 * @param {string[]} models - Model list
 * @returns {void}
 */
function renderModelList(models) {
    const modelListDiv = document.getElementById('modelList');
    const currentValue = document.getElementById('requestModel').value;

    modelListDiv.innerHTML = '';

    if (!models || models.length === 0) {
        const item = document.createElement('div');
        item.className = 'model-list-item';
        item.textContent = 'No available models';
        item.style.pointerEvents = 'none';
        item.style.opacity = '0.5';
        modelListDiv.appendChild(item);
        return;
    }

    models.forEach(model => {
        const item = document.createElement('div');
        item.className = 'model-list-item';
        if (model === currentValue) {
            item.classList.add('selected');
        }
        item.textContent = model;
        item.addEventListener('click', function () {
            const modelInput = document.getElementById('requestModel');
            modelInput.value = model;
            modelListDiv.classList.remove('show');
        });
        modelListDiv.appendChild(item);
    });
}
