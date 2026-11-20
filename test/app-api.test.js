import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../lib/cli.js';
import { deploy, discoverWabas, listTemplates, validateConfig } from '../lib/index.js';
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
    it('snapshots each changed target before sending, and restores from it', async () => {
        const { readFileSync, existsSync } = await import('node:fs');
        const { common, graph, writes } = appSetup({
            1: [bodyTemplate('a', 'fr', 'new')],
            2: [bodyTemplate('a', 'fr', 'old'), bodyTemplate('keep', 'fr', 'K')],
            3: [bodyTemplate('a', 'fr', 'new')],
        });
        const backupFolder = run.add('backup-1');
        const result = await deploy({
            ...common,
            fromWaba: '1',
            toWabas: ['2', '3'],
            backupDir: backupFolder,
        });
        assert.equal(result.ok, true);
        assert.equal(writes().length, 1, 'qa: update a; prod is identical');

        const manifest = JSON.parse(readFileSync(`${backupFolder}/manifest.json`, 'utf8'));
        assert.equal(manifest.tool, 'waba-devtools');
        assert.deepEqual(manifest.source, {
            type: 'waba',
            stage: 'dev',
            stages: ['dev'],
            wabaId: '1',
        });
        assert.deepEqual(manifest.targets, [{ stage: 'qa', wabaId: '2', templateCount: 2 }]);
        assert.ok(
            existsSync(`${backupFolder}/2/keep/fr.json`),
            'the full set, not only the changed one',
        );
        assert.ok(!existsSync(`${backupFolder}/3`), 'no backup for a target without changes');
        assert.equal(path.relative(backupFolder, result.targets[0].backup), '2');
        assert.equal(graph.wabas[2].templates[0].components[0].text, 'new');

        // Restore: deploy the backup folder back to QA.
        graph.wabas[2].templates[0].status = 'APPROVED';
        const restore = await deploy({ ...common, sourceDir: `${backupFolder}/2`, toWabas: ['2'] });
        assert.equal(restore.ok, true);
        assert.equal(graph.wabas[2].templates[0].components[0].text, 'old');
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

    it('refuses a backup folder that is not empty or not a folder, before sending', async () => {
        const { writeFileSync } = await import('node:fs');
        const { common, writes } = appSetup({ 1: [bodyTemplate('a', 'fr', 'A')], 2: [] });
        const options = { ...common, fromWaba: '1', toWabas: ['2'] };
        const used = run.add('backup-used');
        await deploy({ ...options, dryRun: true, backupDir: used });
        const first = await deploy({ ...options, names: ['a'], backupDir: used });
        assert.equal(first.ok, true);
        assert.equal(writes().length, 1);

        await assert.rejects(deploy({ ...options, backupDir: used }), /is not empty/);
        const file = run.add('backup-is-a-file');
        writeFileSync(file, 'not a folder');
        await assert.rejects(deploy({ ...options, backupDir: file }), /Cannot use backup folder/);
        assert.equal(writes().length, 1, 'refused runs send nothing');
    });
});

describe('wabadev deploy --backup / --from-dir', () => {
    it('backs up through the CLI and restores with --from-dir', async () => {
        const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
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
        assert.ok(existsSync(path.join(cwd, 'bk', '2', 'a', 'fr.json')));
        assert.equal(graph.wabas[2].templates[0].components[0].text, 'new');

        graph.wabas[2].templates[0].status = 'APPROVED';
        assert.equal(await main(['deploy', '--from-dir', 'bk/2', '--to', 'qa'], io), 0);
        assert.equal(graph.wabas[2].templates[0].components[0].text, 'old');
        assert.equal(
            await main(['deploy', '--from-dir', 'bk/2', '--from', 'dev', '--to', 'qa'], io),
            2,
        );
    });
});
