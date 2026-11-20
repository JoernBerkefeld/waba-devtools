import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import csv from '@joern.berkefeld/csv-parser';
import { UsageError } from './errors.js';
import { assertSafeIdentity, normalizeTemplate, templateKey } from './normalize.js';

/**
 * CSV column headers (compared case-insensitively, trimmed). Other columns are ignored.
 */
export const CSV_COLUMNS = {
    name: 'template name',
    category: 'category',
    body: 'meta template',
    language: 'language',
    examples: 'examples',
};

const REQUIRED_COLUMNS = ['name', 'category', 'body', 'language'];
const VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * @typedef {object} CsvRowError
 * @property {number} row - Line number in the sheet (header = 1).
 * @property {string} message
 */

/**
 * @typedef {object} CsvResult
 * @property {import('./normalize.js').Template[]} templates - Body-only templates, one per row.
 * @property {CsvRowError[]} errors
 */

/**
 * Reads a Google Sheets (or other) CSV export into body-only templates.
 *
 * @param {string} file - CSV path.
 * @returns {Promise.<CsvResult>}
 */
export async function readCsvTemplates(file) {
    const rows = [];
    const parser = csv({
        bom: true,
        strict: true,
        skipEmptyLines: true,
        mapHeaders: ({ header }) => header.trim().toLowerCase(),
    });
    parser.on('data', (row) => {
        rows.push(row);
    });
    try {
        await pipeline(createReadStream(file), parser);
    } catch (ex) {
        throw new UsageError(`Could not read CSV ${file}: ${ex.message}`);
    }
    return templatesFromRows(rows);
}

/**
 * @param {Object.<string, string>[]} rows - Parsed rows keyed by lower-case header.
 * @returns {CsvResult}
 */
export function templatesFromRows(rows) {
    if (rows.length > 0) {
        const headers = new Set(Object.keys(rows[0]));
        const missing = REQUIRED_COLUMNS.filter((column) => !headers.has(CSV_COLUMNS[column]));
        if (missing.length > 0) {
            const names = missing.map((column) => `"${CSV_COLUMNS[column]}"`).join(', ');
            throw new UsageError(`CSV is missing the column(s) ${names}.`);
        }
    }
    const templates = [];
    const errors = [];
    const seen = new Map();
    for (const [index, row] of rows.entries()) {
        const line = index + 2;
        try {
            const template = templateFromRow(row);
            const key = templateKey(template);
            if (seen.has(key)) {
                throw new Error(
                    `duplicate of row ${seen.get(key)} (${template.name}, ${template.language})`,
                );
            }
            seen.set(key, line);
            templates.push(template);
        } catch (ex) {
            errors.push({ row: line, message: ex.message });
        }
    }
    return { templates, errors };
}

/**
 * @param {Object.<string, string>} row
 * @returns {import('./normalize.js').Template}
 */
function templateFromRow(row) {
    const value = (column) => String(row[CSV_COLUMNS[column]] ?? '').trim();
    const name = value('name');
    const language = value('language');
    const category = value('category');
    const text = value('body');
    if (!name || !language || !category || !text) {
        throw new Error('template name, language, category and template text are all required');
    }
    assertSafeIdentity({ name, language });
    if (category.toUpperCase() === 'AUTHENTICATION') {
        throw new Error('authentication (OTP) templates are not supported yet');
    }
    const variables = new Set();
    for (const [, variable] of text.matchAll(VARIABLE)) {
        if (!/^\d+$/.test(variable)) {
            throw new Error(
                `only numbered variables like {{1}} are supported, found {{${variable}}}`,
            );
        }
        variables.add(Number(variable));
    }
    const count = variables.size === 0 ? 0 : Math.max(...variables);
    const body = { type: 'BODY', text };
    if (count > 0) {
        const examples = value('examples')
            .split('|')
            .map((example) => example.trim());
        const missingExample = examples.slice(0, count).includes('');
        if (missingExample || examples.length < count) {
            throw new Error(
                `text uses ${count} variable(s) but the Examples column has ` +
                    `${examples.slice(0, count).filter((example) => example !== '').length} ` +
                    `non-empty value(s) for them; give one per variable, separated by |`,
            );
        }
        body.example = { body_text: [examples.slice(0, count)] };
    }
    return normalizeTemplate({
        name,
        language,
        category,
        parameter_format: 'POSITIONAL',
        components: [body],
    });
}
