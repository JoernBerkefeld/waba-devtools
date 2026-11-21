import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../lib/cli.js';
import {
    compareBackups,
    compareWabas,
    compareWithLive,
    createBackup,
    deploy,
    discoverWabas,
    fieldChanges,
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
            assert.equal(report.before.phase, 'before');
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
        assert.equal(report.before.wabaId, '2');
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

describe('manual restore points and comparing with the live WABA', () => {
    it('creates restore points without deploying, then compares one with the live WABA', async () => {
        const { readdirSync } = await import('node:fs');
        const { common, graph, writes } = appSetup({
            2: [bodyTemplate('a', 'fr', 'A'), bodyTemplate('b', 'fr', 'B')],
            3: [bodyTemplate('x', 'fr', 'X')],
        });
        const root = run.add('manual');
        const result = await createBackup({ ...common, wabaIds: ['2', '3'], backupDir: root });
        assert.equal(result.ok, true);
        assert.equal(writes().length, 0, 'a restore point sends nothing');
        assert.deepEqual(
            result.sets.map((set) => [set.wabaId, set.templateCount]),
            [
                ['2', 2],
                ['3', 1],
            ],
        );
        assert.match(path.basename(result.sets[0].backup), /^2_.+Z_manual$/);

        // Someone changes QA afterwards.
        graph.wabas[2].templates[0].components[0].text = 'A changed';
        graph.wabas[2].templates.pop();
        graph.wabas[2].templates.push({
            ...bodyTemplate('c', 'fr', 'C'),
            id: '77',
            status: 'PENDING',
        });

        const before = readdirSync(root).length;
        const report = await compareWithLive({ ...common, set: result.sets[0].backup });
        assert.equal(readdirSync(root).length, before, 'the live state is not saved');
        assert.equal(report.after.phase, 'live');
        assert.equal(report.after.wabaId, '2');
        assert.deepEqual(
            [report.added, report.removed].map((list) => list.map((template) => template.name)),
            [['c'], ['b']],
        );
        assert.deepEqual(report.changed[0].changes, [
            { field: 'Body text', before: 'A', after: 'A changed' },
        ]);

        // The same backup against another WABA (QA → prod drift).
        const drift = await compareWithLive({ ...common, set: result.sets[0].backup, wabaId: '3' });
        assert.equal(drift.sameWaba, false);
        await assert.rejects(createBackup({ ...common, wabaIds: ['2'] }), /Missing --backup/);
        await assert.rejects(
            createBackup({ ...common, backupDir: root }),
            /Missing --stage or --waba/,
        );
    });

    it('wabadev backup and wabadev compare --live', async () => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { graph } = appSetup({ 2: [bodyTemplate('a', 'fr', 'A')] });
        const cwd = run.add('cli-manual');
        mkdirSync(cwd);
        writeFileSync(
            path.join(cwd, '.wabadevrc.json'),
            JSON.stringify({ stages: { qa: [{ wabaId: '2', tokenEnv: 'T' }] } }),
        );
        const out = [];
        const io = {
            cwd,
            environment: { T: 'tok-a' },
            fetchImpl: graph.fetchImpl,
            out: (text) => {
                out.push(text);
            },
            err: () => {},
        };
        assert.equal(await main(['backup', '--stage', 'qa', '--backup', 'bk', '--json'], io), 0);
        const [set] = JSON.parse(out.at(-1)).sets;
        graph.wabas[2].templates[0].components[0].text = 'B';
        assert.equal(await main(['compare', set.backup, '--live'], io), 0);
        assert.match(out.at(-1), /Body text:\n {6}before: A\n {6}after: {2}B/);
        assert.equal(
            await main(['compare', set.backup, '--live', '--waba', '2', '--waba', '3'], io),
            2,
        );
        assert.equal(await main(['compare', set.backup, 'x', '--live'], io), 2);
        assert.equal(await main(['compare', set.backup, set.backup, '--waba', '2'], io), 2);
    });
});

/**
 * @param {string} named - Example for the named header variable.
 * @returns {object}
 */
function namedHeaderTemplate(named) {
    return {
        ...bodyTemplate('x', 'fr', 'B'),
        parameter_format: 'NAMED',
        components: [
            {
                type: 'HEADER',
                format: 'TEXT',
                text: 'Hi {{name}}',
                example: { header_text_named_params: [{ param_name: 'name', example: named }] },
            },
            { type: 'BODY', text: 'B' },
        ],
    };
}

/**
 * @param {number} minutes - A footer setting without a field of its own.
 * @returns {object}
 */
function footerSettingTemplate(minutes) {
    return {
        ...bodyTemplate('x', 'fr', 'B'),
        components: [
            { type: 'BODY', text: 'B' },
            { type: 'FOOTER', code_expiration_minutes: minutes },
        ],
    };
}

/**
 * @param {string[]} values - Body examples.
 * @returns {object}
 */
function examplesTemplate(values) {
    return {
        ...bodyTemplate('x', 'fr', '{{1}} {{2}}'),
        components: [{ type: 'BODY', text: '{{1}} {{2}}', example: { body_text: [values] } }],
    };
}

describe('compare field details', () => {
    it('never reports a real change as unchanged', () => {
        assert.equal(
            fieldChanges(namedHeaderTemplate('Ann'), namedHeaderTemplate('Bob'))[0].field,
            'Header named examples',
        );
        assert.equal(
            fieldChanges(footerSettingTemplate(5), footerSettingTemplate(10))[0].field,
            'Footer – other settings',
        );
        assert.deepEqual(
            fieldChanges(examplesTemplate(['a, b', 'c']), examplesTemplate(['a', 'b, c']))[0],
            { field: 'Body examples', before: '["a, b","c"]', after: '["a","b, c"]' },
        );
    });
});

describe('review fixes: backup text, two-token WABAs, after-backup rule', () => {
    it('prints readable lines for wabadev backup', async () => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { graph } = appSetup({ 2: [bodyTemplate('a', 'fr', 'A')] });
        const cwd = run.add('cli-backup-text');
        mkdirSync(cwd);
        writeFileSync(
            path.join(cwd, '.wabadevrc.json'),
            JSON.stringify({ stages: { qa: [{ wabaId: '2', tokenEnv: 'T' }] } }),
        );
        const out = [];
        const io = {
            cwd,
            environment: { T: 'tok-a' },
            fetchImpl: graph.fetchImpl,
            out: (text) => {
                out.push(text);
            },
            err: () => {},
        };
        assert.equal(await main(['backup', '--waba', '2', '--backup', 'bk'], io), 0);
        assert.match(out[0], /^ {2}OK {6}qa {2}WABA 2 → .+2_.+Z_manual \(1 templates\)$/);
    });

    it('uses the backup stage for a WABA listed in two stages with different tokens', async () => {
        const { graph } = appSetup({ 2: [bodyTemplate('a', 'fr', 'A')] });
        const config = validateConfig(
            {
                stages: {
                    qa: [{ wabaId: '2', tokenEnv: 'GOOD' }],
                    other: [{ wabaId: '2', tokenEnv: 'OTHER' }],
                },
            },
            run.root,
        );
        const common = {
            cwd: run.root,
            config,
            environment: { GOOD: 'tok-a', OTHER: 'tok-x' },
            fetchImpl: graph.fetchImpl,
        };
        await assert.rejects(
            createBackup({ ...common, wabaIds: ['2'], backupDir: run.add('two-tokens') }),
            /different tokens; add --stage <stage>/,
        );
        const created = await createBackup({
            ...common,
            stage: 'qa',
            backupDir: run.add('two-tokens-ok'),
        });
        const report = await compareWithLive({ ...common, set: created.sets[0].backup });
        assert.equal(report.after.stage, 'qa');
        assert.equal(report.unchanged, 1);
        await assert.rejects(
            compareWithLive({ ...common, set: created.sets[0].backup, wabaId: '2' }),
            /list it in one stage only/,
        );
    });

    it('writes no after set when nothing was actually sent', async () => {
        const { existsSync } = await import('node:fs');
        const { common, graph } = appSetup({
            1: [bodyTemplate('keep', 'fr', 'K'), bodyTemplate('new', 'fr', 'N')],
            2: [bodyTemplate('keep', 'fr', 'K'), bodyTemplate('old', 'fr', 'O')],
            3: [bodyTemplate('keep', 'fr', 'K'), bodyTemplate('old', 'fr', 'O')],
        });
        // Only a delete is planned (source = the set without "new"), not confirmed with yes.
        graph.wabas[1].templates.pop();
        const onlyDelete = await deploy({
            ...common,
            fromWaba: '1',
            toWabas: ['3'],
            prune: true,
            backupDir: run.add('after-none-1'),
            backupAfter: true,
        });
        const [target] = onlyDelete.targets;
        assert.equal(target.actions.at(-1).result, 'not run (add --yes)');
        assert.ok(target.backup, 'the before set is still written');
        assert.equal(target.backupAfter, undefined);
        graph.wabas[1].templates.push({
            ...bodyTemplate('new', 'fr', 'N'),
            id: '88',
            status: 'APPROVED',
        });

        // Every send fails.
        graph.wabas[2].failCreate = { new: { message: 'Invalid parameter', code: 100 } };
        const failing = await deploy({
            ...common,
            fromWaba: '1',
            toWabas: ['2'],
            names: ['new'],
            backupDir: run.add('after-none-2'),
            backupAfter: true,
        });
        assert.equal(failing.targets[0].actions[0].result, 'failed');
        assert.equal(failing.targets[0].backupAfter, undefined);
        assert.ok(!existsSync(failing.targets[0].backup.replace(/_before$/, '_after')));
    });
});

describe('comparing two WABAs live', () => {
    it('uses the chosen before and after WABA and saves nothing', async () => {
        const { readdirSync } = await import('node:fs');
        const { common, writes } = appSetup({
            2: [bodyTemplate('a', 'fr', 'A'), bodyTemplate('only_qa', 'fr', 'Q')],
            3: [bodyTemplate('a', 'fr', 'A prod'), bodyTemplate('only_prod', 'fr', 'P')],
        });
        const filesBefore = readdirSync(run.root).length;
        const report = await compareWabas({ ...common, beforeWaba: '2', afterWaba: '3' });
        assert.equal(readdirSync(run.root).length, filesBefore, 'nothing is written');
        assert.equal(writes().length, 0);
        assert.deepEqual([report.before.wabaId, report.after.wabaId], ['2', '3']);
        assert.deepEqual(
            [report.added, report.removed].map((list) => list.map((template) => template.name)),
            [['only_prod'], ['only_qa']],
        );
        assert.deepEqual(report.changed[0].changes, [
            { field: 'Body text', before: 'A', after: 'A prod' },
        ]);

        const swapped = await compareWabas({ ...common, beforeWaba: '3', afterWaba: '2' });
        assert.deepEqual(
            [swapped.added, swapped.removed].map((list) => list.map((template) => template.name)),
            [['only_qa'], ['only_prod']],
            'swapping before and after swaps added and removed',
        );
        await assert.rejects(
            compareWabas({ ...common, beforeWaba: '2', afterWaba: '2' }),
            /two different/,
        );
        await assert.rejects(
            compareWabas({ ...common, beforeWaba: '2' }),
            /--before-waba and --after-waba/,
        );
    });

    it('wabadev compare --before-waba --after-waba', async () => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { graph } = appSetup({ 2: [bodyTemplate('a', 'fr', 'A')], 3: [] });
        const cwd = run.add('cli-two-live');
        mkdirSync(cwd);
        writeFileSync(
            path.join(cwd, '.wabadevrc.json'),
            JSON.stringify({
                stages: {
                    qa: [{ wabaId: '2', tokenEnv: 'A' }],
                    prod: [{ wabaId: '3', tokenEnv: 'B' }],
                },
            }),
        );
        const out = [];
        const errors = [];
        const io = {
            cwd,
            environment: { A: 'tok-a', B: 'tok-b' },
            fetchImpl: graph.fetchImpl,
            out: (text) => {
                out.push(text);
            },
            err: (text) => {
                errors.push(text);
            },
        };
        assert.equal(await main(['compare', '--before-waba', '2', '--after-waba', '3'], io), 0);
        assert.match(
            out.at(-1),
            /^Before: WABA 2 \(qa\) right now\nAfter: {2}WABA 3 \(prod\) right now\n/,
        );
        assert.match(out.at(-1), /Removed \(1\):\n {2}a \(fr\)/);
        const twoWabas = ['compare', '--before-waba', '2', '--after-waba', '3'];
        for (const extraArguments of [['--live'], ['--waba', '4'], ['set']]) {
            assert.equal(await main([...twoWabas, ...extraArguments], io), 2);
            assert.match(
                errors.at(-1),
                /compares two WABAs live; give no backup set, --live or --waba/,
            );
        }
    });
});

describe('independent before/after backups', () => {
    it('writes only the after set when backupBefore is off', async () => {
        const { readdirSync } = await import('node:fs');
        const { common } = appSetup({ 1: [bodyTemplate('a', 'fr', 'A')], 2: [] });
        const root = run.add('after-only');
        const result = await deploy({
            ...common,
            fromWaba: '1',
            toWabas: ['2'],
            backupDir: root,
            backupBefore: false,
            backupAfter: true,
        });
        assert.equal(result.targets[0].backup, undefined);
        assert.match(path.basename(result.targets[0].backupAfter), /_after$/);
        assert.deepEqual(
            readdirSync(root).map((set) => set.split('_').at(-1)),
            ['after'],
        );
        await assert.rejects(
            deploy({
                ...common,
                fromWaba: '1',
                toWabas: ['2'],
                backupDir: root,
                backupBefore: false,
            }),
            /both before- and after-backups are off/,
        );
    });
});

describe('wabadev deploy --expect', () => {
    it('sends only what the saved preview showed', async () => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { graph } = appSetup({ 1: [bodyTemplate('a', 'fr', 'A')], 2: [], 3: [] });
        const cwd = run.add('cli-expect');
        mkdirSync(cwd);
        writeFileSync(
            path.join(cwd, '.wabadevrc.json'),
            JSON.stringify({
                stages: {
                    dev: [{ wabaId: '1', tokenEnv: 'A' }],
                    qa: [{ wabaId: '2', tokenEnv: 'A' }],
                    prod: [{ wabaId: '3', tokenEnv: 'B' }],
                },
            }),
        );
        const out = [];
        const errors = [];
        const io = {
            cwd,
            environment: { A: 'tok-a', B: 'tok-b' },
            fetchImpl: graph.fetchImpl,
            out: (text) => {
                out.push(text);
            },
            err: (text) => {
                errors.push(text);
            },
        };
        const deployArguments = ['deploy', '--from', 'dev', '--to-waba', '2', '--to-waba', '3'];
        assert.equal(await main([...deployArguments, '--dry-run', '--json'], io), 0);
        writeFileSync(path.join(cwd, 'preview.json'), out.at(-1));

        // QA changes after the preview: "a" now exists there.
        graph.wabas[2].templates.push({
            ...bodyTemplate('a', 'fr', 'other'),
            id: '5',
            status: 'APPROVED',
        });
        assert.equal(await main([...deployArguments, '--expect', 'preview.json', '--json'], io), 1);
        const [qa, production] = JSON.parse(out.at(-1)).targets;
        assert.equal(qa.error, 'changed since preview — run the preview again');
        assert.equal(production.actions[0].result, 'done');
        assert.equal(graph.wabas[2].templates[0].components[0].text, 'other', 'QA untouched');

        writeFileSync(path.join(cwd, 'bad.json'), '{"targets": [{"wabaId": 2}]}');
        assert.equal(await main([...deployArguments, '--expect', 'bad.json'], io), 2);
        assert.match(errors.at(-1), /is not the --json output of "deploy --dry-run"/);
        writeFileSync(path.join(cwd, 'real.json'), JSON.stringify({ dryRun: false, targets: [] }));
        assert.equal(await main([...deployArguments, '--expect', 'real.json'], io), 2);
        assert.match(errors.at(-1), /from a real deploy/);
    });
});

describe('content fingerprints in the confirmed preview', () => {
    it('catches a template edited after the preview, and accepts older previews', async () => {
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { common, graph, writes } = appSetup({ 2: [bodyTemplate('a', 'fr', 'old')] });
        const folder = run.add('fingerprint-files');
        const write = (text) => {
            mkdirSync(path.join(folder, 'a'), { recursive: true });
            writeFileSync(
                path.join(folder, 'a', 'fr.json'),
                JSON.stringify(bodyTemplate('a', 'fr', text)),
            );
        };
        write('Hello');
        const options = { ...common, sourceDir: folder, toWabas: ['2'] };
        const preview = await deploy({ ...options, dryRun: true });
        const [action] = preview.targets[0].actions;
        assert.equal(action.action, 'update');
        assert.match(action.fingerprint, /^[0-9a-f]{16}$/);

        // The file is edited after the preview: same action, other content.
        write('Hello!!');
        const changed = await deploy({ ...options, expectedActions: preview.targets });
        assert.equal(changed.targets[0].error, 'changed since preview — run the preview again');
        assert.equal(writes().length, 0, 'nothing was sent');

        // An older preview without fingerprints only binds the actions.
        const older = preview.targets.map((target) => ({
            ...target,
            actions: target.actions.map((action) =>
                Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'fingerprint')),
            ),
        }));
        const sent = await deploy({ ...options, expectedActions: older });
        assert.equal(sent.ok, true);
        assert.equal(graph.wabas[2].templates[0].components[0].text, 'Hello!!');

        // A fresh preview, run twice: the fingerprint is stable between runs.
        write('Hello');
        graph.wabas[2].templates[0].status = 'APPROVED';
        const again = await deploy({ ...options, dryRun: true });
        const second = await deploy({ ...options, dryRun: true });
        assert.deepEqual(second.targets, again.targets);
        const confirmed = await deploy({ ...options, expectedActions: again.targets });
        assert.equal(confirmed.ok, true);
        assert.equal(graph.wabas[2].templates[0].components[0].text, 'Hello');
    });

    it('catches a colleague editing the WABA, or a delete target recreated, after the preview', async () => {
        const { common, graph, writes } = appSetup({
            1: [bodyTemplate('a', 'fr', 'new'), bodyTemplate('keep', 'fr', 'K')],
            2: [
                bodyTemplate('a', 'fr', 'old'),
                bodyTemplate('keep', 'fr', 'K'),
                bodyTemplate('gone', 'fr', 'G'),
            ],
        });
        const options = { ...common, fromWaba: '1', toWabas: ['2'], prune: true, yes: true };
        const preview = await deploy({ ...options, dryRun: true });
        assert.deepEqual(
            preview.targets[0].actions
                .filter((action) => action.fingerprint)
                .map((action) => action.action),
            ['update', 'delete'],
        );

        // A colleague edits "a" in the WABA: same action, but the live template changed.
        graph.wabas[2].templates[0].components[0].text = 'colleague edit';
        const edited = await deploy({ ...options, expectedActions: preview.targets });
        assert.equal(edited.targets[0].error, 'changed since preview — run the preview again');
        assert.equal(writes().length, 0);

        // "gone" is deleted and created again under a new ID: the delete must not hit the new one.
        graph.wabas[2].templates[0].components[0].text = 'old';
        const fresh = await deploy({ ...options, dryRun: true });
        const gone = graph.wabas[2].templates.find((template) => template.name === 'gone');
        gone.id = '999';
        const recreated = await deploy({ ...options, expectedActions: fresh.targets });
        assert.equal(recreated.targets[0].error, 'changed since preview — run the preview again');
        assert.equal(writes().length, 0);

        // A preview with fingerprints where one action lost its own is refused, too.
        const partial = structuredClone(fresh.targets);
        gone.id = fresh.targets[0].actions.find((action) => action.name === 'gone').templateId;
        delete partial[0].actions.find((action) => action.action === 'update').fingerprint;
        const unbound = await deploy({ ...options, expectedActions: partial });
        assert.equal(unbound.targets[0].error, 'changed since preview — run the preview again');
        assert.equal(writes().length, 0);
    });
});
