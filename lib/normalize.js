/**
 * Statuses in which Meta accepts an edit of an existing template.
 */
export const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED']);

const MEDIA_HEADER_FORMATS = new Set(['IMAGE', 'VIDEO', 'DOCUMENT']);
const SAFE_SEGMENT = /^[A-Za-z0-9_]+$/;

/**
 * @typedef {object} Template
 * @property {string} name
 * @property {string} language
 * @property {string} [category]
 * @property {string} [parameter_format]
 * @property {object[]} components
 */

/**
 * Returns a copy with object keys sorted at every level (stable files and comparisons).
 *
 * @param {any} value
 * @returns {any}
 */
export function sortKeys(value) {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .toSorted((a, b) => a.localeCompare(b))
                .map((key) => [key, sortKeys(value[key])]),
        );
    }
    return value;
}

/**
 * Keeps only the fields that define a template and drops read-only ones (id, status, …).
 * Files, CSV rows and live templates all pass through here before they are compared.
 *
 * @param {object} template - Template from a file, a CSV row or the Graph API.
 * @returns {Template}
 */
export function normalizeTemplate(template) {
    const normalized = {
        name: template.name,
        language: template.language,
        components: template.components ?? [],
    };
    if (template.category) {
        normalized.category = String(template.category).toUpperCase();
    }
    if (template.parameter_format) {
        normalized.parameter_format = String(template.parameter_format).toUpperCase();
    }
    return sortKeys(normalized);
}

/**
 * @param {{name: string, language: string}} template
 * @returns {string}
 */
export function templateKey(template) {
    return `${template.name}::${template.language}`;
}

/**
 * Throws when a name or language could not safely be used as a file or folder name.
 *
 * @param {{name: string, language: string}} template
 * @returns {void}
 */
export function assertSafeIdentity(template) {
    const fields = Object.entries({ name: template.name, language: template.language });
    for (const [field, value] of fields) {
        if (typeof value !== 'string' || !SAFE_SEGMENT.test(value)) {
            throw new Error(
                `Template ${field} "${value}" may only contain letters, digits and underscores.`,
            );
        }
    }
}

/**
 * The part of a template that deploy compares. Category is left out on purpose: Meta refuses
 * category edits on approved templates and re-categorizes templates itself.
 *
 * @param {Template} template
 * @returns {string}
 */
export function comparableContent(template) {
    return JSON.stringify(
        sortKeys({
            components: template.components ?? [],
            parameter_format: template.parameter_format ?? 'POSITIONAL',
        }),
    );
}

/**
 * Why a template is out of scope for this version, or `undefined` when it is supported.
 *
 * @param {Template} template
 * @returns {string|undefined}
 */
export function unsupportedReason(template) {
    if (template.category === 'AUTHENTICATION') {
        return 'authentication (OTP) templates are not supported yet';
    }
    const components = template.components ?? [];
    for (const component of components) {
        const type = String(component.type ?? '').toUpperCase();
        if (type === 'CAROUSEL') {
            return 'carousel templates are not supported yet';
        }
        if (type === 'HEADER' && MEDIA_HEADER_FORMATS.has(String(component.format).toUpperCase())) {
            return 'media headers (image, video, document) are not supported yet';
        }
    }
    return;
}

/**
 * Request body for creating a template.
 *
 * @param {Template} template
 * @returns {object}
 */
export function toCreateBody(template) {
    return {
        name: template.name,
        language: template.language,
        category: template.category,
        components: template.components,
        ...(template.parameter_format && { parameter_format: template.parameter_format }),
    };
}

/**
 * Request body for editing a template. Category is never sent (see `comparableContent`).
 *
 * @param {Template} template
 * @returns {object}
 */
export function toUpdateBody(template) {
    return {
        components: template.components,
        ...(template.parameter_format && { parameter_format: template.parameter_format }),
    };
}

const COMPONENT_ORDER = ['HEADER', 'BODY', 'FOOTER', 'BUTTONS'];

/**
 * Replaces the BODY of `base` with the BODY of `bodySource` and keeps header, footer and buttons.
 * Used for CSV rows, which only carry body text.
 *
 * @param {Template} base - Existing template (file or live).
 * @param {Template} bodySource - Template whose BODY wins.
 * @returns {Template}
 */
export function mergeBody(base, bodySource) {
    const body = bodySource.components.find((component) => component.type === 'BODY');
    const others = (base.components ?? []).filter((component) => component.type !== 'BODY');
    const components = [...others, body].toSorted(
        (a, b) => COMPONENT_ORDER.indexOf(a.type) - COMPONENT_ORDER.indexOf(b.type),
    );
    return normalizeTemplate({
        ...base,
        components,
        parameter_format: bodySource.parameter_format ?? base.parameter_format,
    });
}
