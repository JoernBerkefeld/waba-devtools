/**
 * Statuses in which Meta accepts an edit of an existing template.
 */
export const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED']);

/**
 * Note for Meta's sample templates, which Meta adds to new WABAs and refuses to edit or delete
 * (error #100/2388094, checked 2026-11).
 */
export const META_SAMPLE_NOTE =
    "Meta's sample template — Meta does not allow editing or deleting it";

/**
 * Whether a live template is one of Meta's sample templates (`hello_world`, `jaspers_market_*`).
 *
 * @param {{name: string}} template
 * @returns {boolean}
 */
export function isMetaSampleTemplate(template) {
    return /^(?:hello_world|jaspers_market_\w+)$/.test(template.name);
}

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
        sortKeys(
            normalizeNewlines({
                components: template.components ?? [],
                parameter_format: template.parameter_format ?? 'POSITIONAL',
            }),
        ),
    );
}

/**
 * Copy with `\r\n` and `\r` turned into `\n` in every string, so line endings never count as a change.
 *
 * @param {any} value
 * @returns {any}
 */
export function normalizeNewlines(value) {
    if (typeof value === 'string') {
        return value.replaceAll(/\r\n?/g, '\n');
    }
    if (Array.isArray(value)) {
        return value.map(normalizeNewlines);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, normalizeNewlines(item)]),
        );
    }
    return value;
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
 * Replaces the given component types of `base` with those of `source` (removing them when
 * `source` has none) and keeps all other components. Used for CSV rows: the sheet defines only the
 * parts it has columns for.
 *
 * @param {Template} base - Existing template (file or live).
 * @param {Template} source - Template whose listed parts win.
 * @param {string[]} parts - Component types from `source`, e.g. `['BODY', 'FOOTER']`; buttons per
 * type as `BUTTON:QUICK_REPLY`, `BUTTON:URL`, `BUTTON:PHONE_NUMBER` (other button types are kept).
 * @returns {Template}
 */
export function mergeParts(base, source, parts) {
    const owned = new Set(parts);
    const ownedButtons = new Set(
        parts.filter((part) => part.startsWith('BUTTON:')).map((part) => part.slice(7)),
    );
    const kept = (base.components ?? []).filter(
        (component) => !owned.has(component.type) && component.type !== 'BUTTONS',
    );
    const taken = source.components.filter(
        (component) => owned.has(component.type) && component.type !== 'BUTTONS',
    );
    const buttons = mergeButtons(
        buttonsOf(base).filter((button) => !ownedButtons.has(button.type)),
        buttonsOf(source).filter((button) => ownedButtons.has(button.type)),
    );
    const components = [
        ...kept,
        ...taken,
        ...(buttons.length > 0 ? [{ type: 'BUTTONS', buttons }] : []),
    ].toSorted((a, b) => componentRank(a) - componentRank(b));
    return normalizeTemplate({
        ...base,
        components,
        parameter_format: source.parameter_format ?? base.parameter_format,
    });
}

/**
 * Replaces the BODY of `base` with the BODY of `bodySource` and keeps header, footer and buttons.
 *
 * @param {Template} base - Existing template (file or live).
 * @param {Template} bodySource - Template whose BODY wins.
 * @returns {Template}
 */
export function mergeBody(base, bodySource) {
    return mergeParts(base, bodySource, ['BODY']);
}

/**
 * @param {Template} template
 * @returns {object[]} Its buttons (none without a BUTTONS component).
 */
function buttonsOf(template) {
    return (
        (template.components ?? []).find((component) => component.type === 'BUTTONS')?.buttons ?? []
    );
}

/**
 * Kept and new buttons in one list; quick replies first, so they stay grouped as Meta requires.
 *
 * @param {object[]} kept
 * @param {object[]} taken
 * @returns {object[]}
 */
function mergeButtons(kept, taken) {
    const all = [...kept, ...taken];
    return [
        ...all.filter((button) => button.type === 'QUICK_REPLY'),
        ...all.filter((button) => button.type !== 'QUICK_REPLY'),
    ];
}

/**
 * Position of a component (header, body, footer, buttons); unknown types go last.
 *
 * @param {{type: string}} component
 * @returns {number}
 */
function componentRank(component) {
    const index = COMPONENT_ORDER.indexOf(component.type);
    return index === -1 ? COMPONENT_ORDER.length : index;
}
