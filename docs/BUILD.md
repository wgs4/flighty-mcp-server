# Source build and synthetic verification

Use Node.js **24 or newer**, including its built-in `node:sqlite`, and npm. No global install or extension packer is needed for a source install:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm start
```

`npm start` runs the normal server. Use the verifier below for testing, so no real Flighty data or account is used. Never install or test the committed `dist/*.mcpb`.

The build compiles into a fresh temporary directory and replaces `build/` only after a successful compile. Old output stays recoverable under `.cache/flighty-build/`. It cannot leak stale files into a successful build. `npm run clean` uses `trash`; it preserves the output if that utility is unavailable. Git remains the source backup.

`npm test` builds source and runs Vitest. Existing token, database-owner, airline and write coverage lives under `tests/`. All test defaults are synthetic. The stdio test exercises all 12 read handlers and checks the exact 15-tool default and 12-tool read-only inventories. Fetch and socket calls are blocked; plist reads are mocked. Tests do not use the installed app, real credentials, or real API.

For final acceptance, run the executable verifier against the installed build:

```sh
node tests/verify-stdio.mjs --entry /absolute/install/build/index.js --fixture-directory /absolute/job/fixture
```

It creates a uniquely named synthetic database below the requested fixture directory, starts that entry point over MCP stdio with `FLIGHTY_DB_PATH`, checks all reads, normalized policy values, bad-policy startup rejection, and mocked removal preview/confirm/replay. P1 must supply the policy and confirmation implementation for all checks to pass. `--checks reads` selects the baseline inventory/read checks. Fixture cleanup uses `trash`; generated files are retained if trash is unavailable.

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
