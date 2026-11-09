# Source build and synthetic verification

Use Node.js **24 or newer**, including its built-in `node:sqlite`, and npm. No global install or extension packer is needed for a source install:

```sh
npm ci --ignore-scripts
npm run build
npm test
```

`npm start` runs the normal server and may read the real local Flighty installation. Use the verifier below for synthetic testing. Never install or test the committed `dist/*.mcpb`.

The build compiles into a fresh temporary directory and replaces `build/` only after a successful compile. Old output stays recoverable under `.cache/flighty-build/`. It cannot leak stale files into a successful build. `npm run clean` uses `trash`; it preserves the output if that utility is unavailable. Git remains the source backup.

`npm test` builds source and runs Vitest. Existing token, database-owner, airline and write coverage lives under `tests/`. All test defaults are synthetic. The stdio test exercises all 12 read handlers and checks the exact 15-tool default and 12-tool read-only inventories. Fetch and socket calls are blocked; plist reads are mocked. Tests do not use the installed app, real credentials, or real API.

For final acceptance, run the executable verifier against the installed build:

```sh
node tests/verify-stdio.mjs --entry /path/to/flighty-live/build/index.js --fixture-directory /absolute/job/fixture
```

It creates a uniquely named synthetic database below the requested fixture directory, starts that entry point over MCP stdio with `FLIGHTY_DB_PATH`, checks all reads, normalized policy values, bad-policy startup rejection, and mocked removal preview/confirm/replay. The integrated implementation passes all five check groups, including passenger, followed and uncached UUID removal; expiry, identity/preview binding and failed-request consumption also have unit/integration coverage. `--checks reads` selects the baseline inventory/read checks. Fixture cleanup uses `trash`; generated files are retained if trash is unavailable.

To retain a reusable fixture without running verification:

```sh
node tests/fixture/create.mjs --directory /absolute/job/fixture
```

The CLI prints generated paths and synthetic UUIDs, never a token. `createFixture(parentDirectory)` is also importable. The test-only preload refuses unmarked fixture paths and non-synthetic tokens. It never delegates fetch to the network; the removal mock accepts only the fixture endpoint and synthetic authorization header. Do not add this preload to a real server registration.

The npm package allowlist includes compiled runtime files and the MIT `LICENSE`; tests and committed bundles are excluded. Normal `npm pack` first rebuilds through `prepack`. To prepare a new extension stage from locked source and production dependencies, without a packer:

```sh
npm run bundle -- --stage-only
```

To pack, explicitly select a previously installed executable and its exact version. The script checks the version before building, downloads no packer, and uses argument arrays without a shell:

```sh
npm run bundle -- --packer /absolute/path/to/mcpb --packer-version X.Y.Z
```

Stages and prior extension output remain under `.cache/flighty-bundle/`; the new bundle defaults to `artifacts/flighty-mcp-server.mcpb`. Each stage starts empty, uses `npm ci --omit=dev --ignore-scripts`, and includes `LICENSE`. Use `--output /absolute/path/new.mcpb` to choose another destination. Normal builds and source installs do not invoke this optional packaging step.

The owner moved installation to a separate live checkout, represented publicly as `/path/to/flighty-live`. Preserve its built entry path and existing `flighty` registrations in Claude Code CLI user scope, Codex and agy. Update only to the exact final reviewed SHA after documentation acceptance; the frozen source candidate SHA is not an installed-release claim. The PM records the actual private path and installed SHA. Restart existing server processes and start new client sessions after updating. See [FORK-NOTES.md](../FORK-NOTES.md) for policy, unregister/restore commands and the future-update review process.

The owner reports the app installed, signed in and database present. Synthetic verification neither accesses nor certifies that real installation or API/account behavior. Node 26 was tested; the declared minimum Node 24 and optional binary MCPB packing were not separately exercised.
