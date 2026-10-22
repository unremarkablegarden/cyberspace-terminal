# Android

Trusted Web Activity, generated with Bubblewrap 1.27.0 and released as an APK on GitHub. The app opens https://terminal.cyberspace.online in Chrome, so cross-origin isolation, OPFS and WebGL2 behave as in the browser. Site deploys reach the app with no new APK.

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
| Unsigned release APK | `./gradlew assembleRelease` |
| Install on a device or emulator | `adb install -r <apk>` |

`update` bumps `appVersionCode`; pass `--skipVersionUpgrade` to keep it.

The navigation bar colours are `#00000000` (transparent), so on Android 15 the screen shows under the bar. Every Bubblewrap command that writes `twa-manifest.json` (`update`, `fingerprint`) drops the alpha and writes `#000000`; set them back afterwards.

`minSdkVersion` is 24, not the Bubblewrap default of 21: androidbrowserhelper 2.7.4 requires 24.

## Release

Android installs no unsigned APK. A self-made key is enough for sideloading; every release must be signed with the same key, or installed copies cannot update.

Once, create the key. It is written to `./android.keystore`, which is gitignored. Keep a copy and its password outside the repo: a lost key means every user uninstalls to update.

```sh
keytool -genkeypair -keystore android.keystore -alias android -keyalg RSA -keysize 2048 -validity 10000
```

Once, list the key in `assetlinks.json`, then deploy the site. Until the site lists the signing key, the app opens with a Chrome URL bar instead of full screen.

```sh
keytool -list -keystore android.keystore -alias android   # SHA-256 line
bunx @bubblewrap/cli@1.27.0 fingerprint add <sha256> --name release
bunx @bubblewrap/cli@1.27.0 fingerprint generateAssetLinks   # writes ./assetlinks.json
mv assetlinks.json ../app/public/.well-known/assetlinks.json
```

Each release:

1. Raise `appVersionCode` and `appVersionName` in `twa-manifest.json` and in the `twaManifest` block of `app/build.gradle`. Android refuses an update with a lower or equal version code.
2. Build and sign:

```sh
./gradlew assembleRelease
~/Library/Android/sdk/build-tools/36.1.0/apksigner sign --ks android.keystore --ks-key-alias android --out cyberspace-terminal.apk app/build/outputs/apk/release/app-release-unsigned.apk
```

3. Attach `cyberspace-terminal.apk` to a GitHub release.

The published `assetlinks.json` also lists the local debug key (`~/.android/debug.keystore`), so debug builds open full screen too.

## Emulator

A hardware keyboard: set `hw.keyboard=yes` in the AVD's `config.ini`, then `adb shell settings put secure show_ime_with_hard_keyboard 0` so the soft keyboard stays down. The terminal then hides its key bar on the first key.

Before the site serves `assetlinks.json`, Chrome on the emulator can skip the check. Write the flag file, then enable chrome://flags/#enable-command-line-on-non-rooted-devices and restart Chrome:

```sh
adb shell "echo '_ --disable-digital-asset-link-verification-for-url=\"https://terminal.cyberspace.online\"' > /data/local/tmp/chrome-command-line"
```

A local build: `adb reverse tcp:5173 tcp:5173` and open https://localhost:5173 in Chrome on the emulator. The mkcert CA is not trusted there; type `thisisunsafe` on the warning page.

The API 33 system image ships Chrome 103, whose GPU process crashes in the emulator and leaves no WebGL2. Update Chrome through Play, or copy a newer Chrome from another emulator: `adb pull` the Chrome splits and the matching `com.google.android.trichromelibrary` base APK, then `adb install` Trichrome first and `adb install-multiple` the Chrome splits.
