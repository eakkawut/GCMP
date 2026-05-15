/*---------------------------------------------------------------------------------------------
 *  Schema Sanitizer
 *  Remove VS Code / JSON Schema UI-specific annotation fields from tool inputSchema,
 *  to avoid passing fields not accepted by backend APIs (Gemini, OpenAI, Anthropic, etc.).
 *--------------------------------------------------------------------------------------------*/

/**
 * Set of fields that need to be recursively removed from tool schema, in two categories:
 *
 * (1) VS Code extension annotations: Only used for setting editor rendering, not accepted by any LLM API.
 * (2) Standard JSON Schema metadata: Although part of the specification, various LLM APIs (especially Gemini)
 *     explicitly reject these fields, so they are uniformly removed.
 */
const droppedKeys = new Set<string>([
    // ── VS Code extension annotation fields ──
    'enumDescriptions',
    'markdownEnumDescriptions',
    'markdownDescription',
    'deprecationMessage',
    'markdownDeprecationMessage',
    'errorMessage',
    'patternErrorMessage',
    'enumItemLabels',
    'order',
    'editPresentation',
    'scope',
    'tags',
    // ── Standard JSON Schema metadata ──
    '$schema',
    '$id',
    '$comment',
    'title',
    'readOnly',
    'writeOnly',
    'deprecated'
]);

const propertyMapKeywords = new Set<string>([
    'properties',
    '$defs',
    'definitions',
    'patternProperties',
    'dependentSchemas',
    'dependencies',
    'dependentRequired'
]);

const geminiAllowedKeys = new Set<string>([
    'type',
    'format',
    'description',
    'nullable',
    'enum',
    'properties',
    'required',
    'items',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'propertyOrdering',
    'anyOf'
]);

export type ToolSchemaTarget = 'openai' | 'anthropic' | 'gemini';

/**
 * Recursively remove VS Code extension annotation fields from JSON Schema objects.
 *
 * - For primitive types (string / number / boolean / null), return the original value directly.
 * - For arrays, recursively process each element.
 * - For objects, recursively process each value and skip keys listed in `droppedKeys`.
 *
 * Key: The values of `properties` / `$defs` / `definitions` / `patternProperties`
 * are "name → schema" mappings, where the keys are user-defined parameter names / type names (which may
 * conflict with droppedKeys, such as `scope`, `deprecated`, `tags`, etc.). No key
 * filtering is done at this level, only recursive filtering on each schema value.
 *
 * This function returns a new object and does not modify the original input.
 *
 * @param schema - JSON Schema object to be sanitized (or any value)
 */
export function sanitizeToolSchema<T>(schema: T): T {
    return sanitizeToolSchemaForTarget(schema, 'openai');
}

/**
 * Generate the final schema for tool declarations based on target provider dialect.
 * Currently OpenAI / Anthropic use generic sanitization, Gemini additionally performs dialect downgrade and field whitelist filtering.
 */
export function sanitizeToolSchemaForTarget<T>(schema: T, target: ToolSchemaTarget): T {
    const sanitized = sanitizeGenericToolSchema(schema);
    switch (target) {
        case 'gemini':
            return jsonSchemaToGeminiSchema(sanitized) as T;
        case 'anthropic':
        case 'openai':
        default:
            return sanitized;
    }
}

/**
 * Generate the final schema that will be sent to the model request body based on target SDK.
 * Gemini additionally performs dialect conversion and field whitelist filtering to ensure consistency between the sending chain and token statistics.
 */
export function sanitizeToolSchemaForSdkMode<T>(schema: T, sdkMode?: string): T {
    return sanitizeToolSchemaForTarget(schema, resolveToolSchemaTargetFromSdkMode(sdkMode));
}

function resolveToolSchemaTargetFromSdkMode(sdkMode?: string): ToolSchemaTarget {
    switch (sdkMode) {
        case 'anthropic':
            return 'anthropic';
        case 'gemini-sse':
            return 'gemini';
        case 'openai':
        case 'openai-sse':
        case 'openai-responses':
        default:
            return 'openai';
    }
}

function sanitizeGenericToolSchema<T>(schema: T, insidePropertyMap = false): T {
    if (schema === null || schema === undefined) {
        return schema;
    }

    if (typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => sanitizeGenericToolSchema(item)) as unknown as T;
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
        // When in the "name → schema" mapping layer (values of properties / $defs etc.),
        // key is the parameter name or type name, not a schema annotation field, cannot be filtered.
        if (!insidePropertyMap && droppedKeys.has(key)) {
            continue;
        }

        // The following keywords' values are "name → schema" mappings: when entering the next layer, skip key filtering.
        // Key: Only judge when the current layer itself is a schema structure layer (!insidePropertyMap).
        // If already in the property name mapping layer (insidePropertyMap=true), key is the user-defined parameter name,
        // even if the parameter name happens to be 'properties'/'$defs' etc., its value is also a regular schema,
        // it should not be marked as property name mapping layer again, otherwise the annotation fields of that schema will be missed.
        const nextInsidePropertyMap = !insidePropertyMap && propertyMapKeywords.has(key);
        result[key] = sanitizeGenericToolSchema(value, nextInsidePropertyMap);
    }
    return result as T;
}

/**
 * Convert JSON Schema to the subset of schema acceptable by Gemini functionDeclaration.
 * Rules reference common practices from promptfoo / LiteLLM / Google ADK:
 * - First expand $ref
 * - Degrade anyOf/oneOf + null to nullable
 * - Convert type to Gemini uppercase enum
 * - Finally recursively filter by Gemini supported field whitelist
 */
export function jsonSchemaToGeminiSchema(
    jsonSchema: unknown,
    rootSchema: unknown = jsonSchema,
    refStack: Set<string> | undefined = undefined
): Record<string, unknown> {
    if (!jsonSchema || typeof jsonSchema !== 'object') {
        return {};
    }

    const root =
        rootSchema && typeof rootSchema === 'object'
            ? (rootSchema as Record<string, unknown>)
            : (jsonSchema as Record<string, unknown>);
    const stack = refStack instanceof Set ? refStack : new Set<string>();

    const refRaw = (jsonSchema as Record<string, unknown>).$ref;
    const ref = typeof refRaw === 'string' ? String(refRaw).trim() : '';
    if (ref) {
        if (stack.has(ref)) {
            return {};
        }
        stack.add(ref);

        const resolved = (() => {
            if (ref === '#') {
                return root;
            }
            if (!ref.startsWith('#/')) {
                return null;
            }
            const decode = (token: string) => token.replace(/~1/g, '/').replace(/~0/g, '~');
            const parts = ref
                .slice(2)
                .split('/')
                .map(part => decode(part));
            let current: unknown = root;
            for (const part of parts) {
                if (!current || typeof current !== 'object') {
                    return null;
                }
                if (!(part in (current as Record<string, unknown>))) {
                    return null;
                }
                current = (current as Record<string, unknown>)[part];
            }
            return current && typeof current === 'object' ? (current as Record<string, unknown>) : null;
        })();

        const merged: Record<string, unknown> = {
            ...(resolved && typeof resolved === 'object' ? resolved : {}),
            ...(jsonSchema as Record<string, unknown>)
        };
        delete merged.$ref;
        const output = jsonSchemaToGeminiSchema(merged, root, stack);
        stack.delete(ref);
        return output;
    }

    const input = { ...(jsonSchema as Record<string, unknown>) };
    const output: Record<string, unknown> = {};

    let anyOf: unknown[] | null = null;
    if (Array.isArray(input.anyOf)) {
        anyOf = input.anyOf as unknown[];
    } else if (Array.isArray(input.oneOf)) {
        anyOf = input.oneOf as unknown[];
    }
    if (anyOf && anyOf.length > 0) {
        const variants = anyOf.filter(item => item && typeof item === 'object') as Record<string, unknown>[];
        const nonNullVariants = variants.filter(item => item.type !== 'null');
        const hasNullVariant = nonNullVariants.length !== variants.length;

        if (hasNullVariant) {
            output.nullable = true;
        }

        if (nonNullVariants.length === 1) {
            return filterGeminiSchemaFields({
                ...output,
                ...jsonSchemaToGeminiSchema(nonNullVariants[0], root, stack)
            });
        }

        if (nonNullVariants.length > 1) {
            output.anyOf = nonNullVariants.map(variant => jsonSchemaToGeminiSchema(variant, root, stack));
            return filterGeminiSchemaFields(output);
        }

        if (hasNullVariant) {
            output.type = 'OBJECT';
            return filterGeminiSchemaFields(output);
        }
    }

    if (Array.isArray(input.type)) {
        const typeList = (input.type as unknown[]).filter(type => typeof type === 'string') as string[];
        if (typeList.length > 0) {
            const nonNullTypes = typeList.filter(type => type !== 'null');
            const hasNullType = nonNullTypes.length !== typeList.length;

            if (hasNullType) {
                output.nullable = true;
            }

            if (nonNullTypes.length === 1) {
                return filterGeminiSchemaFields({
                    ...output,
                    ...jsonSchemaToGeminiSchema(
                        { ...input, type: nonNullTypes[0], anyOf: undefined, oneOf: undefined },
                        root,
                        stack
                    )
                });
            }

            if (nonNullTypes.length > 1) {
                output.anyOf = nonNullTypes.map(type =>
                    jsonSchemaToGeminiSchema({ ...input, type, anyOf: undefined, oneOf: undefined }, root, stack)
                );
                return filterGeminiSchemaFields(output);
            }

            output.type = 'OBJECT';
            return filterGeminiSchemaFields(output);
        }
    }

    const rawType = typeof input.type === 'string' ? input.type : '';
    if (rawType && rawType !== 'null') {
        const mapped = mapJsonSchemaType(rawType);
        if (mapped) {
            output.type = mapped;
        }
    }

    if (Array.isArray(input.enum) && input.enum.length > 0) {
        output.enum = input.enum;
    }

    if (input.const !== undefined && !('enum' in output)) {
        output.enum = [input.const];
    }

    if (typeof input.description === 'string' && input.description.trim()) {
        output.description = input.description;
    }

    if (typeof input.format === 'string' && input.format.trim()) {
        output.format = input.format;
    }

    if (Array.isArray(input.propertyOrdering)) {
        output.propertyOrdering = input.propertyOrdering.filter(value => typeof value === 'string');
    }

    if (typeof input.minItems === 'number') {
        output.minItems = input.minItems;
    }
    if (typeof input.maxItems === 'number') {
        output.maxItems = input.maxItems;
    }
    if (typeof input.minLength === 'number') {
        output.minLength = input.minLength;
    }
    if (typeof input.maxLength === 'number') {
        output.maxLength = input.maxLength;
    }
    if (typeof input.minimum === 'number') {
        output.minimum = input.minimum;
    }
    if (typeof input.maximum === 'number') {
        output.maximum = input.maximum;
    }

    if (input.items && typeof input.items === 'object') {
        const itemSchema = input.items as Record<string, unknown>;
        output.items =
            Object.keys(itemSchema).length === 0
                ? { type: 'OBJECT' }
                : jsonSchemaToGeminiSchema(itemSchema, root, stack);
    }

    if (input.properties && typeof input.properties === 'object' && !Array.isArray(input.properties)) {
        const properties: Record<string, unknown> = {};
        for (const [propertyKey, propertyValue] of Object.entries(input.properties as Record<string, unknown>)) {
            if (!propertyValue || typeof propertyValue !== 'object') {
                continue;
            }
            properties[propertyKey] = jsonSchemaToGeminiSchema(propertyValue, root, stack);
        }
        output.properties = properties;
    }

    if (Array.isArray(input.required)) {
        output.required = Array.from(new Set((input.required as unknown[]).filter(value => typeof value === 'string')));
    }

    if (!output.type && output.properties && typeof output.properties === 'object') {
        output.type = 'OBJECT';
    }

    if (output.properties && typeof output.properties === 'object' && Object.keys(output.properties).length === 0) {
        delete output.properties;
        delete output.required;
        output.type = 'OBJECT';
    }

    return filterGeminiSchemaFields(output);
}

function filterGeminiSchemaFields(schema: Record<string, unknown>): Record<string, unknown> {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
        if (!geminiAllowedKeys.has(key) || value == null) {
            continue;
        }

        if (key === 'properties' && typeof value === 'object' && !Array.isArray(value)) {
            const properties: Record<string, unknown> = {};
            for (const [propertyKey, propertyValue] of Object.entries(value as Record<string, unknown>)) {
                if (!propertyValue || typeof propertyValue !== 'object') {
                    continue;
                }
                properties[propertyKey] = filterGeminiSchemaFields(propertyValue as Record<string, unknown>);
            }
            filtered[key] = properties;
            continue;
        }

        if (key === 'items' && typeof value === 'object' && !Array.isArray(value)) {
            filtered[key] = filterGeminiSchemaFields(value as Record<string, unknown>);
            continue;
        }

        if (key === 'anyOf' && Array.isArray(value)) {
            filtered[key] = value
                .filter(item => item && typeof item === 'object')
                .map(item => filterGeminiSchemaFields(item as Record<string, unknown>));
            continue;
        }

        filtered[key] = value;
    }
    return filtered;
}

function mapJsonSchemaType(type: string): string | undefined {
    switch ((type || '').toLowerCase()) {
        case 'string':
            return 'STRING';
        case 'number':
            return 'NUMBER';
        case 'integer':
            return 'INTEGER';
        case 'boolean':
            return 'BOOLEAN';
        case 'object':
            return 'OBJECT';
        case 'array':
            return 'ARRAY';
        default:
            return undefined;
    }
}
