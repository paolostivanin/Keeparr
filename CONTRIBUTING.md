# Contributing to Keeparr

Thanks for your interest in Keeparr. Bug reports, fixes and improvements are welcome.

## License

Keeparr is licensed under the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`); see [`LICENSE`](LICENSE). It is a modified derivative of
[Kept](https://github.com/ericerkz/kept) by ericerkz; see [`NOTICE`](NOTICE).

By submitting a contribution you agree that it is licensed under the same terms
(`AGPL-3.0-only`), and that you have the right to submit it. There is no
separate contributor license agreement.

Please add a `Signed-off-by: Your Name <you@example.com>` line to your commits
(`git commit -s`) to certify the [Developer Certificate of Origin](https://developercertificate.org/).

## Getting set up

Requirements: Node 24, npm 10+, and JDK 17 plus the Android SDK for the native client.

```bash
npm install
npm start            # API on :3000, web UI on :6767 (proxies /api)
```

## Before opening a pull request

Run the checks that CI runs:

```bash
npm run build
npm test -- --watch=false --browsers=ChromeHeadless
npm run test:native && npm run test:sync && npm run test:reminders && npm run test:utils
npm run test:server && npm run test:scale && npm run test:mcp

cd android-native && ./gradlew testDebugUnitTest assembleDebug lintDebug
```

- Keep changes focused; unrelated cleanups belong in their own pull request.
- Add or update tests for behavior changes. Protocol changes must keep
  `docs/sync-protocol.md` and `test-fixtures/native-contract.json` in step.
- Architecture notes are in `docs/architecture.md`.

## Releases

The web app, API, Docker image and MCP server release together. The Android app releases on its own, so each has
its own version and its own tag series:

| Part | Version lives in | Tag | Publishes |
| --- | --- | --- | --- |
| Web, API, image, MCP | `package.json` | `vX.Y.Z` | Docker image via `release-image.yml` |
| Android | `android-native/app/build.gradle.kts` | `android-vX.Y.Z` | APK attached to a GitHub release (manual) |

- Bump with `node scripts/bump-version.mjs server X.Y.Z` or `node scripts/bump-version.mjs android X.Y.Z`. It edits
  every file that carries the version, including the Android tests that pin it, and prints the tag command. Review
  the diff and commit before tagging.
- The Android version does not have to match the server version. Compatibility is the native-client protocol
  (`nativeProtocolVersion` from `GET /api/client/capabilities`), not the app version. A change that raises it must
  update `docs/sync-protocol.md`, `test-fixtures/native-contract.json` and the Android capability check together, and
  both parts should be tagged on the same commit.
- Create Android GitHub releases with `--latest=false`. The server's update check reads `releases/latest`, so an
  Android release marked latest would make servers report the wrong newest version.

## Reporting security issues

Please do not open a public issue for a vulnerability. Contact the maintainer
privately through GitHub (a private security advisory on the repository).
