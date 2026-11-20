import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import csv, { replayFiles, validateFile } from '@joern.berkefeld/csv-parser';
import { UsageError } from './errors.js';
import { assertSafeIdentity, normalizeTemplate, templateKey } from './normalize.js';

/**
 * CSV columns: our key → accepted header names (compared case-insensitively, trimmed). Other
 * columns are ignored.
 */
export const CSV_COLUMNS = {
    name: ['template name'],
    category: ['category'],
    language: ['language'],
    body: ['body', 'meta template'],
    examples: ['body examples', 'examples'],
    header: ['header'],
    headerExample: ['header example'],
    footer: ['footer'],
    quickReplies: ['quick replies'],
    urlButton: ['url button'],
    urlExample: ['url example'],
    callButton: ['call button'],
};

const REQUIRED_COLUMNS = ['name', 'category', 'body', 'language'];
const BUTTON_COLUMNS = new Map([
    ['quickReplies', 'QUICK_REPLY'],
    ['urlButton', 'URL'],
    ['callButton', 'PHONE_NUMBER'],
]);
const VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * @typedef {object} CsvRowError
 * @property {number} row - Line number in the sheet (header = 1).
 * @property {string} message
 */

/**
 * @typedef {object} CsvResult
 * @property {import('./normalize.js').Template[]} templates - One template per good row.
 * @property {CsvRowError[]} errors
 * @property {string[]} parts - Template parts the sheet defines (BODY always; HEADER, FOOTER,
 * BUTTON:<type> per button column it has).
 * @property {CsvCleanup} [cleanup] - What was cleaned up while reading the file.
 */

/**
 * @typedef {object} CsvCleanup
 * @property {number} removedColumns - Empty columns removed on the right (no header, no values).
 * @property {number} removedRecords - Empty rows removed at the bottom.
 * @property {number} skippedRecords - Empty rows skipped in between.
 */

/**
 * Parser options, the same as sfmc-dataloader uses for its CSV imports: strict width and quoting,
 * BOM removal, empty rows skipped, empty right-padding columns and bottom rows removed.
 */
const PARSER_OPTIONS = {
    bom: true,
    strict: true,
    strictQuotes: true,
    skipEmptyLines: true,
    sanitizeRightPadding: true,
    sanitizeBottom: true,
    mapHeaders: ({ header }) => header.trim().toLowerCase(),
    outputByteOffset: true,
};

/**
 * Line ending of the file, taken from the end of the header line: `\r` for old Mac exports,
 * otherwise `\n` (the parser handles `\r\n` with it).
 *
 * @param {string} file
 * @returns {Promise.<string>}
 */
async function detectNewline(file) {
    const handle = await open(file);
    try {
        const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(64 * 1024) });
        const text = buffer.subarray(0, bytesRead).toString('latin1');
        const end = text.search(/[\r\n]/);
        return end !== -1 && text[end] === '\r' && text[end + 1] !== '\n' ? '\r' : '\n';
    } finally {
        await handle.close();
    }
}

/**
 * Row number in the sheet of every record in the file, by byte offset. Counts every record,
 * also the empty ones that are skipped while parsing.
 *
 * @param {string} file
 * @param {string} newline - From `detectNewline`, so both passes split records the same way.
 * @returns {Promise.<Map.<number, number>>} Byte offset to row number.
 */
async function recordOffsets(file, newline) {
    const rowNumbers = new Map();
    const parser = createReadStream(file).pipe(
        csv({ bom: true, headers: false, skipEmptyLines: false, outputByteOffset: true, newline }),
    );
    for await (const { byteOffset } of parser) {
        rowNumbers.set(byteOffset, rowNumbers.size + 1);
    }
    return rowNumbers;
}

/**
 * Reads a Google Sheets (or other) CSV export into body-only templates.
 *
 * @param {string} file - CSV path.
 * @returns {Promise.<CsvResult>}
 */
export async function readCsvTemplates(file) {
    const rows = [];
    const rowNumbers = [];
    let validation;
    try {
        const newline = await detectNewline(file);
        validation = await validateFile(file, { ...PARSER_OPTIONS, newline });
        const offsets = await recordOffsets(file, newline);
        for await (const { row, byteOffset } of replayFiles(validation)) {
            rows.push(row);
            const rowNumber = offsets.get(byteOffset);
            if (rowNumber === undefined) {
                throw new Error(`no row number for the record at byte ${byteOffset}`);
            }
            rowNumbers.push(rowNumber);
        }
    } catch (ex) {
        throw new UsageError(`Could not read CSV ${file}: ${ex.message}`);
    }
    if (!validation.headers || validation.headers.length === 0) {
        throw new UsageError(`CSV ${file} has no header row.`);
    }
    const { removedColumns, removedRecords, skippedRecords } = validation.cleanup;
    return {
        ...templatesFromRows(rows, rowNumbers),
        cleanup: { removedColumns, removedRecords, skippedRecords },
    };
}

/**
 * @param {Object.<string, string>[]} rows - Parsed rows keyed by lower-case header.
 * @param {number[]} [rowNumbers] - Row number in the sheet per row (default: header = 1, no gaps).
 * @returns {CsvResult}
 */
export function templatesFromRows(rows, rowNumbers = rows.map((_, index) => index + 2)) {
    const columns = resolveColumns(rows.length > 0 ? Object.keys(rows[0]) : []);
    if (rows.length > 0) {
        const missing = REQUIRED_COLUMNS.filter((key) => !columns.has(key));
        if (missing.length > 0) {
            const names = missing
                .map((key) => CSV_COLUMNS[key].map((alias) => `"${alias}"`).join(' or '))
                .join(', ');
            throw new UsageError(`CSV is missing the column(s) ${names}.`);
        }
    }
    const templates = [];
    const errors = [];
    const seen = new Map();
    for (const [index, row] of rows.entries()) {
        const line = rowNumbers[index];
        try {
            const template = templateFromRow(row, columns);
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
    return { templates, errors, parts: partsOf(columns) };
}

/**
 * Which of our columns the sheet has, mapped to the sheet's (lower-case) header.
 *
 * @param {string[]} headers
 * @returns {Map.<string, string>} Column key to header.
 */
function resolveColumns(headers) {
    const present = new Set(headers);
    const columns = new Map();
    for (const [key, aliases] of Object.entries(CSV_COLUMNS)) {
        const header = aliases.find((alias) => present.has(alias));
        if (header) {
            columns.set(key, header);
        }
    }
    return columns;
}

/**
 * The template parts the sheet defines. A part without a column stays as it is in the target.
 *
 * @param {Map.<string, string>} columns
 * @returns {string[]}
 */
function partsOf(columns) {
    const parts = ['BODY'];
    if (columns.has('header')) {
        parts.push('HEADER');
    }
    if (columns.has('footer')) {
        parts.push('FOOTER');
    }
    for (const [key, type] of BUTTON_COLUMNS) {
        if (columns.has(key)) {
            parts.push(`BUTTON:${type}`);
        }
    }
    return parts;
}

/**
 * The numbered variables of a text: their count, or an error for named ones.
 *
 * @param {string} text
 * @returns {number} Highest variable number (0 = none).
 */
function variableCount(text) {
    let count = 0;
    for (const [, variable] of text.matchAll(VARIABLE)) {
        if (!/^\d+$/.test(variable)) {
            throw new Error(
                `only numbered variables like {{1}} are supported, found {{${variable}}}`,
            );
        }
        count = Math.max(count, Number(variable));
    }
    return count;
}

/**
 * Splits `label|value` cells (URL and call buttons).
 *
 * @param {string} cell
 * @param {string} column - For the error message.
 * @returns {[string, string]}
 */
function splitPair(cell, column) {
    const separator = cell.indexOf('|');
    const label = separator === -1 ? '' : cell.slice(0, separator).trim();
    const value = separator === -1 ? '' : cell.slice(separator + 1).trim();
    if (!label || !value) {
        throw new Error(`${column}: write label|value, e.g. "Track|https://example.com/{{1}}"`);
    }
    return [label, value];
}

/**
 * @param {(key: string) => string} value
 * @returns {object|undefined} BODY component.
 */
function bodyComponent(value) {
    const text = value('body');
    const count = variableCount(text);
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
    return body;
}

/**
 * @param {(key: string) => string} value
 * @returns {object|undefined} HEADER component (text only), or none for an empty cell.
 */
function headerComponent(value) {
    const text = value('header');
    if (!text) {
        return;
    }
    const count = variableCount(text);
    if (count > 1 || (count === 1 && !text.includes('{{1}}'))) {
        throw new Error('Header: at most one variable, written {{1}}');
    }
    const header = { type: 'HEADER', format: 'TEXT', text };
    if (count === 1) {
        const example = value('headerExample');
        if (!example) {
            throw new Error('Header has {{1}}: fill in the Header example column');
        }
        header.example = { header_text: [example] };
    }
    return header;
}

/**
 * @param {(key: string) => string} value
 * @returns {object|undefined} FOOTER component, or none for an empty cell.
 */
function footerComponent(value) {
    const text = value('footer');
    if (!text) {
        return;
    }
    if (text.includes('{{')) {
        throw new Error('Footer: variables are not allowed');
    }
    return { type: 'FOOTER', text };
}

/**
 * @param {(key: string) => string} value
 * @returns {object|undefined} BUTTONS component, or none when all button cells are empty.
 */
function buttonsComponent(value) {
    const buttons = value('quickReplies')
        .split('|')
        .map((label) => label.trim())
        .filter(Boolean)
        .map((text) => ({ type: 'QUICK_REPLY', text }));
    if (value('urlButton')) {
        const [text, url] = splitPair(value('urlButton'), 'URL button');
        if (!/^https?:\/\//.test(url)) {
            throw new Error('URL button: the URL must start with https:// or http://');
        }
        const count = variableCount(url);
        const button = { type: 'URL', text, url };
        if (count > 0) {
            if (count > 1 || !url.endsWith('{{1}}')) {
                throw new Error('URL button: only one variable, {{1}} at the very end of the URL');
            }
            const example = value('urlExample');
            if (!example) {
                throw new Error('URL button has {{1}}: fill in the URL example column');
            }
            button.example = [url.replace('{{1}}', () => example)];
        }
        buttons.push(button);
    }
    if (value('callButton')) {
        const [text, phone] = splitPair(value('callButton'), 'Call button');
        const phoneNumber = phone.replaceAll(/[\s()-]/g, '');
        if (!/^\+\d{6,15}$/.test(phoneNumber)) {
            throw new Error('Call button: phone number with country code, e.g. +15550100');
        }
        buttons.push({ type: 'PHONE_NUMBER', text, phone_number: phoneNumber });
    }
    return buttons.length > 0 ? { type: 'BUTTONS', buttons } : undefined;
}

/**
 * @param {Object.<string, string>} row
 * @param {Map.<string, string>} columns - From `resolveColumns`.
 * @returns {import('./normalize.js').Template}
 */
function templateFromRow(row, columns) {
    const value = (key) =>
        columns.has(key)
            ? String(row[columns.get(key)] ?? '')
                  .replaceAll(/\r\n?/g, '\n')
                  .trim()
            : '';
    const name = value('name');
    const language = value('language');
    const category = value('category');
    if (!name || !language || !category || !value('body')) {
        throw new Error('template name, language, category and body text are all required');
    }
    assertSafeIdentity({ name, language });
    if (category.toUpperCase() === 'AUTHENTICATION') {
        throw new Error('authentication (OTP) templates are not supported yet');
    }
    const components = [
        headerComponent(value),
        bodyComponent(value),
        footerComponent(value),
        buttonsComponent(value),
    ].filter(Boolean);
    return normalizeTemplate({
        name,
        language,
        category,
        parameter_format: 'POSITIONAL',
        components,
    });
}
