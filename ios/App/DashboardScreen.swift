import SwiftUI
import UIKit
import MK8Core

/// Home tab: hosting state, connection health at a glance, the Tesla address
/// and the preparation queue with live progress.
struct VPDashboardScreen: View {
    @ObservedObject var host: HostModel
    @Binding var selection: VPTab
    @ObservedObject private var diagnostics = SessionDiagnostics.shared
    @State private var chargingView = false

    private var readyCount: Int { host.videos.filter { $0.state == "ready" }.count }
    private var queued: [LibraryVideo] {
        host.videos.filter { $0.state == "preparing" && $0.id != host.preparingID }
            .sorted { $0.createdAt < $1.createdAt }
    }
    private var attention: [LibraryVideo] { host.videos.filter { $0.vpNeedsAttention } }

    var body: some View {
        HostScreen {
            VPHostingCard(host: host)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                VPMetricTile(title: "Tunnel", value: tunnelValue, detail: tunnelDetail,
                             symbol: host.running ? host.tunnelState.symbol : "icloud.slash",
                             color: host.running ? host.tunnelState.vpColor : MK8Theme.secondary)
                VPMetricTile(title: "Tesla", value: teslaValue, detail: teslaDetail,
                             symbol: host.activeStreams > 0 ? "car.fill" : "car",
                             color: host.activeStreams > 0 ? MK8Theme.good : MK8Theme.secondary)
                VPMetricTile(title: "iPhone network", value: host.phoneConnection.name, detail: networkDetail,
                             symbol: host.phoneConnection.symbol,
                             color: host.phoneConnection.state == .online ? MK8Theme.good : MK8Theme.warning)
                Button { selection = .library } label: {
                    VPMetricTile(title: "Library", value: "\(readyCount) ready", detail: libraryDetail,
                                 symbol: "rectangle.stack.fill",
                                 color: attention.isEmpty ? MK8Theme.accent : MK8Theme.warning)
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the library")
            }
            if host.running { VPTeslaAddressCard(host: host) }

            VPSectionHeader(title: "Queue", trailing: queueSummary)
            if let progress = host.preparation {
                VPPreparationCard(progress: progress, host: host)
            }
            if !queued.isEmpty {
                VPUpNextCard(videos: queued, host: host, waiting: host.preparation == nil)
            }
            if host.preparation == nil && queued.isEmpty {
                HostCard {
                    HStack(spacing: 12) {
                        Image(systemName: "tray").font(.title2).foregroundStyle(MK8Theme.secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Nothing preparing").font(.headline)
                            Text("Add a video here or from the Tesla browser.")
                                .font(.footnote).foregroundStyle(MK8Theme.secondary)
                        }
                        Spacer(minLength: 0)
                        Button("Add") { selection = .library }.buttonStyle(.bordered)
                    }
                }
            }
            if !attention.isEmpty { VPAttentionCard(videos: attention, host: host, selection: $selection) }

            VPSectionHeader(title: "Live traffic")
            Button { selection = .diagnostics } label: {
                HostCard {
                    HStack(spacing: 18) {
                        VPRate(title: "Receiving", value: host.traffic.downloadMbps, symbol: "arrow.down", color: MK8Theme.blue)
                        VPRate(title: "Sending", value: host.traffic.uploadMbps, symbol: "arrow.up", color: MK8Theme.accent)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(MK8Theme.secondary)
                    }
                    Text("Mb/s · \(host.activeStreams) active \(host.activeStreams == 1 ? "stream" : "streams") · tap for diagnostics")
                        .font(.caption).foregroundStyle(MK8Theme.secondary)
                }
            }
            .buttonStyle(.plain)
        }
        .navigationTitle("Video Pilot")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { chargingView = true } label: { Image(systemName: "moon.fill") }
                    .accessibilityLabel("Dim screen for charging")
            }
        }
        .fullScreenCover(isPresented: $chargingView) { VPChargingView(host: host) }
    }

    private var tunnelValue: String { host.running ? host.tunnelState.title : "Off" }
    private var tunnelDetail: String {
        guard host.running else { return host.tunnelEnabled ? "Starts with hosting" : "Turned off in Settings" }
        if host.tunnelState == .connected, let rtt = diagnostics.tunnelRTTMs {
            return "Round trip " + VPFormat.milliseconds(rtt)
        }
        return host.tunnelState == .connected ? "Measuring latency…" : "Public address unavailable"
    }
    private var teslaValue: String {
        if host.activeStreams > 0 { return "Playing" }
        return host.running ? "Waiting" : "Offline"
    }
    private var teslaDetail: String {
        if host.activeStreams > 0 {
            return "\(host.activeStreams) \(host.activeStreams == 1 ? "stream" : "streams") · " + VPFormat.mbps(host.traffic.uploadMbps)
        }
        return host.running ? "Open the address in the car" : "Start hosting first"
    }
    private var networkDetail: String {
        if host.phoneConnection.lowDataMode { return "Low Data Mode on" }
        if host.phoneConnection.expensive { return "Metered connection" }
        return host.phoneConnection.state == .online ? "Online" : "Check the connection"
    }
    private var libraryDetail: String {
        if !attention.isEmpty { return "\(attention.count) need attention" }
        let preparing = queued.count + (host.preparation == nil ? 0 : 1)
        return preparing > 0 ? "\(preparing) preparing" : "All caught up"
    }
    private var queueSummary: String? {
        let count = queued.count + (host.preparation == nil ? 0 : 1)
        return count > 0 ? "\(count) in queue" : nil
    }
}

/// Big start/stop card: the one action the app exists for.
private struct VPHostingCard: View {
    @ObservedObject var host: HostModel
    private var statusTitle: String {
        if host.running { return host.activeStreams > 0 ? "Streaming" : "Hosting" }
        if host.authorizingHost { return "Authorizing" }
        return host.hostAuthorized ? "Stopped" : "Face ID required"
    }
    private var statusColor: Color {
        if host.running { return MK8Theme.good }
        return host.authorizingHost ? MK8Theme.warning : MK8Theme.secondary
    }
    var body: some View {
        HostCard {
            HStack(alignment: .center, spacing: 14) {
                VPMark(size: 54).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(host.running ? "Your Tesla can connect" : "Hosting is off").font(.title3.weight(.bold))
                    StatusPill(title: statusTitle, color: statusColor)
                }
                Spacer(minLength: 0)
            }
            Button { if host.running { host.stop() } else { host.start() } } label: {
                Label(host.running ? "Stop hosting" : (host.authorizingHost ? "Waiting for Face ID…" : "Start hosting"),
                      systemImage: host.running ? "stop.fill" : "faceid")
                    .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent).controlSize(.large)
            .tint(host.running ? MK8Theme.accentDeep : MK8Theme.accent)
            .disabled(host.authorizingHost)
            if !host.running && !host.hostAuthorized && !host.authorizingHost {
                Label("Face ID is requested once per app session before hosting starts.", systemImage: "lock.shield")
                    .font(.footnote).foregroundStyle(MK8Theme.secondary)
            }
            if !host.message.isEmpty {
                Text(host.message).font(.footnote).foregroundStyle(MK8Theme.secondary).lineLimit(3)
                    .textSelection(.enabled)
            }
        }
    }
}

struct VPMetricTile: View {
    let title: String
    let value: String
    let detail: String
    let symbol: String
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: symbol).font(.subheadline.weight(.semibold)).foregroundStyle(color)
                Spacer()
                Circle().fill(color).frame(width: 7, height: 7)
            }
            Text(value).font(.headline).lineLimit(1).minimumScaleFactor(0.7)
            Text(title.uppercased()).font(.caption2.weight(.semibold)).tracking(0.6).foregroundStyle(MK8Theme.secondary)
            Text(detail).font(.caption).foregroundStyle(MK8Theme.secondary).lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 112, alignment: .topLeading)
        .padding(13)
        .background(MK8Theme.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(MK8Theme.steel.opacity(0.28), lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

private struct VPTeslaAddressCard: View {
    @ObservedObject var host: HostModel
    var body: some View {
        HostCard {
            Label("Open in the Tesla browser", systemImage: "safari").font(.headline)
            if host.tunnelState == .connected {
                HStack {
                    Text(host.publicURL.host ?? host.publicURL.absoluteString)
                        .font(.system(.subheadline, design: .monospaced))
                        .textSelection(.enabled).lineLimit(1).minimumScaleFactor(0.6)
                    Spacer(minLength: 4)
                    CopyButton(value: host.publicURL.absoluteString)
                }
                Text("Works over Wi-Fi or cellular. Anyone with this address can use the host, so keep it private.")
                    .font(.caption).foregroundStyle(MK8Theme.secondary)
            } else if host.tunnelEnabled && host.tunnelState != .notConfigured {
                HStack {
                    Text(host.tunnelMessage).font(.footnote).foregroundStyle(MK8Theme.secondary)
                    Spacer(minLength: 4)
                    Button("Reconnect", systemImage: "arrow.clockwise") { host.connectTunnel() }
                        .buttonStyle(.bordered).disabled(host.tunnelState.animating)
                }
            } else {
                Text(host.tunnelMessage).font(.footnote).foregroundStyle(MK8Theme.secondary)
            }
            if !host.localURLs.isEmpty {
                Divider()
                Text("SAME WI-FI").font(.caption2.weight(.semibold)).tracking(1).foregroundStyle(MK8Theme.secondary)
                ForEach(host.localURLs, id: \.self) { url in
                    HStack {
                        Text(url).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                            .lineLimit(1).minimumScaleFactor(0.7)
                        Spacer(minLength: 4)
                        CopyButton(value: url)
                    }
                }
            }
        }
    }
}

/// The video being prepared right now: stage, progress, speed and ETA.
struct VPPreparationCard: View {
    let progress: MediaPreparationProgress
    @ObservedObject var host: HostModel
    @ObservedObject private var background = BackgroundPreparation.shared
    private var preparingVideo: LibraryVideo? { host.videos.first { $0.id == host.preparingID } }
    var body: some View {
        HostCard {
            HStack(alignment: .top, spacing: 12) {
                VPThumbnail(youtubeID: preparingVideo?.youtubeID, symbol: progress.stage.vpSymbol,
                            color: MK8Theme.accent, width: 84)
                VStack(alignment: .leading, spacing: 4) {
                    Text(host.preparingTitle).font(.subheadline.weight(.semibold)).lineLimit(2)
                    Label(progress.stage.vpTitle, systemImage: progress.stage.vpSymbol)
                        .font(.caption.weight(.semibold)).foregroundStyle(MK8Theme.accent)
                }
                Spacer(minLength: 0)
                if let fraction = progress.fraction {
                    Text("\(Int(fraction * 100))%").font(.headline.monospacedDigit()).foregroundStyle(MK8Theme.accent)
                }
            }
            VPStageTrack(stage: progress.stage)
            if let fraction = progress.fraction {
                ProgressView(value: fraction).tint(MK8Theme.accent)
                    .animation(.easeInOut(duration: 0.2), value: fraction)
            } else {
                ProgressView().tint(MK8Theme.accent).frame(maxWidth: .infinity, alignment: .leading)
            }
            detail
            HStack(spacing: 10) {
                if let started = host.preparationStartedAt {
                    Label { Text(started, style: .timer) } icon: { Image(systemName: "stopwatch") }
                        .font(.caption.monospacedDigit()).foregroundStyle(MK8Theme.secondary)
                }
                if background.isRunning {
                    Label("Continues while locked", systemImage: "lock.iphone").font(.caption).foregroundStyle(MK8Theme.good)
                }
                Spacer()
                Button("Pause", systemImage: "pause.fill") { host.pausePreparation() }
                    .buttonStyle(.bordered).font(.caption)
            }
            if progress.stage == .downloading, let id = host.preparingID, let details = host.downloadDiagnostics(for: id) {
                ShareLink(item: details) { Label("Share download details", systemImage: "square.and.arrow.up") }
                    .font(.caption)
            }
        }
    }

    @ViewBuilder private var detail: some View {
        switch progress.stage {
        case .downloading:
            HStack {
                Text(VPFormat.bytes(progress.completedBytes)
                     + (progress.totalBytes.map { " of " + VPFormat.bytes($0) } ?? ""))
                Spacer()
                Text(VPFormat.mbps(progress.bytesPerSecond * 8 / 1_000_000))
            }
            .font(.caption.monospacedDigit()).foregroundStyle(MK8Theme.secondary)
            HStack {
                Text(transferModeText)
                Spacer()
                Text(VPFormat.eta(progress.secondsRemaining) ?? "Estimating time…")
            }
            .font(.caption.monospacedDigit()).foregroundStyle(MK8Theme.secondary)
        case .processing:
            HStack {
                if let speed = progress.processingSpeed {
                    Text(String(format: "%.1f× real time", speed))
                } else {
                    Text("Measuring conversion speed…")
                }
                Spacer()
                Text(VPFormat.eta(progress.secondsRemaining) ?? "Estimating time…")
            }
            .font(.caption.monospacedDigit()).foregroundStyle(MK8Theme.secondary)
        case .waitingForApp:
            Text("Download finished. Reopen Video Pilot if conversion does not start on its own.")
                .font(.caption).foregroundStyle(MK8Theme.secondary)
        case .resolving, .importing, .finalizing:
            EmptyView()
        }
    }

    private var transferModeText: String {
        guard let mode = progress.transferMode else { return "Download" }
        if mode == .parallel { return "Parallel download" }
        if mode == .background { return "Background download" }
        return "Download"
    }
}

/// Download → convert → library, with the current step highlighted.
private struct VPStageTrack: View {
    let stage: MediaPreparationProgress.Stage
    private var step: Int {
        switch stage {
        case .resolving, .importing, .downloading: return 0
        case .waitingForApp, .processing: return 1
        case .finalizing: return 2
        }
    }
    var body: some View {
        HStack(spacing: 6) {
            ForEach(Array(["Download", "Convert", "Save"].enumerated()), id: \.offset) { item in
                HStack(spacing: 4) {
                    Image(systemName: item.offset < step ? "checkmark.circle.fill" : (item.offset == step ? "circle.inset.filled" : "circle"))
                    Text(item.element)
                }
                .font(.caption2.weight(item.offset == step ? .bold : .regular))
                .foregroundStyle(item.offset <= step ? MK8Theme.accent : MK8Theme.secondary)
                if item.offset < 2 {
                    Capsule().fill(item.offset < step ? MK8Theme.accent : MK8Theme.steel.opacity(0.4))
                        .frame(height: 2).frame(maxWidth: .infinity)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(step + 1) of 3")
    }
}

private struct VPUpNextCard: View {
    let videos: [LibraryVideo]
    @ObservedObject var host: HostModel
    let waiting: Bool
    var body: some View {
        HostCard {
            HStack {
                Text("Up next").font(.headline)
                Spacer()
                Text("\(videos.count) waiting").font(.caption).foregroundStyle(MK8Theme.secondary)
            }
            if waiting {
                Text("The queue starts again when Video Pilot is open or iOS grants background time.")
                    .font(.caption).foregroundStyle(MK8Theme.secondary)
            }
            ForEach(Array(videos.prefix(6).enumerated()), id: \.element.id) { item in
                HStack(spacing: 10) {
                    Text("\(item.offset + 1)").font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(MK8Theme.secondary).frame(width: 18)
                    VPThumbnail(youtubeID: item.element.youtubeID, symbol: "clock", color: MK8Theme.secondary, width: 56)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.element.title).font(.subheadline).lineLimit(1)
                        Text(item.element.channel ?? "Queued").font(.caption).foregroundStyle(MK8Theme.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Menu {
                        Button("Remove from queue", systemImage: "trash", role: .destructive) { host.remove(item.element.id) }
                    } label: {
                        Image(systemName: "ellipsis").padding(8)
                    }
                    .accessibilityLabel("Queue actions")
                }
            }
            if videos.count > 6 {
                Text("+ \(videos.count - 6) more in Library").font(.caption).foregroundStyle(MK8Theme.secondary)
            }
        }
    }
}

private struct VPAttentionCard: View {
    let videos: [LibraryVideo]
    @ObservedObject var host: HostModel
    @Binding var selection: VPTab
    var body: some View {
        HostCard {
            Label("\(videos.count) \(videos.count == 1 ? "video needs" : "videos need") attention",
                  systemImage: "exclamationmark.triangle.fill")
                .font(.headline).foregroundStyle(MK8Theme.warning)
            ForEach(videos.prefix(3)) { video in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(video.title).font(.subheadline).lineLimit(1)
                        Text(video.message ?? (video.state == "paused" ? "Paused" : "Failed"))
                            .font(.caption).foregroundStyle(MK8Theme.secondary).lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    Button(video.state == "paused" ? "Resume" : "Retry") { host.retry(video.id) }
                        .buttonStyle(.bordered).disabled(host.busy)
                }
            }
            Button("Open Library") { selection = .library }.font(.subheadline)
        }
    }
}

struct VPRate: View {
    let title: String
    let value: Double
    let symbol: String
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(title, systemImage: symbol).font(.caption).foregroundStyle(color)
            Text(value.formatted(.number.precision(.fractionLength(2))))
                .font(.system(size: 26, weight: .semibold, design: .rounded)).monospacedDigit()
        }.accessibilityElement(children: .combine)
    }
}

struct VPChargingView: View {
    @ObservedObject var host: HostModel
    @Environment(\.dismiss) private var dismiss
    @State private var previousBrightness: CGFloat?
    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            VPMark(size: 100).accessibilityHidden(true)
            Text(host.activeStreams > 0 ? "Playing in your Tesla" : (host.running ? "Ready for your Tesla" : "Preparing video"))
                .font(.title2.weight(.medium))
            StatusPill(title: host.tunnelState.title, color: host.tunnelState == .connected ? MK8Theme.good : MK8Theme.warning)
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
        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity).background(MK8Theme.background).foregroundStyle(MK8Theme.accent)
            .onAppear { previousBrightness = UIScreen.main.brightness; UIScreen.main.brightness = min(UIScreen.main.brightness, 0.08) }
            .onDisappear { if let previousBrightness { UIScreen.main.brightness = previousBrightness } }
    }
}
