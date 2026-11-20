import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
    loadDotenvFile,
    pickSourceWaba,
    pickTargetWabas,
    resolveToken,
    validateConfig,
} from '../lib/config.js';
import { readCsvTemplates, templatesFromRows } from '../lib/csv.js';
import { GraphError } from '../lib/errors.js';
import { createGraphClient } from '../lib/graph.js';
import { bodyTemplate, createFakeGraph, createRunRoot } from './helpers.js';

const run = createRunRoot();
after(() => run.cleanup());

describe('config', () => {
    const config = validateConfig(
        {
            stages: {
                dev: [{ wabaId: '1', tokenEnv: 'T_DEV' }],
                prod: [
                    { wabaId: '2', tokenEnv: 'T_PROD' },
                    { wabaId: '3', tokenEnv: 'T_PROD' },
                ],
            },
        },
        run.root,
    );

    it('applies defaults', () => {
        assert.equal(config.graphVersion, 'v23.0');
        assert.equal(config.templatesDir, path.join(run.root, 'templates'));
    });

    it('rejects invalid entries', () => {
        assert.throws(() => validateConfig({}, run.root), /"stages"/);
        assert.throws(
            () => validateConfig({ stages: { dev: [{ wabaId: 'abc', tokenEnv: 'T' }] } }, run.root),
            /wabaId/,
        );
        assert.throws(
            () => validateConfig({ stages: { dev: [{ wabaId: '1', tokenEnv: 'a-b' }] } }, run.root),
            /tokenEnv/,
        );
    });

    it('needs --from-waba for a source stage with several WABAs', () => {
        assert.equal(pickSourceWaba(config, 'dev').entry.wabaId, '1');
        assert.throws(() => pickSourceWaba(config, 'prod'), /--from-waba/);
        assert.deepEqual(pickSourceWaba(config, 'prod', '3'), {
            stage: 'prod',
            stages: ['prod'],
            entry: { wabaId: '3', tokenEnv: 'T_PROD' },
        });
        assert.throws(() => pickSourceWaba(config, 'prod', '9'), /not part of stage/);
        assert.throws(() => pickSourceWaba(config, 'qa'), /Unknown stage "qa"/);
        assert.throws(() => pickSourceWaba(config), /Missing --from or --from-waba/);
    });

    it('finds a WABA without a stage, unless its stages use different tokens', () => {
        const shared = validateConfig(
            {
                stages: {
                    qa: [{ wabaId: '5', tokenEnv: 'T_NONPROD' }],
                    uat: [{ wabaId: '5', tokenEnv: 'T_NONPROD' }],
                    prod: [{ wabaId: '6', tokenEnv: 'T_PROD' }],
                    special: [{ wabaId: '6', tokenEnv: 'T_OTHER' }],
                },
            },
            run.root,
        );
        assert.deepEqual(pickSourceWaba(shared, undefined, '5'), {
            stage: 'qa, uat',
            stages: ['qa', 'uat'],
            entry: { wabaId: '5', tokenEnv: 'T_NONPROD' },
        });
        assert.throws(
            () => pickSourceWaba(shared, undefined, '6'),
            /WABA 6 is in stages prod, special with different tokens; add --from <stage>/,
        );
        assert.throws(
            () => pickTargetWabas(shared, undefined, ['6']),
            /different tokens; add --to <stage>/,
        );
        assert.equal(pickSourceWaba(shared, 'special', '6').entry.tokenEnv, 'T_OTHER');
        assert.throws(() => pickSourceWaba(shared, undefined, '9'), /WABA 9 is not in/);
    });

    it('targets all WABAs of a stage, the ones named with --to-waba, or both', () => {
        assert.deepEqual(
            pickTargetWabas(config, 'prod').map((target) => target.entry.wabaId),
            ['2', '3'],
        );
        assert.deepEqual(
            pickTargetWabas(config, 'prod', ['3', '3']).map((target) => target.entry.wabaId),
            ['3'],
        );
        assert.throws(() => pickTargetWabas(config, 'prod', ['1', '3']), /WABA 1 is not part/);
        assert.deepEqual(pickTargetWabas(config, undefined, ['3', '1']), [
            { stage: 'prod', stages: ['prod'], entry: { wabaId: '3', tokenEnv: 'T_PROD' } },
            { stage: 'dev', stages: ['dev'], entry: { wabaId: '1', tokenEnv: 'T_DEV' } },
        ]);
        assert.throws(() => pickTargetWabas(config), /Missing --to or --to-waba/);
    });

    it('keeps a WABA listed twice in one stage once, with a warning', () => {
        const doubled = validateConfig(
            {
                stages: {
                    prod: [
                        { wabaId: '7', tokenEnv: 'T_PROD' },
                        { wabaId: '8', tokenEnv: 'T_PROD' },
                        { wabaId: '7', tokenEnv: 'T_OTHER' },
                    ],
                },
            },
            run.root,
        );
        assert.deepEqual(doubled.stages.prod, [
            { wabaId: '7', tokenEnv: 'T_PROD' },
            { wabaId: '8', tokenEnv: 'T_PROD' },
        ]);
        assert.equal(doubled.warnings.length, 1);
        assert.match(doubled.warnings[0], /stage "prod" lists WABA 7 more than once.*T_PROD/);
        assert.deepEqual(config.warnings, []);
    });

    it('names the missing token variable', () => {
        assert.throws(() => resolveToken({ wabaId: '1', tokenEnv: 'T_DEV' }, {}), /T_DEV/);
        assert.equal(resolveToken({ wabaId: '1', tokenEnv: 'T_DEV' }, { T_DEV: 'abc' }), 'abc');
    });

    it('loads .env, but shell variables win', () => {
        const directory = run.add('dotenv');
        const empty = run.add('no-dotenv');
        mkdirSync(directory);
        mkdirSync(empty);
        writeFileSync(path.join(directory, '.env'), 'T_DEV=from-file\nT_PROD=prod-file\n');
        const environment = { T_DEV: 'from-shell' };
        assert.deepEqual(loadDotenvFile(directory, environment), ['T_PROD']);
        assert.deepEqual(environment, { T_DEV: 'from-shell', T_PROD: 'prod-file' });
        assert.deepEqual(loadDotenvFile(empty, {}), []);
    });
});

describe('graph client', () => {
    it('follows paging until the last page', async () => {
        const templates = Array.from({ length: 7 }, (_, index) =>
            bodyTemplate(`t${index}`, 'fr', 'x'),
        );
        const graph = createFakeGraph({ wabas: { 1: { token: 'tok', templates, pageSize: 3 } } });
        const client = createGraphClient({
            token: 'tok',
            version: 'v23.0',
            fetchImpl: graph.fetchImpl,
        });
        const listed = await client.listTemplates('1');
        assert.equal(listed.length, 7);
        assert.equal(graph.calls.length, 3);
        assert.match(graph.calls[0].query.fields, /parameter_format/);
    });

    it('maps Graph errors and never puts the token into them', async () => {
        const graph = createFakeGraph({ wabas: { 1: { token: 'right' } } });
        const client = createGraphClient({
            token: 'secret-token',
            version: 'v23.0',
            fetchImpl: graph.fetchImpl,
        });
        await assert.rejects(client.listTemplates('1'), (ex) => {
            assert.ok(ex instanceof GraphError);
            assert.equal(ex.code, 190);
            assert.equal(ex.httpStatus, 401);
            assert.doesNotMatch(`${ex.describe()} ${ex.stack}`, /secret-token/);
            return true;
        });
    });

    it('refuses to follow a paging URL to another host', async () => {
        let calls = 0;
        const fetchImpl = async () => {
            calls++;
            return Response.json({ data: [], paging: { next: 'https://evil.example/next' } });
        };
        const client = createGraphClient({ token: 't', version: 'v23.0', fetchImpl });
        await assert.rejects(client.listTemplates('1'), /Refusing request to https:\/\/evil/);
        assert.equal(calls, 1);
    });
});

/**
 * One parsed CSV row as the parser returns it.
 *
 * @param {string} name
 * @param {string} language
 * @param {string} text
 * @param {string} [examples]
 * @returns {object}
 */
function row(name, language, text, examples = '') {
    return {
        'template name': name,
        category: 'Utility',
        'meta template': text,
        language,
        examples,
    };
}

describe('CSV import', () => {
    it('reads a Sheets export: BOM, quoted multi-line cells, emoji, extra columns', async () => {
        const file = run.add('sheet.csv');
        const csv = [
            'Brand,Template name,Category,Meta Template,Language,Examples',
            'Acme,wa_offer_it,Marketing,"Ciao {{1}}, congratulazioni 🎉!',
            'Ti ho inviato {{2}}.",it,Anna|un\'offerta',
            'Acme,wa_plain_fr,Utility,Bonjour !,fr,',
        ].join('\r\n');
        writeFileSync(file, `\u{FEFF}${csv}\r\n`);
        const { templates, errors } = await readCsvTemplates(file);
        assert.deepEqual(errors, []);
        assert.equal(templates.length, 2);
        const [offer, plain] = templates;
        assert.equal(offer.category, 'MARKETING');
        assert.equal(offer.parameter_format, 'POSITIONAL');
        assert.equal(
            offer.components[0].text,
            'Ciao {{1}}, congratulazioni 🎉!\r\nTi ho inviato {{2}}.',
        );
        assert.deepEqual(offer.components[0].example, { body_text: [['Anna', "un'offerta"]] });
        assert.equal(plain.components[0].example, undefined);
    });

    it('cleans up a messy export like sfmc-dataloader: padding columns, empty rows', async () => {
        const file = run.add('messy.csv');
        const csv = [
            'Brand,Template name,Category,Meta Template,Language,Examples,,',
            'Acme,wa_one,Utility,Hello,en_US,,,',
            ',,,,,,,',
            'Acme,wa_two,Marketing,Hi {{1}},fr,Anna,,',
            ',,,,,,,',
            ',,,,,,,',
        ].join('\n');
        writeFileSync(file, `${csv}\n`);
        const { templates, errors, cleanup } = await readCsvTemplates(file);
        assert.deepEqual(errors, []);
        assert.deepEqual(
            templates.map((template) => template.name),
            ['wa_one', 'wa_two'],
        );
        assert.deepEqual(cleanup, { removedColumns: 2, removedRecords: 0, skippedRecords: 3 });
    });

    for (const [label, newline] of [
        ['LF', '\n'],
        ['CRLF', '\r\n'],
        ['CR-only', '\r'],
    ]) {
        it(`reports the sheet row number after empty rows and multi-line cells (${label})`, async () => {
            const file = run.add(`rows-${label}.csv`);
            const csv = [
                'Template name,Category,Meta Template,Language',
                'wa_multi,Utility,"Line 1',
                'Line 2",en_US',
                ',,,',
                ',,,',
                'wa_bad,Utility,Hi {{1}},fr',
                'wa_bad2,Utility,Hi {{1}},it',
            ].join(newline);
            writeFileSync(file, `\u{FEFF}${csv}${newline}`);
            const { templates, errors } = await readCsvTemplates(file);
            assert.deepEqual(
                templates.map((template) => template.components[0].text),
                [`Line 1${newline}Line 2`],
            );
            assert.deepEqual(
                errors.map((error) => error.row),
                [5, 6],
            );
        });
    }

    it('rejects data in a padding column and a CSV without a header', async () => {
        const padded = run.add('padded.csv');
        writeFileSync(
            padded,
            'Template name,Category,Meta Template,Language,\nx,Utility,Hi,fr,oops\n',
        );
        await assert.rejects(readCsvTemplates(padded), /Could not read CSV .*right-padding/);
        const empty = run.add('empty.csv');
        writeFileSync(empty, '');
        await assert.rejects(readCsvTemplates(empty), /has no header row/);
    });

    it('reports row errors with sheet row numbers and keeps good rows', () => {
        const { templates, errors } = templatesFromRows([
            row('ok', 'fr', 'Hi'),
            row('no_lang', '', 'Hi'),
            row('vars', 'fr', 'Hi {{1}} {{2}}', 'only one'),
            row('ok', 'fr', 'Again'),
            row('named', 'fr', 'Hi {{first_name}}', 'x'),
            row('bad/name', 'fr', 'Hi'),
            row('gap', 'fr', 'Hi {{1}} {{2}} {{3}}', 'a||c|d'),
            { ...row('otp', 'fr', 'Code {{1}}', '123'), category: 'Authentication' },
        ]);
        assert.equal(templates.length, 1);
        assert.deepEqual(
            errors.map((error) => error.row),
            [3, 4, 5, 6, 7, 8, 9],
        );
        assert.match(errors[5].message, /3 variable\(s\).*2 non-empty/);
        assert.match(errors[6].message, /authentication/);
        assert.match(errors[1].message, /2 variable\(s\).*1 non-empty value/);
        assert.match(errors[2].message, /duplicate of row 2/);
        assert.match(errors[3].message, /numbered variables/);
    });

    it('fails when a required column is missing', () => {
        assert.throws(
            () =>
                templatesFromRows([{ 'template name': 'x', category: 'Utility', language: 'fr' }]),
            /"meta template"/,
        );
    });
});
