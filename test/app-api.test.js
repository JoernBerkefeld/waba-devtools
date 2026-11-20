import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../lib/cli.js';
import {
    compareBackups,
    deploy,
    discoverWabas,
    listTemplates,
    validateConfig,
} from '../lib/index.js';
import { bodyTemplate, createFakeGraph, createRunRoot } from './helpers.js';

const run = createRunRoot();
after(() => run.cleanup());

/**
 * The library used the way the desktop app uses it: config and tokens only in memory.
 *
 * @param {object} [templates] - Templates per WABA id.
 * @returns {object}
 */
function appSetup(templates = {}) {
    const graph = createFakeGraph({
        wabas: {
            1: { token: 'tok-a', name: 'Dev', templates: templates[1] },
            2: { token: 'tok-a', name: 'QA', templates: templates[2] },
            3: {
                token: 'tok-b',
                name: 'Prod',
                templates: templates[3],
                phoneNumbers: [
                    { id: 'p1', display_phone_number: '+1 555 0100', verified_name: 'Acme' },
                ],
            },
        },
        tokenInfo: { 'tok-none': { is_valid: true, granular_scopes: [] } },
    });
    const config = validateConfig(
        {
            stages: {
                dev: [{ wabaId: '1', tokenEnv: 'WABA_TOKEN_1' }],
                qa: [{ wabaId: '2', tokenEnv: 'WABA_TOKEN_1' }],
                prod: [{ wabaId: '3', tokenEnv: 'WABA_TOKEN_2' }],
            },
        },
        run.root,
    );
    const environment = { WABA_TOKEN_1: 'tok-a', WABA_TOKEN_2: 'tok-b' };
    const common = { cwd: run.root, config, environment, fetchImpl: graph.fetchImpl };
    const writes = () => graph.calls.filter((call) => call.method !== 'GET');
    return { graph, common, writes };
}

describe('library API for the app', () => {
    it('lists templates without components, sorted, for a source or for targets', async () => {
        const { common, graph } = appSetup({
            1: [
                bodyTemplate('b', 'fr', 'B'),
                bodyTemplate('a', 'it', 'A'),
                bodyTemplate('a', 'de', 'A'),
            ],
            3: [bodyTemplate('x', 'fr', 'X')],
        });
        const source = await listTemplates({ ...common, fromWaba: '1' });
        assert.equal(source.ok, true);
        assert.deepEqual(source.wabas[0].templates, [
            { name: 'a', language: 'de', category: 'UTILITY', status: 'APPROVED' },
            { name: 'a', language: 'it', category: 'UTILITY', status: 'APPROVED' },
            { name: 'b', language: 'fr', category: 'UTILITY', status: 'APPROVED' },
        ]);
        assert.equal(graph.calls[0].query.fields, 'id,name,language,category,status');

        const targets = await listTemplates({ ...common, toWabas: ['2', '3'] });
        assert.deepEqual(
            targets.wabas.map((waba) => [waba.stage, waba.templates.length]),
            [
                ['qa', 0],
                ['prod', 1],
            ],
        );
        await assert.rejects(
            listTemplates({ ...common, fromWaba: '1', toWabas: ['2'] }),
            /either a source .* or targets/,
        );
    });

    it('discovers the WABAs of a token with names and phone numbers', async () => {
        const { graph } = appSetup();
        const result = await discoverWabas({ token: 'tok-b', fetchImpl: graph.fetchImpl });
        assert.deepEqual(result, {
            command: 'discover',
            ok: true,
            wabas: [
                {
                    wabaId: '3',
                    name: 'Prod',
                    phoneNumbers: [
                        { id: 'p1', displayPhoneNumber: '+1 555 0100', verifiedName: 'Acme' },
                    ],
                },
            ],
        });
        await assert.rejects(
            discoverWabas({ token: 'nope', fetchImpl: graph.fetchImpl }),
            /not valid/,
        );
        await assert.rejects(
            discoverWabas({ token: 'tok-none', fetchImpl: graph.fetchImpl }),
            /no whatsapp_business_management permission/,
        );
    });

    it('sends exactly the confirmed preview, and reports progress', async () => {
        const { common, graph, writes } = appSetup({
            1: [bodyTemplate('a', 'fr', 'A'), bodyTemplate('b', 'fr', 'B')],
            2: [bodyTemplate('a', 'fr', 'old')],
            3: [],
        });
        const options = { ...common, fromWaba: '1', toWabas: ['2', '3'] };
        const preview = await deploy({ ...options, dryRun: true });
        assert.equal(writes().length, 0);

        const events = [];
        const result = await deploy({
            ...options,
            expectedActions: preview.targets,
            onProgress: (event) => {
                events.push(event);
            },
        });
        assert.equal(result.ok, true);
        assert.equal(writes().length, 4, 'qa: update a, create b; prod: create a, b');
        assert.deepEqual(
            events.map((event) => [event.wabaId, event.targetIndex, event.done, event.total]),
            [
                ['2', 0, 1, 2],
                ['2', 0, 2, 2],
                ['3', 1, 1, 2],
                ['3', 1, 2, 2],
            ],
        );
        assert.equal(events[0].targetCount, 2);
        assert.equal(graph.wabas[3].templates.length, 2);
    });

    it('sends nothing to a target that changed since the preview', async () => {
        const { common, graph, writes } = appSetup({
            1: [bodyTemplate('a', 'fr', 'A')],
            2: [],
            3: [],
        });
        const options = { ...common, fromWaba: '1', toWabas: ['2', '3'] };
        const preview = await deploy({ ...options, dryRun: true });

        // Someone creates "a" in QA between preview and confirm: create → update.
        graph.wabas[2].templates.push({
            ...bodyTemplate('a', 'fr', 'other'),
            id: '1',
            status: 'APPROVED',
        });

        const result = await deploy({ ...options, expectedActions: preview.targets });
        assert.equal(result.ok, false);
        const [qa, production] = result.targets;
        assert.equal(qa.error, 'changed since preview — run the preview again');
        assert.equal(production.error, undefined);
        assert.equal(writes().length, 1, 'only prod got its create');
        assert.equal(graph.wabas[2].templates[0].components[0].text, 'other');
    });

    it('sends nothing to a target that is missing from the confirmed preview', async () => {
        const { common, writes } = appSetup({ 1: [bodyTemplate('a', 'fr', 'A')], 2: [], 3: [] });
        const options = { ...common, fromWaba: '1', toWabas: ['2', '3'] };
        const preview = await deploy({ ...options, dryRun: true });
        const onlyProduction = preview.targets.filter((target) => target.wabaId === '3');

        const partial = await deploy({ ...options, expectedActions: onlyProduction });
        assert.equal(partial.targets[0].error, 'changed since preview — run the preview again');
        assert.equal(writes().length, 1, 'only the confirmed prod create was sent');

        const none = await deploy({ ...options, expectedActions: [] });
        // QA still has its create pending; prod got "a" above and has nothing left to send.
        assert.equal(none.targets[0].error, 'changed since preview — run the preview again');
        assert.equal(none.targets[1].error, undefined);
        assert.equal(writes().length, 1, 'an empty confirmation sends nothing');
    });
});

describe('wabadev list / discover', () => {
    it('list prints templates per WABA; discover needs only the token variable', async () => {
        const { graph } = appSetup({ 3: [bodyTemplate('x', 'fr', 'X')] });
        const cwd = run.add('no-config');
        const { mkdirSync, writeFileSync } = await import('node:fs');
        mkdirSync(cwd);
        const out = [];
        const error = [];
        const cli = (arguments_, environment) =>
            main(arguments_, {
                cwd,
                environment,
                fetchImpl: graph.fetchImpl,
                out: (text) => {
                    out.push(text);
                },
                err: (text) => {
                    error.push(text);
                },
            });

        assert.equal(await cli(['discover', '--token-env', 'T'], { T: 'tok-b' }), 0);
        assert.match(out.at(-1), /WABA 3 {2}Prod {2}\+1 555 0100 \(Acme\)/);
        assert.equal(await cli(['discover', '--token-env', 'T'], {}), 2);
        assert.match(error.at(-1), /T is not set/);
        assert.doesNotMatch([...out, ...error].join('\n'), /tok-b/, 'the token is never printed');

        writeFileSync(
            `${cwd}/.wabadevrc.json`,
            JSON.stringify({ stages: { prod: [{ wabaId: '3', tokenEnv: 'T' }] } }),
        );
        assert.equal(await cli(['list', '--to', 'prod'], { T: 'tok-b' }), 0);
        assert.match(
            out.at(-1),
            /prod — WABA 3:\n {2}x \(fr\) UTILITY \[APPROVED\]\n {2}= 1 template\(s\)/,
        );
    });
});

describe('backups and restore', () => {
    it('writes one set per changed WABA, named by WABA ID and time, and restores from it', async () => {
        const { readFileSync, existsSync, readdirSync } = await import('node:fs');
        const { common, graph, writes } = appSetup({
            1: [bodyTemplate('a', 'fr', 'new')],
            2: [bodyTemplate('a', 'fr', 'old'), bodyTemplate('keep', 'fr', 'K')],
            3: [bodyTemplate('a', 'fr', 'new')],
        });
        const root = run.add('backups');
        const result = await deploy({
            ...common,
            fromWaba: '1',
            toWabas: ['2', '3'],
            backupDir: root,
        });
        assert.equal(result.ok, true);
        assert.equal(writes().length, 1, 'qa: update a; prod is identical');

        const [set] = readdirSync(root);
        assert.match(set, /^2_\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_before$/);
        assert.equal(readdirSync(root).length, 1, 'no set for a WABA without changes');
        assert.equal(result.targets[0].backup, path.join(root, set));
        const manifest = JSON.parse(readFileSync(path.join(root, set, 'manifest.json'), 'utf8'));
        assert.equal(manifest.tool, 'waba-devtools');
        assert.equal(manifest.wabaId, '2');
        assert.equal(manifest.stage, 'qa');
        assert.deepEqual(manifest.source, {
            type: 'waba',
            stage: 'dev',
            stages: ['dev'],
            wabaId: '1',
        });
        assert.deepEqual(manifest.templates, [
            { name: 'a', language: 'fr', category: 'UTILITY', status: 'APPROVED' },
            { name: 'keep', language: 'fr', category: 'UTILITY', status: 'APPROVED' },
        ]);
        assert.ok(existsSync(path.join(root, set, 'keep', 'fr.json')), 'the full set');

        // The same root works for the next run: a second set next to the first.
        graph.wabas[1].templates[0].components[0].text = 'newer';
        graph.wabas[2].templates[0].status = 'APPROVED';
        await deploy({ ...common, fromWaba: '1', toWabas: ['2'], backupDir: root });
        assert.equal(readdirSync(root).length, 2);

        // Restore the first set (the manifest next to the template folders is ignored).
        graph.wabas[2].templates[0].status = 'APPROVED';
        const restore = await deploy({
            ...common,
            sourceDir: path.join(root, set),
            toWabas: ['2'],
        });
        assert.equal(restore.ok, true);
        assert.equal(graph.wabas[2].templates[0].components[0].text, 'old');
    });

    it('restores only selected templates of a set', async () => {
        const { common, graph } = appSetup({
            1: [bodyTemplate('a', 'fr', 'new'), bodyTemplate('b', 'fr', 'new')],
            2: [bodyTemplate('a', 'fr', 'old'), bodyTemplate('b', 'fr', 'old')],
        });
        const root = run.add('backups-select');
        const result = await deploy({ ...common, fromWaba: '1', toWabas: ['2'], backupDir: root });
        const qaTemplates = graph.wabas[2].templates;
        for (const template of qaTemplates) {
            template.status = 'APPROVED';
        }
        const options = { ...common, sourceDir: result.targets[0].backup, toWabas: ['2'] };
        const restore = await deploy({ ...options, templateKeys: ['b::fr'] });
        assert.equal(restore.ok, true);
        assert.deepEqual(
            graph.wabas[2].templates.map((template) => template.components[0].text),
            ['new', 'old'],
        );
        await assert.rejects(
            deploy({ ...options, templateKeys: ['c::fr'] }),
            /Not found in the source: c::fr/,
        );
        await assert.rejects(deploy({ ...options, templateKeys: [] }), /No templates selected/);
        await assert.rejects(
            deploy({ ...options, templateKeys: ['b::fr'], prune: true }),
            /--prune only works when deploying the full set/,
        );
    });

    it('sends nothing to a target whose backup cannot be written', async () => {
        // A target template whose name cannot become a file name makes its backup fail.
        const { common, writes } = appSetup({
            1: [bodyTemplate('a', 'fr', 'A')],
            2: [bodyTemplate('bad/name', 'fr', 'X')],
            3: [],
        });
        const result = await deploy({
            ...common,
            fromWaba: '1',
            toWabas: ['2', '3'],
            names: ['a'],
            backupDir: run.add('backup-partial'),
        });
        assert.equal(result.ok, false);
        assert.match(result.targets[0].error, /^backup failed, nothing sent:/);
        assert.equal(result.targets[1].error, undefined);
        assert.equal(writes().length, 1, 'only the target with a good backup got its create');
    });
});

describe('wabadev deploy --backup / --from-dir', () => {
    it('backs up through the CLI and restores with --from-dir', async () => {
        const { mkdirSync, writeFileSync, readdirSync } = await import('node:fs');
        const { graph } = appSetup({
            1: [bodyTemplate('a', 'fr', 'new')],
            2: [bodyTemplate('a', 'fr', 'old')],
        });
        const cwd = run.add('cli-backup');
        mkdirSync(cwd);
        writeFileSync(
            path.join(cwd, '.wabadevrc.json'),
            JSON.stringify({
                stages: {
                    dev: [{ wabaId: '1', tokenEnv: 'T' }],
                    qa: [{ wabaId: '2', tokenEnv: 'T' }],
                },
            }),
        );
        const io = {
            cwd,
            environment: { T: 'tok-a' },
            fetchImpl: graph.fetchImpl,
            out: () => {},
            err: () => {},
        };
        assert.equal(
            await main(['deploy', '--from', 'dev', '--to', 'qa', '--backup', 'bk'], io),
            0,
        );
        const [set] = readdirSync(path.join(cwd, 'bk'));
        assert.equal(graph.wabas[2].templates[0].components[0].text, 'new');

        graph.wabas[2].templates[0].status = 'APPROVED';
        assert.equal(await main(['deploy', '--from-dir', `bk/${set}`, '--to', 'qa'], io), 0);
        assert.equal(graph.wabas[2].templates[0].components[0].text, 'old');
        assert.equal(
            await main(['deploy', '--from-dir', `bk/${set}`, '--from', 'dev', '--to', 'qa'], io),
            2,
        );
    });
});

/**
 * A live template with body "Hi", a footer and one quick-reply button.
 *
 * @param {string} name
 * @returns {object}
 */
function withExtras(name) {
    return {
        ...bodyTemplate(name, 'fr', 'Hi'),
        components: [
            { type: 'BODY', text: 'Hi' },
            { type: 'FOOTER', text: 'old footer' },
            { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'OK' }] },
        ],
    };
}

describe('deploy --csv with part columns', () => {
    it('replaces only the parts the sheet has columns for', async () => {
        const { writeFileSync } = await import('node:fs');
        const { common, graph } = appSetup({ 2: [withExtras('x'), withExtras('y')] });
        const file = run.add('parts.csv');
        writeFileSync(
            file,
            'Template name,Category,Body,Language,Footer\r\nx,Utility,Hi,fr,new footer\r\ny,Utility,Hi,fr,\r\n',
        );
        const result = await deploy({ ...common, csv: file, toWabas: ['2'] });
        assert.equal(result.ok, true);
        const [x, y] = graph.wabas[2].templates;
        assert.deepEqual(
            x.components.map((component) => component.text ?? component.type),
            ['Hi', 'new footer', 'BUTTONS'],
        );
        assert.deepEqual(
            y.components.map((component) => component.text ?? component.type),
            ['Hi', 'BUTTONS'],
            'an empty Footer cell removes the footer, buttons stay',
        );
    });
});

/**
 * QA gets "a" updated, "b" created; "gone" only exists in QA.
 *
 * @returns {Promise.<object>}
 */
async function runWithBothBackups() {
    const { common, graph, writes } = appSetup({
        1: [
            bodyTemplate('a', 'fr', 'Hi {{1}}', { components: undefined }),
            bodyTemplate('b', 'fr', 'B'),
        ],
        2: [bodyTemplate('a', 'fr', 'Hello'), bodyTemplate('gone', 'fr', 'G')],
    });
    graph.wabas[1].templates[0].components = [
        { type: 'BODY', text: 'Hi {{1}}', example: { body_text: [['Jane']] } },
    ];
    const root = run.add(`both-${Math.random().toString(36).slice(2)}`);
    const result = await deploy({
        ...common,
        fromWaba: '1',
        toWabas: ['2'],
        backupDir: root,
        backupAfter: true,
    });
    return { result, graph, writes, root, common };
}

describe('after-backups and comparing restore points', () => {
    it('writes a matching _before and _after set', async () => {
        const { readFileSync } = await import('node:fs');
        const { result } = await runWithBothBackups();
        const [target] = result.targets;
        assert.match(target.backup, /2_.+Z_before$/);
        assert.equal(target.backupAfter, target.backup.replace(/_before$/, '_after'));
        const after = JSON.parse(
            readFileSync(path.join(target.backupAfter, 'manifest.json'), 'utf8'),
        );
        assert.equal(after.phase, 'after');
        assert.deepEqual(
            after.templates.map((template) => `${template.name}:${template.status}`),
            ['a:PENDING', 'b:PENDING', 'gone:APPROVED'],
        );
        await assert.rejects(
            deploy({ ...appSetup().common, fromWaba: '1', toWabas: ['2'], backupAfter: true }),
            /--backup-after needs --backup/,
        );
    });

    it('compares older with newer, whatever order the sets are given in', async () => {
        const { result } = await runWithBothBackups();
        const [{ backup, backupAfter }] = result.targets;
        for (const [first, second] of [
            [backup, backupAfter],
            [backupAfter, backup],
        ]) {
            const report = await compareBackups(first, second);
            assert.equal(report.older.phase, 'before');
            assert.equal(report.sameWaba, true);
            assert.deepEqual(
                report.added.map((template) => template.name),
                ['b'],
            );
            assert.deepEqual(report.removed, []);
            assert.equal(report.unchanged, 1);
            assert.deepEqual(report.changed[0].changes, [
                { field: 'Body text', before: 'Hello', after: 'Hi {{1}}' },
                { field: 'Body examples', before: undefined, after: 'Jane' },
            ]);
        }
    });

    it('reports a deletion as removed, and notes different WABAs', async () => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const root = run.add('manual-sets');
        const write = (folder, wabaId, createdAt, templates) => {
            mkdirSync(path.join(root, folder), { recursive: true });
            writeFileSync(
                path.join(root, folder, 'manifest.json'),
                JSON.stringify({ tool: 'waba-devtools', createdAt, wabaId, templates: [] }),
            );
            for (const template of templates) {
                mkdirSync(path.join(root, folder, template.name));
                writeFileSync(
                    path.join(root, folder, template.name, `${template.language}.json`),
                    JSON.stringify(template),
                );
            }
        };
        write('old', '2', '2026-01-01T00:00:00.000Z', [
            bodyTemplate('a', 'fr', 'Line 1\nLine 2'),
            bodyTemplate('x', 'fr', 'X'),
        ]);
        write('new', '3', '2026-02-01T00:00:00.000Z', [
            bodyTemplate('a', 'fr', 'Line 1\r\nLine 2'),
        ]);
        const report = await compareBackups(path.join(root, 'new'), path.join(root, 'old'));
        assert.equal(report.older.wabaId, '2');
        assert.equal(report.sameWaba, false);
        assert.deepEqual(
            report.removed.map((template) => template.name),
            ['x'],
        );
        assert.deepEqual(report.added, []);
        assert.equal(report.unchanged, 1, 'line endings do not count');
        await assert.rejects(compareBackups(root, path.join(root, 'old')), /is not a backup set/);
    });

    it('wabadev compare prints the field changes', async () => {
        const { result } = await runWithBothBackups();
        const [{ backup, backupAfter }] = result.targets;
        const out = [];
        const code = await main(['compare', backupAfter, backup], {
            cwd: run.root,
            environment: {},
            out: (text) => {
                out.push(text);
            },
            err: () => {},
        });
        assert.equal(code, 0);
        assert.match(out[0], /Added \(1\):\n {2}b \(fr\)/);
        assert.match(out[0], /Body text:\n {6}before: Hello\n {6}after: {2}Hi \{\{1\}\}/);
        assert.equal(
            await main(['compare', backup], { cwd: run.root, out: () => {}, err: () => {} }),
            2,
        );
    });
});
