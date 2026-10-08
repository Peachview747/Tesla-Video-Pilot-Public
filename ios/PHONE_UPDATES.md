# Update MK8 directly on your iPhone

Use **SideStore** as the signing and installation app. Once set up, the workflow is:

**Download a new MK8 IPA on the iPhone → import it into SideStore → install over MK8.**

The computer is used for the initial SideStore setup. Routine IPA updates and signing refreshes happen on the phone. SideStore requires Wi-Fi and LocalDevVPN while installing or refreshing. MK8's own Cloudflare connection can still use cellular internet during playback.

## One-time setup

1. On the iPhone, install [LocalDevVPN from the App Store](https://apps.apple.com/app/localdevvpn/id6755608044). Open it, allow the VPN configuration, and connect.
2. On the Windows PC, install [iloader](https://github.com/nab138/iloader/releases). The checked installer for this guide is `iloader-v2.3.5-windows-x64.msi`. Existing working Apple/iTunes drivers from your Sideloadly setup may already meet its device requirements.
3. Connect the iPhone to the PC by USB, unlock it, and trust the computer if prompted.
4. Open iloader. Sign in using **the same Apple Account used to sign MK8**, select the iPhone, and choose **Install SideStore (Stable)**. This performs the initial installation/pairing setup.
5. Trust the SideStore developer profile if prompted. Developer Mode is already enabled if your current MK8 app runs; follow any additional iOS prompts.
6. On the iPhone, connect to **Wi-Fi**, turn on **LocalDevVPN**, and open SideStore. Sign in with that same Apple Account.
7. Open **My Apps** and tap the expiry counter beside **SideStore** to refresh SideStore itself before adding MK8. If SideStore asks to create/revoke a signing certificate, follow its prompt. Switching signing certificates can affect other apps signed with the old certificate; SideStore should manage MK8 going forward.

The current official SideStore release checked for this guide is **0.7.0-alpha**. It addresses Apple's sign-in changes that caused HTTP 503 failures in 0.6.4 and earlier. The name includes “alpha”; physical-device compatibility still needs verification. Its compiled app declares iOS 15.0 or newer, and the current installation guide covers iOS 18 and later. That is not a claim that this exact iOS 26.6.2 device has been tested.

## Move your current MK8 installation into SideStore

1. **Keep the existing MK8 app installed.** SideStore's official FAQ supports transferring Sideloadly apps by importing the same or a newer IPA while the original remains installed.
2. On the iPhone, download `Tesla-Video-Pilot-Ver-0.1.4-Build-<build>.ipa` from the chat download or the private GitHub release and save it in **Files → Downloads**. Private GitHub downloads require signing into GitHub in Safari.
3. Stop hosting in MK8 before replacing the running app.
4. With Wi-Fi and LocalDevVPN connected, open **SideStore → My Apps → +** and select that IPA in Files.
5. Let SideStore sign/install it, then open MK8 and verify that your videos, settings, and tunnel key are present. Keeping the original installed and using the same Apple Account/app identity is the route documented to preserve data. If a second MK8 appears, retain the original while resolving the app identity mismatch.

No separate MK8 updater app is required for this manual-import workflow. SideStore supplies the on-device signing and installation capability that an ordinary MK8 companion would otherwise lack.

## Every future MK8 version

1. Download the new `Tesla-Video-Pilot-Ver-<version>-Build-<build>.ipa` on your iPhone and save it in Files.
2. Stop MK8 hosting, connect to Wi-Fi, and enable LocalDevVPN.
3. In **SideStore → My Apps → +**, select the new IPA. Keep the same Apple Account and replace the existing MK8 installation.
4. Open MK8, check its version, and start hosting again.

Future MK8 files continue to be versioned and published in the same GitHub project. This workflow imports files you choose; it does not promise automatic discovery or background installation of private GitHub releases.

## Signing and pairing limits

- Free personal signing lasts seven days. Refresh both MK8 and SideStore in SideStore before they expire; enable SideStore's supported background refresh if desired. Successful refreshing still depends on iOS scheduling, Wi-Fi, and the local VPN.
- Free Apple Accounts normally allow three active sideloaded apps, including SideStore. SideStore and MK8 use two slots; the App Store version of LocalDevVPN does not use a sideload slot.
- If SideStore expires, or its pairing file is invalidated by an iOS update/reset or another Apple-side change, a computer may be needed to repair/reinstall it. This removes the computer from routine updates, not every possible recovery.
- Keep Apple Account credentials and pairing records local. The `TV_SECRET` tunnel key does not sign or install apps.

## Official sources and checked downloads

- [SideStore prerequisites](https://docs.sidestore.io/docs/installation/prerequisites)
- [SideStore installation](https://docs.sidestore.io/docs/installation/install)
- [SideStore FAQ and Sideloadly transfer instructions](https://docs.sidestore.io/docs/faq#can-i-transfer-my-altstoresideloadly-apps)
- [SideStore 0.7.0-alpha source/release](https://github.com/SideStore/SideStore/releases/tag/0.7.0-alpha)
- [iloader v2.3.5 source/release](https://github.com/nab138/iloader/releases/tag/v2.3.5)

Unmodified official files checked against the published GitHub asset size and SHA-256:

```text
SideStore-0.7.0-alpha.ipa
e334f86e6ceeab2e0d886c07611246533f474bb18838cf13ebc09ed1f0d622b5

iloader-v2.3.5-windows-x64.msi
082f206bb26b3b52216da22767c2959798202abe9b36aaf9f6c0400299fb90df
```
