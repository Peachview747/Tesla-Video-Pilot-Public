import SwiftUI
import UIKit
import Charts
import UniformTypeIdentifiers
import MK8Core

@main struct MK8App: App {
    @UIApplicationDelegateAdaptor(MK8AppDelegate.self) private var appDelegate
    @StateObject private var host = HostModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            AppRootView(host: host)
            .tint(MK8Theme.accent)
            .preferredColorScheme(.dark)
            .onChange(of: phase) { _, value in
                if value == .background { host.backgrounded() }
                if value == .active { host.foregrounded() }
            }
        }
    }
}

private enum AppSection: String, CaseIterable, Identifiable {
    case dashboard, network, youtube, library, settings
    var id: String { rawValue }
    var title: String {
        switch self {
        case .dashboard: return "Dashboard"
        case .network: return "Network & tunnel"
        case .youtube: return "YouTube"
        case .library: return "Library"
        case .settings: return "Settings"
        }
    }
    var icon: String {
        switch self {
        case .dashboard: return "rectangle.grid.2x2.fill"
        case .network: return "antenna.radiowaves.left.and.right"
        case .youtube: return "play.rectangle.fill"
        case .library: return "books.vertical.fill"
        case .settings: return "gearshape.fill"
        }
    }
}

private struct AppRootView: View {
    @ObservedObject var host: HostModel
    @State private var selection: AppSection = .dashboard
    var body: some View {
        NavigationStack {
            Group {
                switch selection {
                case .dashboard: DashboardView(host: host)
                case .network: NetworkView(host: host)
                case .youtube: YouTubeView(host: host)
                case .library: LibraryView(host: host)
                case .settings: HostSettingsView(host: host)
                }
            }
            .navigationTitle(selection.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Section("Video Pilot") {
                            ForEach(AppSection.allCases) { section in
                                Button {
                                    withAnimation(.easeInOut(duration: 0.18)) { selection = section }
                                } label: {
                                    Label(section.title, systemImage: section.icon)
                                }
                            }
                        }
                    } label: {
                        Image(systemName: "line.3.horizontal")
                            .font(.headline)
                            .accessibilityLabel("Open Video Pilot menu")
                    }
                }
            }
        }
    }
}

private enum MK8Theme {
    static let background = Color(red: 0.035, green: 0.055, blue: 0.115)
    static let card = Color(red: 0.075, green: 0.105, blue: 0.18)
    static let accent = Color(red: 1, green: 0.30, blue: 0.36)
    static let secondary = Color(red: 0.61, green: 0.68, blue: 0.79)
}

private struct HostScreen<Content: View>: View {
    let title: String
    let content: Content
    init(title: String, @ViewBuilder content: () -> Content) { self.title = title; self.content = content() }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) { content }.padding(20)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .background(MK8Theme.background.ignoresSafeArea())
    }
}

private struct HostCard<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background(MK8Theme.card, in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(.white.opacity(0.055), lineWidth: 1))
    }
}

private struct StatusPill: View {
    let title: String
    let color: Color
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(title).font(.caption.weight(.semibold))
        }.foregroundStyle(color).padding(.horizontal, 10).padding(.vertical, 6)
            .background(color.opacity(0.12), in: Capsule())
    }
}

private struct DashboardView: View {
    @ObservedObject var host: HostModel
    @State private var chargingView = false
    var body: some View {
        HostScreen(title: "Video Pilot") {
            HostCard {
                HStack(spacing: 12) {
                    Image("BrandMark").resizable().scaledToFit().frame(width: 60, height: 60)
                        .clipShape(RoundedRectangle(cornerRadius: 15)).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Video Pilot").font(.title3.bold())
                        Text("Phone host for your Tesla").font(.subheadline).foregroundStyle(MK8Theme.secondary)
                    }
                }
                HStack(spacing: 10) {
                    StatusPill(title: host.running ? (host.activeStreams > 0 ? "Streaming" : "Ready") :
                                (host.authorizingHost ? "Authorizing" : (host.hostAuthorized ? "Authorized" : "Face ID required")),
                               color: host.running ? .green : (host.authorizingHost ? .orange : MK8Theme.secondary))
                    Text(host.running ? "Tesla connection is ready" :
                            (host.authorizingHost ? "Waiting for Face ID" : "Start hosting when you are ready"))
                        .font(.subheadline).foregroundStyle(MK8Theme.secondary)
                }
                Button { if host.running { host.stop() } else { host.start() } } label: {
                    Label(host.running ? "Stop hosting" : (host.authorizingHost ? "Waiting for Face ID…" : "Start hosting"),
                          systemImage: host.running ? "stop.fill" : "antenna.radiowaves.left.and.right")
                        .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
                }.buttonStyle(.borderedProminent).controlSize(.large).disabled(host.authorizingHost)
                if !host.running && !host.hostAuthorized && !host.authorizingHost {
                    Label("Face ID is requested once per app session before the host starts.", systemImage: "faceid")
                        .font(.footnote).foregroundStyle(MK8Theme.secondary)
                }
                if !host.message.isEmpty {
                    Text(host.message).font(.footnote).foregroundStyle(MK8Theme.secondary).lineLimit(2)
                        .textSelection(.enabled)
                }
            }
            if let progress = host.preparation {
                HostCard {
                    HStack {
                        Label("Preparing video", systemImage: "arrow.down.circle")
                            .font(.headline)
                        Spacer()
                        if let fraction = progress.fraction {
                            Text("\(Int(fraction * 100))%")
                                .font(.subheadline.monospacedDigit().weight(.semibold))
                                .foregroundStyle(MK8Theme.accent)
                        }
                    }
                    Text(host.preparingTitle).font(.subheadline).foregroundStyle(MK8Theme.secondary).lineLimit(2)
                    if let fraction = progress.fraction { ProgressView(value: fraction).tint(MK8Theme.accent) }
                    else { ProgressView().tint(MK8Theme.accent) }
                    Text(host.queuedCount > 0 ? "\(host.queuedCount) queued next" : "The finished video will appear in Library")
                        .font(.caption).foregroundStyle(MK8Theme.secondary)
                }
            }
            HostCard {
                HStack {
                    Label("Connection", systemImage: host.running ? "checkmark.circle.fill" : "pause.circle")
                        .font(.subheadline.weight(.medium))
                    Spacer()
                    Text(host.running ? host.tunnelState.title : "Not hosting")
                        .font(.subheadline).foregroundStyle(host.running ? .green : MK8Theme.secondary)
                }
                HStack {
                    Label("Library", systemImage: "books.vertical")
                        .font(.subheadline.weight(.medium))
                    Spacer()
                    Text("\(host.videos.filter { $0.state == "ready" }.count) ready · \(host.queuedCount) queued")
                        .font(.subheadline).foregroundStyle(MK8Theme.secondary)
                }
            }
            if host.running || host.busy {
                Button("Dim screen for charging", systemImage: "moon.fill") { chargingView = true }
                    .buttonStyle(.bordered).frame(maxWidth: .infinity)
            }
            Text("Detailed tunnel, address, and traffic controls are in Network & tunnel.")
                .font(.footnote).foregroundStyle(MK8Theme.secondary).padding(.horizontal, 4)
        }.fullScreenCover(isPresented: $chargingView) { ChargingView(host: host) }
    }
}

private struct ChargingView: View {
    @ObservedObject var host: HostModel
    @Environment(\.dismiss) private var dismiss
    @State private var previousBrightness: CGFloat?
    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image("BrandMark").resizable().scaledToFit().frame(width: 100, height: 100).accessibilityHidden(true)
            Text(host.activeStreams > 0 ? "Playing in your Tesla" : (host.running ? "Ready for your Tesla" : "Preparing video"))
                .font(.title2.weight(.medium))
            StatusPill(title: host.tunnelState.title, color: host.tunnelState == .connected ? .green : .orange)
            if let progress = host.preparation {
                Text(host.preparingTitle).font(.subheadline).lineLimit(2)
                if let fraction = progress.fraction { ProgressView(value: fraction).tint(MK8Theme.accent) }
                else { ProgressView().tint(MK8Theme.accent) }
            }
            Text("↓ \(host.traffic.downloadMbps, specifier: "%.2f")   ↑ \(host.traffic.uploadMbps, specifier: "%.2f") Mb/s")
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            Spacer()
            Text("Keep this screen open for continuous playback. Locking the phone can pause hosting.")
                .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Back to Video Pilot", systemImage: "chevron.down") { dismiss() }.buttonStyle(.bordered).controlSize(.large)
        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity).background(.black).foregroundStyle(.white)
            .onAppear { previousBrightness = UIScreen.main.brightness; UIScreen.main.brightness = min(UIScreen.main.brightness, 0.08) }
            .onDisappear { if let previousBrightness { UIScreen.main.brightness = previousBrightness } }
    }
}

private struct ConnectionCard: View {
    @ObservedObject var host: HostModel
    private var tunnelColor: Color {
        switch host.tunnelState {
        case .connected: return .green
        case .failed: return .red
        default: return .orange
        }
    }
    var body: some View {
        HostCard {
            Text("Connections").font(.headline)
            ConnectionRow(title: "Tesla host", value: host.running ? (host.activeStreams > 0 ? "Streaming" : "Ready") : "Stopped",
                          symbol: host.running ? "antenna.radiowaves.left.and.right" : "pause.circle",
                          color: host.running ? .green : MK8Theme.secondary,
                          animating: host.activeStreams > 0)
            Divider().overlay(Color.white.opacity(0.04))
            ConnectionRow(title: "Cloudflare tunnel", value: host.tunnelState.title,
                          symbol: host.tunnelState.symbol, color: tunnelColor, animating: host.tunnelState.animating)
            Divider().overlay(Color.white.opacity(0.04))
            ConnectionRow(title: "Phone internet", value: host.phoneConnection.name,
                          symbol: host.phoneConnection.symbol,
                          color: host.phoneConnection.state == .online ? .green : MK8Theme.secondary,
                          animating: host.phoneConnection.state == .connecting)
            if host.phoneConnection.lowDataMode {
                Label("Low Data Mode is on", systemImage: "leaf").font(.caption).foregroundStyle(MK8Theme.secondary)
            }
            Text("PUBLIC ADDRESS").font(.caption2.weight(.semibold)).tracking(1).foregroundStyle(MK8Theme.secondary)
            HStack {
                Text(host.publicURL.host ?? host.publicURL.absoluteString)
                    .font(.system(.footnote, design: .monospaced)).textSelection(.enabled).lineLimit(1).minimumScaleFactor(0.7)
                Spacer(minLength: 4)
                CopyButton(value: host.publicURL.absoluteString)
            }
            Text(host.tunnelMessage).font(.footnote).foregroundStyle(MK8Theme.secondary).textSelection(.enabled)
            if host.running, host.tunnelEnabled, host.tunnelState != .notConfigured {
                Button("Reconnect tunnel", systemImage: "arrow.clockwise") { host.connectTunnel() }
                    .buttonStyle(.bordered).disabled(host.tunnelState.animating)
            }
        }
    }
}

private struct ConnectionRow: View {
    let title: String
    let value: String
    let symbol: String
    let color: Color
    var animating = false
    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.title3).foregroundStyle(color).frame(width: 30)
                .symbolEffect(.pulse, options: .repeating, isActive: animating)
                .accessibilityHidden(true)
            Text(title).font(.subheadline)
            Spacer()
            Text(value).font(.subheadline.weight(.medium)).foregroundStyle(color).multilineTextAlignment(.trailing)
        }.accessibilityElement(children: .combine)
    }
}

private struct AddressCard: View {
    @ObservedObject var host: HostModel
    var body: some View {
        HostCard {
            Text("Open in the Tesla browser").font(.headline)
            if host.tunnelState == .connected {
                HStack {
                    Text(host.publicURL.absoluteString).font(.system(.subheadline, design: .monospaced))
                        .textSelection(.enabled).lineLimit(1).minimumScaleFactor(0.7)
                    Spacer(minLength: 4)
                    CopyButton(value: host.publicURL.absoluteString)
                }
                Text("Your public address works over Wi-Fi or cellular while Video Pilot stays open.")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
            }
            if host.localURLs.isEmpty {
                if host.tunnelState != .connected {
                    Text("Connect the tunnel, or join the same Wi-Fi as the Tesla for a local address.")
                        .font(.subheadline).foregroundStyle(MK8Theme.secondary)
                }
            } else {
                ForEach(host.localURLs, id: \.self) { url in
                    HStack {
                        Text(url).font(.system(.subheadline, design: .monospaced)).textSelection(.enabled)
                            .lineLimit(1).minimumScaleFactor(0.7)
                        Spacer(minLength: 4)
                        CopyButton(value: url)
                    }
                }
            }
            Divider()
            Label("Public access enabled", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(MK8Theme.accent)
            Text("Face ID authorizes this iPhone app session before hosting starts. Once active, anyone who obtains the address can view the library, queue downloads, and stream videos, so keep it private.")
                .font(.footnote).foregroundStyle(MK8Theme.secondary)
        }
    }
}

private struct CopyButton: View {
    let value: String
    @State private var copied = false
    var body: some View {
        Button {
            UIPasteboard.general.string = value
            copied = true
            Task { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc").frame(width: 32, height: 32)
        }.buttonStyle(.bordered).accessibilityLabel(copied ? "Copied" : "Copy " + value)
    }
}

private struct PreparationCard: View {
    let progress: MediaPreparationProgress
    @ObservedObject var host: HostModel
    @ObservedObject private var background = BackgroundPreparation.shared
    private var remaining: String? {
        guard let seconds = progress.secondsRemaining, seconds.isFinite, seconds > 0 else { return nil }
        if seconds < 60 { return "About \(max(1, Int(seconds)))s left" }
        return "About \(Int(ceil(seconds / 60))) min left"
    }
    private var phase: (String, String) {
        switch progress.stage {
        case .resolving: return ("Finding your video", "magnifyingglass")
        case .importing: return ("Importing video", "square.and.arrow.down")
        case .downloading: return ("Downloading video", "arrow.down.circle")
        case .waitingForApp: return ("Download complete", "pause.circle")
        case .processing: return ("Preparing for playback", "gearshape.2")
        case .finalizing: return ("Adding to your library", "checkmark.circle")
        }
    }
    var body: some View {
        HostCard {
            HStack {
                Label(phase.0, systemImage: phase.1).font(.headline)
                Spacer()
                if let fraction = progress.fraction {
                    Text("\(Int(fraction * 100))%").font(.headline.monospacedDigit()).foregroundStyle(MK8Theme.accent)
                }
            }
            Text(host.preparingTitle).font(.subheadline).foregroundStyle(MK8Theme.secondary).lineLimit(2)
            if let fraction = progress.fraction {
                ProgressView(value: fraction).tint(MK8Theme.accent)
                    .animation(.easeInOut(duration: 0.2), value: fraction)
            } else { ProgressView().tint(MK8Theme.accent) }
            if progress.stage == .downloading {
                Text(ByteCountFormatter.string(fromByteCount: progress.completedBytes, countStyle: .file)
                     + (progress.totalBytes.map { " of " + ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? " downloaded"))
                    .font(.footnote.monospacedDigit()).foregroundStyle(MK8Theme.secondary)
                HStack {
                    Text(String(format: "%.2f MB/s", progress.bytesPerSecond / 1_000_000))
                    Spacer()
                    Text(remaining ?? "Estimating time…")
                }.font(.caption.monospacedDigit()).foregroundStyle(MK8Theme.secondary)
                Text(String(format: "%.2f Mb/s", progress.bytesPerSecond * 8 / 1_000_000)
                     + (progress.transferMode == .parallel ? " · Parallel download" : (progress.transferMode == .background ? " · Background download" : " · Download")))
                    .font(.caption2.monospacedDigit()).foregroundStyle(MK8Theme.secondary)
            } else if progress.stage == .waitingForApp {
                Text("Reopen Video Pilot to finish preparing this video.").font(.footnote).foregroundStyle(MK8Theme.secondary)
            } else if progress.stage == .processing {
                HStack {
                    if let speed = progress.processingSpeed {
                        Text(String(format: "%.1f× real time", speed))
                    } else {
                        Text("Measuring preparation speed…")
                    }
                    Spacer()
                    Text(remaining ?? "Estimating time…")
                }.font(.caption.monospacedDigit()).foregroundStyle(MK8Theme.secondary)
            }
            HStack {
                if let started = host.preparationStartedAt { Text(started, style: .relative).foregroundStyle(MK8Theme.secondary) }
                Spacer()
                Button("Pause", systemImage: "pause.fill") { host.pausePreparation() }.buttonStyle(.bordered)
            }.font(.caption)
            if progress.stage == .downloading, let id = host.preparingID,
               let details = host.downloadDiagnostics(for: id) {
                ShareLink(item: details) {
                    Label("Share download details", systemImage: "square.and.arrow.up")
                }.font(.caption)
            }
            if background.isRunning {
                Label("Can continue while locked", systemImage: "lock.iphone").font(.caption).foregroundStyle(.green)
            }
        }
    }
}

private struct TrafficCard: View {
    @ObservedObject var host: HostModel
    private var samples: [TransferSample] {
        host.trafficHistory.filter { $0.timestamp >= host.traffic.timestamp - 29 && $0.timestamp <= host.traffic.timestamp }
    }
    private var ceiling: Double {
        max(1, (samples.map { max($0.downloadMbps, $0.uploadMbps) }.max() ?? 0) * 1.2)
    }
    var body: some View {
        HostCard {
            HStack {
                Text("Live traffic").font(.headline)
                Spacer()
                Text("Mb/s").font(.caption).foregroundStyle(MK8Theme.secondary)
            }
            HStack {
                RateValue(title: "Receiving", value: host.traffic.downloadMbps, symbol: "arrow.down", color: .cyan)
                Spacer()
                RateValue(title: "Sending", value: host.traffic.uploadMbps, symbol: "arrow.up", color: MK8Theme.accent)
            }
            Chart(samples) { sample in
                LineMark(x: .value("Time", sample.timestamp), y: .value("Speed", sample.downloadMbps))
                    .foregroundStyle(by: .value("Direction", "Receiving")).interpolationMethod(.linear)
                LineMark(x: .value("Time", sample.timestamp), y: .value("Speed", sample.uploadMbps))
                    .foregroundStyle(by: .value("Direction", "Sending")).interpolationMethod(.linear)
            }
            .chartForegroundStyleScale(["Receiving": Color.cyan, "Sending": MK8Theme.accent])
            .chartLegend(.hidden).chartXAxis(.hidden)
            .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) }
            .chartYScale(domain: 0...ceiling)
            .chartXScale(domain: (host.traffic.timestamp - 29)...host.traffic.timestamp)
            .chartPlotStyle { plot in plot.clipped() }
            .frame(height: 85).accessibilityLabel("Receiving and sending traffic over the last thirty seconds")
            HStack {
                Text("↓ " + ByteCountFormatter.string(fromByteCount: host.traffic.totalReceivedBytes, countStyle: .file))
                Spacer()
                Text("↑ " + ByteCountFormatter.string(fromByteCount: host.traffic.totalSentBytes, countStyle: .file))
            }.font(.caption.monospacedDigit()).foregroundStyle(MK8Theme.secondary)
            Text("Actual Video Pilot traffic · last 30 seconds · \(host.activeStreams) active \(host.activeStreams == 1 ? "stream" : "streams")")
                .font(.footnote).foregroundStyle(MK8Theme.secondary)
        }
    }
}

private struct RateValue: View {
    let title: String
    let value: Double
    let symbol: String
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: symbol).font(.caption).foregroundStyle(color)
            Text(value.formatted(.number.precision(.fractionLength(2))))
                .font(.system(size: 30, weight: .semibold, design: .rounded)).monospacedDigit()
        }.accessibilityElement(children: .combine)
    }
}

private struct NetworkView: View {
    @ObservedObject var host: HostModel
    var body: some View {
        HostScreen(title: "Network & tunnel") {
            HostCard {
                Label("Connection center", systemImage: "antenna.radiowaves.left.and.right")
                    .font(.headline)
                Text("Monitor the phone, Tesla host, and Cloudflare tunnel from one place.")
                    .font(.subheadline).foregroundStyle(MK8Theme.secondary)
            }
            ConnectionCard(host: host)
            if host.running { AddressCard(host: host) }
            TrafficCard(host: host)
        }
    }
}

private struct YouTubeView: View {
    @ObservedObject var host: HostModel
    var body: some View {
        HostScreen(title: "YouTube") {
            HostCard {
                Label("Explore YouTube", systemImage: "play.rectangle.fill").font(.headline)
                Text("Search and browse from the Tesla web interface, then add videos to the Video Pilot queue.")
                    .font(.subheadline).foregroundStyle(MK8Theme.secondary)
                Label("Video links work without an API key", systemImage: "checkmark.circle.fill")
                    .font(.footnote).foregroundStyle(.green)
            }
            HostCard {
                Label("YouTube search key", systemImage: "magnifyingglass").font(.headline)
                SecureField("Optional YouTube Data API key", text: $host.searchKey)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                    .padding(14).background(MK8Theme.background, in: RoundedRectangle(cornerRadius: 12))
                Button("Save search key", systemImage: "key") { host.saveSearchKey() }.buttonStyle(.bordered)
                Text("A key enables keyword search and richer Explore results. It is stored in the iPhone Keychain and used by the Tesla UI.")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
            }
            HostCard {
                Label("Quick start", systemImage: "bolt.fill").font(.headline)
                Text("Open the public Video Pilot address in the Tesla browser. Paste a YouTube URL there to prepare it for playback.")
                    .font(.subheadline).foregroundStyle(MK8Theme.secondary)
                HStack {
                    Text(host.publicURL.absoluteString).font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled).lineLimit(1).minimumScaleFactor(0.65)
                    Spacer(minLength: 4)
                    CopyButton(value: host.publicURL.absoluteString)
                }
            }
        }
    }
}

private struct LibraryView: View {
    @ObservedObject var host: HostModel
    @State private var youtubeURL = ""
    @State private var importing = false
    var body: some View {
        HostScreen(title: "Your videos") {
            HostCard {
                HStack {
                    Label("Add a video", systemImage: "play.rectangle.fill").font(.headline)
                    Spacer()
                    PasteButton(payloadType: String.self) { values in if let value = values.first { youtubeURL = value } }
                        .labelStyle(.iconOnly).buttonBorderShape(.roundedRectangle)
                }
                TextField("Paste a video link or ID", text: $youtubeURL)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .padding(14).background(MK8Theme.background, in: RoundedRectangle(cornerRadius: 12))
                Picker("Quality", selection: $host.mediaQuality) {
                    ForEach(MediaQuality.allCases) { quality in Text(quality.title).tag(quality) }
                }.pickerStyle(.menu).tint(MK8Theme.accent).disabled(host.busy)
                Text(host.mediaQuality == .high ? "Larger download and longer preparation." : "Smaller downloads. Faster preparation.")
                    .font(.caption).foregroundStyle(MK8Theme.secondary)
                Button { host.addYouTube(youtubeURL); youtubeURL = "" } label: {
                    Label(host.busy ? "Add to queue" : "Download & prepare", systemImage: "arrow.down.circle.fill").frame(maxWidth: .infinity)
                }.buttonStyle(.borderedProminent).controlSize(.large)
                    .disabled(youtubeURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button { importing = true } label: {
                    Label("Import from Files", systemImage: "folder").frame(maxWidth: .infinity)
                }.buttonStyle(.bordered).controlSize(.large).disabled(host.busy)
            }
            if let progress = host.preparation { PreparationCard(progress: progress, host: host) }
            if host.videos.isEmpty {
                ContentUnavailableView("Your library starts here", systemImage: "play.rectangle",
                    description: Text("Add a YouTube link or import a video from Files."))
            } else {
                HStack {
                    Text("LIBRARY").font(.caption.weight(.semibold)).tracking(1)
                    Spacer()
                    Text("\(host.videos.filter { $0.state == "ready" }.count) ready" + (host.queuedCount > 0 ? " · \(host.queuedCount) queued" : "")).font(.caption)
                }.foregroundStyle(MK8Theme.secondary).padding(.horizontal, 4)
                ForEach(host.videos) { video in VideoCard(video: video, host: host) }
            }
        }.fileImporter(isPresented: $importing, allowedContentTypes: [.movie, UTType(filenameExtension: "ts") ?? .data]) { result in
            switch result {
            case .success(let url): host.importVideo(url)
            case .failure(let error): host.message = error.localizedDescription
            }
        }
    }
}

private struct VideoCard: View {
    let video: LibraryVideo
    @ObservedObject var host: HostModel
    private var color: Color { video.state == "ready" ? .green : (video.state == "failed" ? .red : .orange) }
    private var symbol: String { video.state == "ready" ? "play.circle.fill" : (video.state == "failed" ? "exclamationmark.circle" : "clock") }
    var body: some View {
        HostCard {
            HStack(alignment: .top, spacing: 12) {
                if let id = video.youtubeID {
                    AsyncImage(url: URL(string: "https://i.ytimg.com/vi/\(id)/mqdefault.jpg")) { image in
                        image.resizable().scaledToFill()
                    } placeholder: { Image(systemName: symbol).font(.title).foregroundStyle(color) }
                    .frame(width: 72, height: 48).clipped().clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityHidden(true)
                } else { Image(systemName: symbol).font(.title).foregroundStyle(color).accessibilityHidden(true) }
                VStack(alignment: .leading, spacing: 6) {
                    Text(video.title).font(.headline).lineLimit(2)
                    if video.state == "ready" {
                        Text("Ready to play" + (video.duration.map { " · \(Int($0) / 60):" + String(format: "%02d", Int($0) % 60) } ?? ""))
                            .font(.footnote).foregroundStyle(color)
                    } else {
                        Text(video.message ?? (video.state == "preparing" ? "Preparing your video" : video.state.capitalized))
                            .font(.footnote).foregroundStyle(video.state == "failed" ? .red : MK8Theme.secondary)
                            .textSelection(.enabled)
                    }
                }
                Spacer(minLength: 0)
                Menu {
                    if let id = video.youtubeID {
                        Button("Copy YouTube link", systemImage: "link") { UIPasteboard.general.string = "https://youtu.be/" + id }
                    }
                    Button("Delete video", systemImage: "trash", role: .destructive) { host.remove(video.id) }
                        .disabled(host.busy && host.preparingID == video.id)
                } label: { Image(systemName: "ellipsis").padding(6) }.accessibilityLabel("Video actions")
            }
            if video.state == "failed" || video.state == "paused" {
                HStack {
                    Button(video.state == "paused" ? "Resume" : "Retry", systemImage: "arrow.clockwise") { host.retry(video.id) }
                        .buttonStyle(.borderedProminent).disabled(host.busy)
                    if let file = host.diagnostics(for: video.id) {
                        ShareLink(item: file) { Label("Error details", systemImage: "square.and.arrow.up") }.buttonStyle(.bordered)
                    }
                }
            }
        }
    }
}

private struct HostSettingsView: View {
    @ObservedObject var host: HostModel
    @ObservedObject private var background = BackgroundPreparation.shared
    var body: some View {
        HostScreen(title: "Settings") {
            HostCard {
                Label("App authorization", systemImage: "faceid").font(.headline)
                Text(host.hostAuthorized ? "Face ID approved for this app session." : "Face ID will be requested once before hosting starts.")
                    .font(.subheadline).foregroundStyle(MK8Theme.secondary)
                Label(host.hostAuthorized ? "Authorized" : "Not yet authorized",
                      systemImage: host.hostAuthorized ? "checkmark.shield.fill" : "lock.shield")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(host.hostAuthorized ? .green : MK8Theme.secondary)
                Text("Stopping and restarting hosting in this same app session will not ask again. Relaunching Video Pilot requires a fresh Face ID check.")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
            }
            HostCard {
                Label("YouTube account", systemImage: "person.crop.circle.badge.checkmark").font(.headline)
                if host.youtubeSignedIn {
                    Label("Google account connected", systemImage: "checkmark.circle.fill")
                        .font(.subheadline).foregroundStyle(.green)
                    Text("The Tesla interface can now search with your account and show your subscriptions.")
                        .font(.footnote).foregroundStyle(MK8Theme.secondary)
                    Button("Disconnect Google", systemImage: "rectangle.portrait.and.arrow.right") { host.signOutYouTube() }
                        .buttonStyle(.bordered)
                } else {
                    Text("Sign in once on this iPhone to unlock account-aware YouTube search and subscriptions. Google tokens stay in the Keychain.")
                        .font(.subheadline).foregroundStyle(MK8Theme.secondary)
                    Button("Sign in with Google", systemImage: "person.crop.circle") { host.signInYouTube() }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                }
            }
            HostCard {
                Label("Cloudflare tunnel", systemImage: "icloud").font(.headline)
                Toggle("Connect when hosting", isOn: $host.tunnelEnabled)
                SecureField("TV_SECRET from your MK8 .env", text: $host.tunnelKey)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                    .padding(14).background(MK8Theme.background, in: RoundedRectangle(cornerRadius: 12))
                Button("Save tunnel key", systemImage: "key") { host.saveTunnelKey() }.buttonStyle(.bordered)
                Text("Run the iPhone tunnel setup on your PC once, then save the same TV_SECRET here. The key stays in this phone's Keychain.")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
                Text(host.tunnelMessage).font(.footnote).foregroundStyle(MK8Theme.secondary).textSelection(.enabled)
            }
            HostCard {
                Text("Background & charging").font(.headline)
                Toggle("Background downloads", isOn: $host.backgroundDownloads)
                Text("Downloads can continue on Wi-Fi or cellular while locked. Keep Video Pilot in the app switcher.")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
                Divider()
                Toggle("Background preparation", isOn: $host.backgroundPreparation)
                Text("On iOS 26, Video Pilot requests time to finish each video while locked. iOS may decline or stop the task; Resume keeps completed downloads.")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
                Text(background.status).font(.caption).foregroundStyle(background.isRunning ? .green : MK8Theme.secondary)
                Text("When you switch to another app, downloads and queued jobs resume automatically when iOS grants background time. You’ll get a notification when a video is ready.")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
                Divider()
                Toggle("Allow extra background time", isOn: $host.allowBackgroundTime)
                Text("Gives hosting a short grace period. Charging does not enable unlimited hosting while locked.")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
                Divider()
                Toggle("Keep screen awake", isOn: $host.keepScreenAwake)
                Text("Keep this on while charging for continuous Tesla playback. Applies while hosting or preparing.")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
            }
            HostCard {
                Label("YouTube search", systemImage: "magnifyingglass").font(.headline)
                SecureField("Optional YouTube Data API key", text: $host.searchKey)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().privacySensitive()
                    .padding(14).background(MK8Theme.background, in: RoundedRectangle(cornerRadius: 12))
                Button("Save search key", systemImage: "key") { host.saveSearchKey() }.buttonStyle(.bordered)
                Text("Enables keyword searches in the Tesla interface. Video link downloads work without a key.")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
            }
            HostCard {
                Text("Your public address").font(.headline)
                Text(host.publicURL.absoluteString).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                Text("Face ID authorizes this app session before hosting starts. Open this address in the Tesla browser while hosting is active; anyone who obtains it can use the host, so keep it private.")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
                ShareLink(item: host.publicURL) { Label("Share address", systemImage: "square.and.arrow.up") }.buttonStyle(.bordered)
            }
            HStack {
                Text("Video Pilot")
                Spacer()
                Text("Version \(host.version) · build \(host.build)")
            }.font(.footnote).foregroundStyle(MK8Theme.secondary).padding(.horizontal, 4)
        }
    }
}
