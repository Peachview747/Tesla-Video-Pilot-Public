import SwiftUI
import UIKit
import MK8Core

/// Settings tab, grouped: appearance, account, video preparation, network,
/// background and battery, storage, about.
struct VPSettingsScreen: View {
    @ObservedObject var host: HostModel
    @ObservedObject private var background = BackgroundPreparation.shared
    @ObservedObject private var keepalive = SilentAudioKeepAlive.shared
    @AppStorage("appearanceMode") private var appearanceMode = "system"
    @AppStorage(MediaConverter.parallelDefaultsKey) private var parallelConversion = true
    @State private var storage: VPStorageReport?
    @State private var storageNote = ""
    @State private var cleaning = false
    @State private var confirmSignOut = false
    @State private var confirmRemoveFailed = false

    private var failedCount: Int { host.videos.filter { $0.state == "failed" }.count }
    private var parallelSlices: Int { min(4, max(1, ProcessInfo.processInfo.activeProcessorCount - 1)) }

    var body: some View {
        Form {
            appearanceSection
            accountSection
            preparationSection
            networkSection
            searchSection
            backgroundSection
            storageSection
            aboutSection
        }
        .vpFormBackground()
        .navigationTitle("Settings")
        .scrollDismissesKeyboard(.interactively)
        .task { await refreshStorage() }
        .confirmationDialog("Disconnect your Google account?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Disconnect", role: .destructive) { host.signOutYouTube() }
        } message: {
            Text("Subscriptions and account search stop working in the Tesla browser until you sign in again.")
        }
        .confirmationDialog("Remove \(failedCount) failed \(failedCount == 1 ? "video" : "videos")?",
                            isPresented: $confirmRemoveFailed, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                for video in host.videos where video.state == "failed" { host.remove(video.id) }
                Task { await refreshStorage() }
            }
        }
    }

    // MARK: Sections

    private var appearanceSection: some View {
        Section {
            Picker("Theme", selection: $appearanceMode) {
                Text("Match iPhone").tag("system")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
            }
            .pickerStyle(.segmented)
        } header: {
            Text("Appearance")
        } footer: {
            Text("Both themes use soft, low-glare surfaces.")
        }
        .listRowBackground(MK8Theme.card)
    }

    private var accountSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: host.youtubeSignedIn ? "person.crop.circle.fill.badge.checkmark" : "person.crop.circle")
                    .font(.title2)
                    .foregroundStyle(host.youtubeSignedIn ? MK8Theme.good : MK8Theme.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(host.youtubeSignedIn ? "Google account connected" : (host.youtubeSigningIn ? "Signing in…" : "Not signed in"))
                        .font(.subheadline.weight(.semibold))
                    Text(host.youtubeSignedIn ? "Subscriptions and account search are on in the Tesla browser."
                         : "Sign in to see your subscriptions in the Tesla browser.")
                        .font(.caption).foregroundStyle(MK8Theme.secondary)
                }
                Spacer(minLength: 0)
                if host.youtubeSigningIn { ProgressView() }
            }
            if !host.youtubeSignedIn && !host.youtubeSigningIn && !host.youtubeAuthStatus.isEmpty {
                Label(host.youtubeAuthStatus, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote).foregroundStyle(MK8Theme.bad).textSelection(.enabled)
            } else if host.youtubeSigningIn && !host.youtubeAuthStatus.isEmpty {
                Text(host.youtubeAuthStatus).font(.footnote).foregroundStyle(MK8Theme.secondary)
            }
            if host.youtubeSignedIn {
                Button("Disconnect Google", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                    confirmSignOut = true
                }
            } else {
                Button(host.youtubeSigningIn ? "Signing in…" : "Sign in with Google", systemImage: "person.crop.circle.badge.plus") {
                    host.signInYouTube()
                }
                .disabled(host.youtubeSigningIn)
            }
        } header: {
            Text("YouTube account")
        } footer: {
            Text("Google tokens stay in this iPhone's Keychain.")
        }
        .listRowBackground(MK8Theme.card)
    }

    private var preparationSection: some View {
        Section {
            Picker("Quality", selection: $host.mediaQuality) {
                ForEach(MediaQuality.allCases) { quality in Text(quality.title).tag(quality) }
            }
            .disabled(host.busy)
            Toggle(isOn: $parallelConversion) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Use every CPU core")
                    Text("Long YouTube videos convert in \(parallelSlices) slices at once.")
                        .font(.caption).foregroundStyle(MK8Theme.secondary)
                }
            }
            Toggle("Background downloads", isOn: $host.backgroundDownloads)
            Toggle(isOn: $host.backgroundPreparation) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Background preparation")
                    Text(background.status).font(.caption)
                        .foregroundStyle(background.isRunning ? MK8Theme.good : MK8Theme.secondary)
                }
            }
        } header: {
            Text("Video preparation")
        } footer: {
            Text("Higher quality means larger downloads and longer preparation; it applies to new videos. Turn off \u{201C}Use every CPU core\u{201D} if long videos fail to prepare.")
        }
        .listRowBackground(MK8Theme.card)
    }

    private var networkSection: some View {
        Section {
            Toggle("Connect tunnel when hosting", isOn: $host.tunnelEnabled)
            HStack {
                Text("Status")
                Spacer()
                StatusPill(title: host.running ? host.tunnelState.title : "Not hosting",
                           color: host.running ? host.tunnelState.vpColor : MK8Theme.secondary)
            }
            SecureField("TV_SECRET tunnel key", text: $host.tunnelKey)
                .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
            Button("Save tunnel key", systemImage: "key") { host.saveTunnelKey() }
            if host.running && host.tunnelEnabled && host.tunnelState != .notConfigured {
                Button("Reconnect tunnel", systemImage: "arrow.clockwise") { host.connectTunnel() }
                    .disabled(host.tunnelState.animating)
            }
            HStack {
                Text(host.publicURL.host ?? host.publicURL.absoluteString)
                    .font(.system(.footnote, design: .monospaced)).lineLimit(1).minimumScaleFactor(0.6)
                    .textSelection(.enabled)
                Spacer(minLength: 4)
                CopyButton(value: host.publicURL.absoluteString)
                ShareLink(item: host.publicURL) { Image(systemName: "square.and.arrow.up").frame(width: 30, height: 30) }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Share address")
            }
            if !host.tunnelMessage.isEmpty {
                Text(host.tunnelMessage).font(.footnote).foregroundStyle(MK8Theme.secondary).textSelection(.enabled)
            }
        } header: {
            Text("Network & tunnel")
        } footer: {
            Text("Save the same TV_SECRET used by your Cloudflare Worker. Anyone with the public address can use the host while it runs, so keep it private.")
        }
        .listRowBackground(MK8Theme.card)
    }

    private var searchSection: some View {
        Section {
            SecureField("Optional YouTube Data API key", text: $host.searchKey)
                .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
            Button("Save search key", systemImage: "key") { host.saveSearchKey() }
        } header: {
            Text("YouTube search key")
        } footer: {
            Text("Optional. Enables keyword search through the YouTube Data API. Video links and browsing work without it.")
        }
        .listRowBackground(MK8Theme.card)
    }

    private var backgroundSection: some View {
        Section {
            HStack {
                Label("Face ID", systemImage: "faceid")
                Spacer()
                Text(host.hostAuthorized ? "Approved this session" : "Asked before hosting")
                    .font(.subheadline).foregroundStyle(host.hostAuthorized ? MK8Theme.good : MK8Theme.secondary)
            }
            Toggle("Keep screen awake", isOn: $host.keepScreenAwake)
            Toggle("Allow extra background time", isOn: $host.allowBackgroundTime)
            Toggle(isOn: $host.keepHostingAlive) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Silent keepalive (experimental)")
                    Text(keepalive.status).font(.caption).foregroundStyle(MK8Theme.secondary)
                }
            }
            NavigationLink {
                HostScreen { HostCard { PiPExperimentView(playback: host.pipPlayback) } }
                    .navigationTitle("Picture in Picture")
                    .navigationBarTitleDisplayMode(.inline)
            } label: {
                Label("Picture in Picture test", systemImage: "pip")
            }
        } header: {
            Text("Hosting & battery")
        } footer: {
            Text("Keep screen awake applies while hosting or preparing. The silent keepalive uses extra battery and iOS may still suspend it.")
        }
        .listRowBackground(MK8Theme.card)
    }

    private var storageSection: some View {
        Section {
            if let storage {
                if let total = storage.total, total > 0, let available = storage.available {
                    VStack(alignment: .leading, spacing: 6) {
                        ProgressView(value: Double(max(0, total - available)), total: Double(total))
                            .tint(MK8Theme.accent)
                        Text("\(VPFormat.bytes(available)) free of \(VPFormat.bytes(total))")
                            .font(.caption).foregroundStyle(MK8Theme.secondary)
                    }
                }
                VPStatRow(title: "Prepared videos", value: VPFormat.bytes(storage.library))
                VPStatRow(title: "Unfinished downloads", value: VPFormat.bytes(storage.work))
                VPStatRow(title: "Temporary files", value: VPFormat.bytes(storage.temporary))
                VPStatRow(title: "Diagnostics log", value: VPFormat.bytes(storage.diagnostics))
            } else {
                HStack { Text("Measuring…").foregroundStyle(MK8Theme.secondary); Spacer(); ProgressView() }
            }
            Button("Clear temporary files", systemImage: "sparkles") {
                Task { await clearTemporary() }
            }
            .disabled(cleaning || host.busy || host.preparation != nil || host.pipPlayback.active)
            if failedCount > 0 {
                Button("Remove \(failedCount) failed \(failedCount == 1 ? "video" : "videos")", systemImage: "trash", role: .destructive) {
                    confirmRemoveFailed = true
                }
            }
            Button("Clear diagnostics log", systemImage: "doc.badge.ellipsis", role: .destructive) {
                host.clearDiagnostics()
                Task { await refreshStorage() }
            }
            if !storageNote.isEmpty {
                Text(storageNote).font(.footnote).foregroundStyle(MK8Theme.secondary)
            }
        } header: {
            HStack {
                Text("Storage")
                Spacer()
                Button { Task { await refreshStorage() } } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh storage")
            }
        } footer: {
            Text("Delete individual videos from Library by swiping left. Temporary files can only be cleared while nothing is being prepared.")
        }
        .listRowBackground(MK8Theme.card)
    }

    private var aboutSection: some View {
        Section {
            VPStatRow(title: "Version", value: "\(host.version) (\(host.build))")
            VPStatRow(title: "iPhone", value: "\(UIDevice.current.model) · iOS \(UIDevice.current.systemVersion)")
            VPStatRow(title: "CPU cores", value: "\(ProcessInfo.processInfo.activeProcessorCount)")
        } header: {
            Text("About Video Pilot")
        }
        .listRowBackground(MK8Theme.card)
    }

    // MARK: Actions

    private func refreshStorage() async {
        storage = await VPStorage.measure()
    }

    private func clearTemporary() async {
        guard !cleaning, !host.busy, host.preparation == nil, !host.pipPlayback.active else { return }
        cleaning = true
        let freed = await VPStorage.clearTemporary()
        cleaning = false
        storageNote = freed > 0 ? "Freed \(VPFormat.bytes(freed))." : "Nothing to clear."
        await refreshStorage()
    }
}
