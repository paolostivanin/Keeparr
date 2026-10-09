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

## Reporting security issues

Please do not open a public issue for a vulnerability. Contact the maintainer
privately through GitHub (a private security advisory on the repository).
