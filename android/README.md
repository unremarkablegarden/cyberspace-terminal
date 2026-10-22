# Android

Trusted Web Activity for Google Play, generated with Bubblewrap 1.27.0. The app opens https://terminal.cyberspace.online in Chrome, so cross-origin isolation, OPFS and WebGL2 behave as in the browser. Site deploys reach the app with no Play release.

`twa-manifest.json` is the source. The Gradle project is generated from it; regenerate after editing it rather than editing the Gradle files.

The app runs fullscreen (`"display": "fullscreen"`, Android immersive mode): no status bar, navigation bar, taskbar or URL bar.

## Home screen mode

`AndroidManifest.xml` carries a `HOME` intent filter, so Android offers the app as the home screen (Settings > Apps > Default apps > Home app). A deck then boots straight into the terminal. Bubblewrap has no option for this and `update` regenerates the manifest, so re-add the filter after every `update`.

## Toolchain

- JDK 17. Bubblewrap rejects other versions.
- Android SDK with platform 36 and build-tools 36.
- `~/.bubblewrap/config.json` names both paths:

```json
{ "jdkPath": "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home", "androidSdkPath": "/Users/<user>/Library/Android/sdk" }
```

## Commands

Run from this directory.

| Task | Command |
| --- | --- |
| Regenerate the project after editing `twa-manifest.json` | `bunx @bubblewrap/cli@1.27.0 update` |
| Debug APK, no keystore needed | `./gradlew assembleDebug` |
| Signed release APK and AAB | `bunx @bubblewrap/cli@1.27.0 build` |
| Install on a device or emulator | `bunx @bubblewrap/cli@1.27.0 install` |

`update` bumps `appVersionCode`; pass `--skipVersionUpgrade` to keep it.

`minSdkVersion` is 24, not the Bubblewrap default of 21: androidbrowserhelper 2.7.4 requires 24.

## Release

1. Create the upload key on first `build`. It is written to `./android.keystore`, which is gitignored. Keep the keystore and its passwords outside the repo as well; a lost upload key needs a reset through Play support.
2. Create the app in Play Console with package `online.cyberspace.terminal`. The package name cannot change after the first upload.
3. Upload `app-release-bundle.aab` and enrol in Play App Signing.
4. Add both SHA-256 fingerprints, the upload key and the Play app signing key from Play Console > App integrity: `bunx @bubblewrap/cli@1.27.0 fingerprint add <sha256>`
5. Regenerate `assetlinks.json` and move it over `app/public/.well-known/assetlinks.json`: `bunx @bubblewrap/cli@1.27.0 fingerprint generateAssetLinks` (it writes to this directory).
6. Deploy the site. Until https://terminal.cyberspace.online/.well-known/assetlinks.json lists the signing key, the app opens with a Chrome URL bar instead of full screen.

The published file also lists the local debug key (`~/.android/debug.keystore`), so debug builds open full screen once the site is deployed.

## Emulator

A hardware keyboard: set `hw.keyboard=yes` in the AVD's `config.ini`, then `adb shell settings put secure show_ime_with_hard_keyboard 0` so the soft keyboard stays down. The terminal then hides its key bar on the first key.

Before the site serves `assetlinks.json`, Chrome on the emulator can skip the check. Write the flag file, then enable chrome://flags/#enable-command-line-on-non-rooted-devices and restart Chrome:

```sh
adb shell "echo '_ --disable-digital-asset-link-verification-for-url=\"https://terminal.cyberspace.online\"' > /data/local/tmp/chrome-command-line"
```

A local build: `adb reverse tcp:5173 tcp:5173` and open https://localhost:5173 in Chrome on the emulator. The mkcert CA is not trusted there; type `thisisunsafe` on the warning page.

The API 33 system image ships Chrome 103, whose GPU process crashes in the emulator and leaves no WebGL2. Update Chrome through Play, or copy a newer Chrome from another emulator: `adb pull` the Chrome splits and the matching `com.google.android.trichromelibrary` base APK, then `adb install` Trichrome first and `adb install-multiple` the Chrome splits.
