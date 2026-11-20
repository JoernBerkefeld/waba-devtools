import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { UsageError } from './errors.js';
import { readTemplateDirectory } from './files.js';
import { normalizeNewlines, templateKey } from './normalize.js';

/**
 * @typedef {object} FieldChange
 * @property {string} field - Readable field name, e.g. `Body text` or `Button 2 (URL) – URL`.
 * @property {string} [before] - Value in the older set (missing = the field did not exist).
 * @property {string} [after] - Value in the newer set (missing = the field was removed).
 */

/**
 * Compares two backup sets (restore points). The older one (by `createdAt` in its manifest) is
 * always "before", whatever order they are given in, so a removed template never looks added.
 *
 * @param {string} setA - Backup set folder.
 * @param {string} setB - Backup set folder.
 * @returns {Promise.<object>} Report: older, newer, added, removed, changed (with field changes),
 * unchanged count.
 */
export async function compareBackups(setA, setB) {
    const [first, second] = await Promise.all([readSet(setA), readSet(setB)]);
    const [older, newer] = isOlder(second, first) ? [second, first] : [first, second];
    const before = new Map(older.templates.map((template) => [templateKey(template), template]));
    const after = new Map(newer.templates.map((template) => [templateKey(template), template]));
    const added = [];
    const removed = [];
    const changed = [];
    let unchanged = 0;
    for (const [key, template] of after) {
        if (!before.has(key)) {
            added.push(summary(template, newer));
        }
    }
    for (const [key, template] of before) {
        const next = after.get(key);
        if (!next) {
            removed.push(summary(template, older));
            continue;
        }
        const changes = fieldChanges(template, next);
        if (changes.length === 0) {
            unchanged++;
        } else {
            changed.push({ ...summary(next, newer), statusBefore: older.status.get(key), changes });
        }
    }
    return {
        command: 'compare',
        older: older.info,
        newer: newer.info,
        sameWaba: older.info.wabaId === newer.info.wabaId,
        added: added.toSorted(byKey),
        removed: removed.toSorted(byKey),
        changed: changed.toSorted(byKey),
        unchanged,
        ok: true,
    };
}

/**
 * Sort order: name, then language.
 *
 * @param {{name: string, language: string}} a
 * @param {{name: string, language: string}} b
 * @returns {number}
 */
function byKey(a, b) {
    return templateKey(a).localeCompare(templateKey(b));
}

/**
 * Button settings shown as their own fields; anything else ends up in "other settings".
 */
const KNOWN_BUTTON_KEYS = new Set(['type', 'text', 'url', 'example', 'phone_number']);

/**
 * @param {{info: {createdAt: string, phase?: string}}} a
 * @param {{info: {createdAt: string, phase?: string}}} b
 * @returns {boolean} True when `a` was taken before `b`.
 */
function isOlder(a, b) {
    return a.info.createdAt === b.info.createdAt
        ? a.info.phase === 'before' && b.info.phase === 'after'
        : a.info.createdAt < b.info.createdAt;
}

/**
 * Reads a backup set: its manifest and its templates.
 *
 * @param {string} directory
 * @returns {Promise.<{info: object, templates: object[], status: Map.<string, string>}>}
 */
async function readSet(directory) {
    let manifest;
    try {
        manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    } catch (ex) {
        throw new UsageError(
            `${directory} is not a backup set (no readable manifest.json): ${ex.message}`,
        );
    }
    if (manifest.tool !== 'waba-devtools' || !manifest.createdAt || !manifest.wabaId) {
        throw new UsageError(`${directory}: manifest.json is not a waba-devtools backup manifest.`);
    }
    const templates = await readTemplateDirectory(directory);
    const status = new Map(
        (manifest.templates ?? []).map((template) => [templateKey(template), template.status]),
    );
    return {
        info: {
            dir: directory,
            wabaId: manifest.wabaId,
            stage: manifest.stage,
            createdAt: manifest.createdAt,
            phase: manifest.phase,
        },
        templates,
        status,
    };
}

/**
 * @param {object} template
 * @param {{status: Map.<string, string>}} set
 * @returns {{name: string, language: string, category?: string, status?: string}}
 */
function summary(template, set) {
    return {
        name: template.name,
        language: template.language,
        category: template.category,
        status: set.status.get(templateKey(template)),
    };
}

/**
 * Field-by-field differences, with readable field names. Line endings do not count.
 *
 * @param {object} before
 * @param {object} after
 * @returns {FieldChange[]}
 */
export function fieldChanges(before, after) {
    const old = readableFields(before);
    const next = readableFields(after);
    const changes = [];
    const allFields = new Set([...old.keys(), ...next.keys()]);
    for (const field of allFields) {
        if (old.get(field) !== next.get(field)) {
            changes.push({ field, before: old.get(field), after: next.get(field) });
        }
    }
    return changes;
}

/**
 * Flattens a template into readable field names and text values.
 *
 * @param {object} template
 * @returns {Map.<string, string>}
 */
function readableFields(template) {
    const fields = new Map();
    const put = (field, value) => {
        if (![undefined, null, ''].includes(value)) {
            fields.set(field, typeof value === 'string' ? value : JSON.stringify(value));
        }
    };
    const clean = normalizeNewlines(template);
    put('Category', clean.category);
    put('Variable format', clean.parameter_format ?? 'POSITIONAL');
    const components = clean.components ?? [];
    for (const component of components) {
        addComponentFields(component, put);
    }
    return fields;
}

/**
 * @param {object} component
 * @param {(field: string, value: any) => void} put
 * @returns {void}
 */
function addComponentFields(component, put) {
    switch (component.type) {
        case 'HEADER': {
            put('Header type', component.format);
            put('Header text', component.text);
            put('Header example', component.example?.header_text?.join(', '));
            put('Header media example', component.example?.header_handle?.join(', '));
            break;
        }
        case 'BODY': {
            put('Body text', component.text);
            put('Body examples', component.example?.body_text?.[0]?.join(', '));
            put('Body named examples', component.example?.body_text_named_params);
            break;
        }
        case 'FOOTER': {
            put('Footer text', component.text);
            break;
        }
        case 'BUTTONS': {
            const buttons = component.buttons ?? [];
            for (const [index, button] of buttons.entries()) {
                const label = `Button ${index + 1} (${button.type})`;
                put(`${label} – text`, button.text);
                put(`${label} – URL`, button.url);
                put(`${label} – URL example`, button.example?.join?.(', ') ?? button.example);
                put(`${label} – phone number`, button.phone_number);
                const rest = Object.fromEntries(
                    Object.entries(button).filter(([key]) => !KNOWN_BUTTON_KEYS.has(key)),
                );
                if (Object.keys(rest).length > 0) {
                    put(`${label} – other settings`, rest);
                }
            }
            break;
        }
        default: {
            put(`${component.type} (other part)`, component);
        }
    }
}
