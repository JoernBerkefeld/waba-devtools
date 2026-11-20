# WABA DevTools (`wabadev`)

Retrieve and deploy or bulk-CSV-import **WhatsApp Business message templates** across several WhatsApp
Business Accounts (WABAs) — for example one WABA per pipeline stage (dev → qa → prod).

- Keep templates as JSON files in git and deploy them to every WABA of a stage.
- Copy templates straight from one stage's WABA to the next.
- Bulk-upsert template texts from a Google Sheets (CSV) export.
- Create what is missing, update what changed, leave the rest alone — a second deploy sends nothing.

It talks to Meta's Graph API directly and needs no other tool.

## Install

```bash
npm install -g waba-devtools
wabadev --help
```

Node.js `^22.22.2 || >=24.15.0`.

## Quick start

Before you start, you need:

- the **WABA IDs** — shown in
  [Business settings](https://business.facebook.com/settings) → **Accounts** → **WhatsApp
  accounts**;
- an **access token** per environment — see [Access tokens](#access-tokens) for the steps.

Official Meta documentation:

| Topic                                     | Link                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Access tokens (system users)              | [Access tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens)                               |
| Creating the Meta app                     | [WhatsApp use case](https://developers.facebook.com/documentation/development/create-an-app/whatsapp-use-case)                         |
| Permissions                               | [Permissions](https://developers.facebook.com/documentation/business-messaging/whatsapp/permissions)                                   |
| Message templates                         | [Template fundamentals](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview)                  |
| Template categories (Utility / Marketing) | [Template categorization](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization) |
| Template review by Meta                   | [Template review](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review/)                |

1. Create `.wabadevrc.json` in your project folder:

   ```json
   {
     "stages": {
       "dev": [{ "wabaId": "111111111111111", "tokenEnv": "WABA_TOKEN_NONPROD" }],
       "qa": [{ "wabaId": "222222222222222", "tokenEnv": "WABA_TOKEN_NONPROD" }],
       "prod": [
         { "wabaId": "333333333333333", "tokenEnv": "WABA_TOKEN_PROD" },
         { "wabaId": "444444444444444", "tokenEnv": "WABA_TOKEN_PROD" }
       ]
     }
   }
   ```

2. Put the tokens into a `.env` file next to it (and add `.env` to `.gitignore`):

   ```text
   WABA_TOKEN_NONPROD=EAAG...
   WABA_TOKEN_PROD=EAAG...
   ```

3. Check access, retrieve, preview, deploy:

   ```bash
   npx wabadev check
   npx wabadev retrieve --from dev
   npx wabadev deploy --to qa --dry-run
   npx wabadev deploy --to qa
   ```

### Access tokens

`wabadev` needs a **System User access token** from the Meta business portfolio that owns your
WABAs. One-time setup, done by an admin of that portfolio:

1. **Create a Meta app.** A token always belongs to an app — you need your own, even when your
   WABAs were connected through a provider such as Salesforce.
   - [developers.facebook.com](https://developers.facebook.com/apps) → **My Apps** → **Create
     app**.
   - Use case: **Connect with customers through WhatsApp**.
   - Business portfolio: the one that owns your WABAs.
2. **Create a system user.**
   - [Business settings](https://business.facebook.com/settings) → **Users** → **System users** →
     **Add**.
   - Name: e.g. `wabadev-nonprod`. Role: **Employee** (it then only sees what you assign).
3. **Give the system user the app.**
   - Click the system user → **Assign assets** → select your app → tick **Manage app** →
     **Assign assets**.
4. **Give the system user each WABA.**
   - Business settings → **Accounts** → **WhatsApp accounts** → select the WABA → **People** →
     **Add people** → the system user → **Full control**.
   - Repeat for every WABA this token should reach.
5. **Generate the token.**
   - Click the system user → **Generate token** → select your app.
   - Expiration: **Never** (otherwise the token stops working after the chosen time).
   - Permissions: tick **`whatsapp_business_management`** and **`business_management`**.
   - Copy the token — Meta shows it only once.
6. **Store and test it.**
   - Put it into `.env`: `WABA_TOKEN_NONPROD=EAAG...`
   - Run `wabadev check`.

For production, repeat steps 2–6 with a second system user (e.g. `wabadev-prod`) that only gets the
prod WABAs. Then a non-production token can never change production.

Where the token lives:

- **Locally:** a `.env` file in the project folder. `wabadev` loads it on start; variables that are
  already set in your shell win.
- **CI/CD:** a secret of your pipeline, exposed as the environment variable named in `tokenEnv`.
- Tokens are never written to files, reports or `--json` output.

WABAs connected through a provider (for example Salesforce) are still owned by your portfolio, so
your own system user can be assigned to them in step 4. `wabadev check` confirms it works.

## Configuration — `.wabadevrc.json`

| Key                         | Required | Meaning                                                                                                                  |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `stages`                    | yes      | Stage name → list of WABAs. A deploy to a stage goes to **all** of its WABAs (or only the ones picked with `--to-waba`). |
| `stages.<stage>[].wabaId`   | yes      | The WhatsApp Business Account ID.                                                                                        |
| `stages.<stage>[].tokenEnv` | yes      | Name of the environment variable that holds the access token for this WABA. Several WABAs may share one.                 |
| `graphVersion`              | no       | Graph API version, default `v23.0`.                                                                                      |
| `templatesDir`              | no       | Folder for template files, default `templates`.                                                                          |

The config never contains tokens. A WABA listed twice in the same stage is used once, with a warning.

## File structure

There is **one set of template files for all stages**. The files contain no WABA IDs, phone
numbers or statuses, so the same file can be deployed to dev, qa and prod.

```text
my-project/
├── .wabadevrc.json          # stages and WABA IDs
├── .env                     # tokens — never commit
└── templates/
    ├── order_shipped/
    │   ├── en_US.json       # one file per language
    │   └── fr.json
    └── welcome/
        └── en_US.json
```

One file = one template in one language:

```json
{
  "category": "UTILITY",
  "components": [
    {
      "example": { "body_text": [["Jane", "A-1234"]] },
      "text": "Hi {{1}}, order {{2}} is on its way.",
      "type": "BODY"
    }
  ],
  "language": "en_US",
  "name": "order_shipped",
  "parameter_format": "POSITIONAL"
}
```

Typical flow: edit or `retrieve` the files → commit to git → `deploy` them stage by stage.

## Commands

| Command                 | What it does                                          |
| ----------------------- | ----------------------------------------------------- |
| [`check`](#check)       | Tests the access to every WABA. Changes nothing.      |
| [`retrieve`](#retrieve) | Downloads the templates of one WABA into files.       |
| [`import`](#import)     | Turns a CSV file (Google Sheets) into template files. |
| [`deploy`](#deploy)     | Sends templates to every WABA of a stage.             |

Options that work with every command:

| Option          | Meaning                                   | Example                |
| --------------- | ----------------------------------------- | ---------------------- |
| `--json`        | Print the result as JSON (for CI/scripts) | `wabadev check --json` |
| `-h, --help`    | Show the help                             | `wabadev --help`       |
| `-v, --version` | Show the installed version                | `wabadev --version`    |

### `check`

Tests for each WABA: is the token set, can the WABA be reached, can its templates be read.
Read-only.

```bash
wabadev check [--stage <stage>]
```

| Option            | Meaning                                        | Example                    |
| ----------------- | ---------------------------------------------- | -------------------------- |
| `--stage <stage>` | Only check this stage. Without it: all stages. | `wabadev check --stage qa` |

```bash
wabadev check              # all stages
wabadev check --stage prod # only the prod WABAs
```

### `retrieve`

Downloads the templates of one WABA into `templates/<name>/<language>.json`. Commit these files to
git.

```bash
wabadev retrieve --from <stage> | --from-waba <id> [-m <name>]
```

| Option                  | Meaning                                                                              | Example                       |
| ----------------------- | ------------------------------------------------------------------------------------ | ----------------------------- |
| `--from <stage>`        | The stage to download from. Works when the stage has exactly one WABA.               | `--from dev`                  |
| `--from-waba <id>`      | The WABA to download from. No `--from` needed (see [Picking WABAs](#picking-wabas)). | `--from-waba 333333333333333` |
| `-m, --template <name>` | Only this template (all its languages). Repeat for more.                             | `-m order_shipped -m welcome` |

Give `--from` or `--from-waba` (or both). A stage with several WABAs needs `--from-waba` — without
it, retrieve stops with an error and writes nothing.

```bash
wabadev retrieve --from dev                   # all templates of dev
wabadev retrieve --from dev -m order_shipped  # just one template
wabadev retrieve --from-waba 333333333333333  # one WABA of prod
```

Good to know:

- Files are overwritten with what is in the WABA.
- IDs and statuses are not saved — only what defines the template.
- Files of templates that no longer exist in the WABA are not deleted.

### `import`

Reads a CSV file and writes one template file per row. Nothing is sent to Meta.

```bash
wabadev import --csv <file>
```

| Option         | Meaning                             | Example                   |
| -------------- | ----------------------------------- | ------------------------- |
| `--csv <file>` | **Required.** The CSV file to read. | `--csv exports/sheet.csv` |

```bash
wabadev import --csv sheet.csv
```

Good to know:

- For a template file that already exists, only the body text is replaced. Header, footer,
  buttons and category stay.
- Rows with errors are listed with their row number. All other rows are still imported.

#### CSV columns

Export from Google Sheets with **File → Download → Comma-separated values (.csv)**. Header names
are not case-sensitive. Other columns (e.g. `Brand`) are ignored.

| Column          | Required                    | Content                                     | Example                                |
| --------------- | --------------------------- | ------------------------------------------- | -------------------------------------- |
| `Template name` | yes                         | Template name: letters, digits, `_`         | `order_shipped`                        |
| `Category`      | yes                         | `Utility` or `Marketing`                    | `Utility`                              |
| `Meta Template` | yes                         | Body text, variables as `{{1}}`, `{{2}}`, … | `Hi {{1}}, order {{2}} is on its way.` |
| `Language`      | yes                         | Meta language code                          | `en_US`, `fr`, `it`                    |
| `Examples`      | when the text has variables | One example per variable, separated by `\|` | `Jane\|A-1234`                         |

### `deploy`

Makes the target WABAs match the source: creates missing templates and updates
changed ones. Everything else is left alone.

```bash
wabadev deploy <target> [<source> | --csv <file>] [-m <name>] [--dry-run] [--prune [--yes]]

# <target>: --to <stage> and/or --to-waba <id>…
# <source>: --from <stage> and/or --from-waba <id> (default: the template files)
```

Where the templates come from:

| Source                   | Command                                  | Uses the files on disk?                                  |
| ------------------------ | ---------------------------------------- | -------------------------------------------------------- |
| Template files (default) | `wabadev deploy --to qa`                 | Yes — reads `templates/`                                 |
| Another WABA             | `wabadev deploy --from dev --to qa`      | No — live clone from WABA to WABA, files are not touched |
| A CSV file               | `wabadev deploy --csv sheet.csv --to qa` | No — reads the CSV, files are not touched                |

| Option                  | Meaning                                                                                          | Example                       |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------- |
| `--to <stage>`          | Target: every WABA of this stage.                                                                | `--to qa`                     |
| `--to-waba <id>`        | Target: only this WABA. Repeat for more. No `--to` needed; with `--to` it must be in that stage. | `--to-waba 444444444444444`   |
| `--from <stage>`        | Source: the WABA of this stage (instead of the files).                                           | `--from dev`                  |
| `--from-waba <id>`      | Source: this WABA. No `--from` needed; required when the `--from` stage has several.             | `--from-waba 333333333333333` |
| `--csv <file>`          | Take the templates from a CSV file (see [CSV columns](#csv-columns)).                            | `--csv sheet.csv`             |
| `-m, --template <name>` | Only this template (all its languages). Repeat for more.                                         | `-m order_shipped`            |
| `--dry-run`             | Only show what would happen, with each template's status at Meta. Sends nothing.                 | `--dry-run`                   |
| `--prune`               | Also delete templates that exist only in the target. Lists them first.                           | `--prune`                     |
| `--yes`                 | With `--prune`: really delete.                                                                   | `--prune --yes`               |

```bash
wabadev deploy --to qa --dry-run                 # preview
wabadev deploy --to qa                           # all files → every qa WABA
wabadev deploy --to prod -m order_shipped        # one template only
wabadev deploy --from qa --to prod               # copy qa → prod
wabadev deploy --csv sheet.csv --to dev          # CSV → dev, no files needed
wabadev deploy --from qa --to prod --prune       # list what would be deleted
wabadev deploy --from qa --to prod --prune --yes # copy and delete the extras
wabadev deploy --to-waba 444444444444444         # files → one WABA only

# One WABA to one other WABA — any stages:
wabadev deploy --from-waba 333333333333333 --to-waba 444444444444444
```

#### Picking WABAs

You can name WABAs directly with `--from-waba` / `--to-waba`. `wabadev` looks each one up in
`.wabadevrc.json` to find its token:

| The WABA is listed in…                       | Result                                       |
| -------------------------------------------- | -------------------------------------------- |
| one stage                                    | used                                         |
| several stages, all with the same `tokenEnv` | used — the token is the same anyway          |
| several stages with different `tokenEnv`     | error: add `--from <stage>` / `--to <stage>` |
| no stage                                     | error: add it to `.wabadevrc.json`           |

With a stage given as well, the WABA must be part of that stage — a useful safety check in
scripts.

#### What happens to each template

Templates are matched by **name + language**.

| In the target WABA                             | Result                                        |
| ---------------------------------------------- | --------------------------------------------- |
| Missing                                        | **create**                                    |
| Same content                                   | **unchanged**                                 |
| Different, status APPROVED, REJECTED or PAUSED | **update**                                    |
| Different, other status (e.g. PENDING)         | **blocked** — not sent, exit code 1           |
| Media header, authentication (OTP) or carousel | **skipped** — not supported yet               |
| Only in the target                             | **extra** — only deleted with `--prune --yes` |

Good to know:

- **Category** is only set when a template is created. Meta does not allow changing it later.
- Created and updated templates are reviewed by Meta again and show `PENDING` for a while. Run
  `--dry-run` later to see the new status.
- With `--csv`, only the body text of existing templates is replaced. Their header, footer and
  buttons stay.
- One failing template does not stop the others. The report shows Meta's error.

#### `--prune` safety

- Works with the template files and with `--from` — whenever the whole set is deployed.
- Refused together with `-m` or `--csv`: those only send some templates, so "missing in the
  source" would not mean "should be deleted".
- Refused when the source has no templates.
- Media, authentication and carousel templates are never deleted.
- Without `--yes`, nothing is deleted — you only see the list.
- Meta may block a deleted template's name for a while, so it cannot be created again right away.

## Output and exit codes

`--json` prints the full report as JSON (for scripts and CI). Each source and target has `stage`
(text) and `stages` (list) — a WABA found in several stages lists all of them in `stages`.

| Exit code | Meaning                                                                                                                                                   |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | Everything succeeded.                                                                                                                                     |
| `1`       | Something failed: a Meta error, a blocked template, a CSV row error, or a target WABA that could not be reached (incl. its token variable not being set). |
| `2`       | Wrong usage or configuration (unknown stage, missing option, invalid config, missing token for the source WABA, …).                                       |

## Meta limits to know

- Every WABA reviews its templates on its own: the same template can be approved in one WABA and
  rejected or re-categorized in another.
- Meta limits how many templates can be created per WABA per hour, and how often approved
  templates can be edited. Deploying only what changed keeps you well below these limits.

## Not supported yet

- Templates with an image, video or document header.
- Authentication (OTP) and carousel templates.

## License

MIT © Jörn Berkefeld
