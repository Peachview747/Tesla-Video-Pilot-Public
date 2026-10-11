import SwiftUI
import UIKit
import Charts
import MK8Core

/// Diagnostics tab: live connection, traffic, preparation timing, device
/// state and the exportable session log.
struct VPDiagnosticsScreen: View {
    @ObservedObject var host: HostModel
    @ObservedObject private var diagnostics = SessionDiagnostics.shared
    @ObservedObject private var background = BackgroundPreparation.shared
    @ObservedObject private var keepalive = SilentAudioKeepAlive.shared

    var body: some View {
        HostScreen {
            VPSectionHeader(title: "Connection")
            connectionCard
            VPSectionHeader(title: "Traffic")
            VPTrafficCard(host: host)
            VPSectionHeader(title: "Video preparation")
            preparationCard
            VPSectionHeader(title: "iPhone")
            deviceCard
            VPSectionHeader(title: "Session log")
            logCard
        }
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: Connection

    private var connectionCard: some View {
        HostCard {
            VPStatRow(title: "Hosting", value: host.running ? "On" : (host.authorizingHost ? "Authorizing" : "Off"),
                      color: host.running ? MK8Theme.good : MK8Theme.secondary)
            VPStatRow(title: "Tesla streams", value: "\(host.activeStreams)",
                      color: host.activeStreams > 0 ? MK8Theme.good : nil)
            Divider()
            VPStatRow(title: "Cloudflare tunnel", value: host.running ? host.tunnelState.title : "Off",
                      color: host.running ? host.tunnelState.vpColor : MK8Theme.secondary)
            VPStatRow(title: "Tunnel round trip", value: rttText, color: rttColor)
            if let probe = diagnostics.workerProbeMs {
                VPStatRow(title: "Worker HTTPS probe", value: VPFormat.milliseconds(probe))
            }
            if let mbps = diagnostics.lastStreamMbps {
                VPStatRow(title: "Last video delivery", value: VPFormat.mbps(mbps)
                          + (diagnostics.lastStreamBytes.map { " · " + VPFormat.bytes($0) } ?? ""))
                if let route = diagnostics.lastStreamRoute, let at = diagnostics.lastStreamAt {
                    HStack {
                        Text(route)
                        Spacer()
                        Text(at, style: .relative) + Text(" ago")
                    }
                    .font(.caption).foregroundStyle(MK8Theme.secondary)
                }
            }
            Divider()
            VPStatRow(title: "iPhone network", value: host.phoneConnection.name,
                      color: host.phoneConnection.state == .online ? MK8Theme.good : MK8Theme.warning)
            if host.phoneConnection.lowDataMode {
                VPStatRow(title: "Low Data Mode", value: "On", color: MK8Theme.warning)
            }
            if host.phoneConnection.expensive {
                VPStatRow(title: "Metered connection", value: "Yes")
            }
            if !host.localURLs.isEmpty {
                VPStatRow(title: "Local addresses", value: host.localURLs.joined(separator: "\n"))
            }
            if !host.tunnelMessage.isEmpty {
                Text(host.tunnelMessage).font(.caption).foregroundStyle(MK8Theme.secondary).textSelection(.enabled)
            }
            if host.running && host.tunnelEnabled && host.tunnelState != .notConfigured {
                Button("Reconnect tunnel", systemImage: "arrow.clockwise") { host.connectTunnel() }
                    .buttonStyle(.bordered).disabled(host.tunnelState.animating)
            }
        }
    }

    private var rttText: String {
        guard host.running, host.tunnelState == .connected else { return "–" }
        guard let rtt = diagnostics.tunnelRTTMs else { return "Measuring…" }
        return VPFormat.milliseconds(rtt)
    }

    private var rttColor: Color? {
        guard host.running, host.tunnelState == .connected, let rtt = diagnostics.tunnelRTTMs else { return nil }
        if rtt < 120 { return MK8Theme.good }
        return rtt < 300 ? MK8Theme.warning : MK8Theme.bad
    }

    // MARK: Preparation

    private var preparationCard: some View {
        HostCard {
            if let progress = host.preparation {
                VPStatRow(title: "Now", value: progress.stage.vpTitle + (progress.fraction.map { " · \(Int($0 * 100))%" } ?? ""),
                          color: MK8Theme.accent)
                Text(host.preparingTitle).font(.caption).foregroundStyle(MK8Theme.secondary).lineLimit(2)
                if progress.stage == .downloading {
                    VPStatRow(title: "Download speed", value: VPFormat.mbps(progress.bytesPerSecond * 8 / 1_000_000))
                }
                if let speed = progress.processingSpeed {
                    VPStatRow(title: "Conversion speed", value: String(format: "%.1f× real time", speed))
                }
                if let eta = VPFormat.eta(progress.secondsRemaining) {
                    VPStatRow(title: "Remaining", value: eta)
                }
            } else {
                VPStatRow(title: "Now", value: host.queuedCount > 0 ? "\(host.queuedCount) waiting" : "Idle")
            }
            VPStatRow(title: "Background task", value: background.isRunning ? "Active" : "Not running",
                      color: background.isRunning ? MK8Theme.good : nil)
            Text(background.status).font(.caption).foregroundStyle(MK8Theme.secondary)
            Divider()
            // PreparationStats is a plain static, so poll it while visible.
            TimelineView(.periodic(from: .now, by: 2)) { context in
                VPLastPreparationView(tick: context.date)
            }
        }
    }

    // MARK: Device

    private var deviceCard: some View {
        HostCard {
            TimelineView(.periodic(from: .now, by: 5)) { context in
                VPDeviceStats(tick: context.date)
            }
            Divider()
            VPStatRow(title: "Extra background time", value: host.backgroundTimeActive ? "Active" : "Idle")
            VPStatRow(title: "Silent keepalive", value: keepalive.isActive ? "Active" : "Off",
                      color: keepalive.isActive ? MK8Theme.good : nil)
            Text(keepalive.status).font(.caption).foregroundStyle(MK8Theme.secondary)
        }
        .onAppear { UIDevice.current.isBatteryMonitoringEnabled = true }
    }

    // MARK: Log

    private var logCard: some View {
        HostCard {
            Toggle("Capture diagnostic events", isOn: Binding(
                get: { diagnostics.enabled },
                set: { host.setDiagnosticsEnabled($0) }
            ))
            HStack {
                Text("\(diagnostics.eventCount) events")
                Spacer()
                if let last = diagnostics.lastEventAt {
                    Text("last ") + Text(last, style: .relative) + Text(" ago")
                }
            }
            .font(.caption.monospacedDigit()).foregroundStyle(MK8Theme.secondary)
            HStack {
                if diagnostics.eventCount > 0 {
                    // Share the live journal rather than building a new
                    // multi-megabyte snapshot on every redraw.
                    ShareLink(item: diagnostics.logURL) { Label("Export log", systemImage: "square.and.arrow.up") }
                        .buttonStyle(.borderedProminent)
                } else {
                    Label("No events yet", systemImage: "doc.text.magnifyingglass")
                        .font(.footnote).foregroundStyle(MK8Theme.secondary)
                }
                Spacer()
                Button("Clear", systemImage: "trash", role: .destructive) { host.clearDiagnostics() }
                    .buttonStyle(.bordered).disabled(diagnostics.eventCount == 0)
            }
            Text("Records redacted timing, tunnel round trips, Tesla browser playback events, byte counts and errors, including the pipeline/prepared, tunnel/streamSummary and http/streamSummary timings. Never video data, keys, cookies, tokens or full URLs.")
                .font(.caption).foregroundStyle(MK8Theme.secondary)
        }
    }
}

/// Where the time went for the most recent finished preparation.
private struct VPLastPreparationView: View {
    /// Changes on every timeline tick so the body re-reads the stats.
    let tick: Date
    private var timings: PreparationTimings? { PreparationStats.last }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Last finished video").font(.subheadline.weight(.semibold))
                Spacer()
                if let timings {
                    Text(timings.finishedAt, style: .relative).font(.caption).foregroundStyle(MK8Theme.secondary)
                }
            }
            if let timings {
                VPTimingBar(timings: timings)
                VPStatRow(title: "Total", value: VPFormat.seconds(timings.totalSeconds))
                VPStatRow(title: "Download", value: VPFormat.seconds(timings.downloadSeconds)
                          + (timings.downloadMbps.map { " · " + VPFormat.mbps($0) } ?? ""))
                if timings.downloadedBytes > 0 {
                    VPStatRow(title: "Downloaded", value: VPFormat.bytes(timings.downloadedBytes))
                }
                if timings.waitSeconds >= 0.5 {
                    VPStatRow(title: "Waiting for iOS", value: VPFormat.seconds(timings.waitSeconds), color: MK8Theme.warning)
                }
                VPStatRow(title: "Conversion", value: VPFormat.seconds(timings.processingSeconds)
                          + (timings.processingSpeed.map { String(format: " · %.1f×", $0) } ?? ""))
                VPStatRow(title: "Encoder", value: encoderText)
                if let fallback = timings.fallbackSeconds, fallback > 0 {
                    VPStatRow(title: "Lost to retries", value: VPFormat.seconds(fallback), color: MK8Theme.warning)
                }
                VPStatRow(title: "Seek index", value: VPFormat.seconds(timings.indexSeconds))
                if let media = timings.mediaSeconds {
                    VPStatRow(title: "Video length", value: VPFormat.clock(media))
                }
                if timings.outputBytes > 0 {
                    VPStatRow(title: "Output", value: VPFormat.bytes(timings.outputBytes)
                              + (timings.outputKbps.map { String(format: " · %.0f kb/s", $0) } ?? ""))
                }
                VPStatRow(title: "Quality setting", value: "\(timings.quality)p")
            } else {
                Text("Timings appear here after the next video finishes preparing.")
                    .font(.caption).foregroundStyle(MK8Theme.secondary)
            }
        }
    }

    private var encoderText: String {
        let slices = timings?.segments ?? 1
        let decode: String
        switch timings?.hardwareDecode {
        case .some(true): decode = "hardware decode"
        case .some(false): decode = "CPU decode"
        case .none: decode = "decode unknown"
        }
        return (slices > 1 ? "\(slices) parallel slices" : "single pass") + " · " + decode
    }
}

/// Proportional bar: download, waiting, conversion, indexing.
private struct VPTimingBar: View {
    let timings: PreparationTimings
    private var parts: [(String, Double, Color)] {
        [("Download", timings.downloadSeconds ?? 0, MK8Theme.blue),
         ("Wait", timings.waitSeconds, MK8Theme.warning),
         ("Convert", timings.processingSeconds ?? 0, MK8Theme.accent),
         ("Index", timings.indexSeconds, MK8Theme.steel)]
            .filter { $0.1 > 0 && $0.1.isFinite }
    }
    var body: some View {
        let items = parts
        let total = max(0.001, items.reduce(0.0) { $0 + $1.1 })
        VStack(alignment: .leading, spacing: 6) {
            GeometryReader { proxy in
                HStack(spacing: 2) {
                    ForEach(items.indices, id: \.self) { index in
                        Rectangle().fill(items[index].2)
                            .frame(width: max(2, (proxy.size.width - CGFloat(items.count) * 2) * CGFloat(items[index].1 / total)))
                    }
                }
            }
            .frame(height: 10)
            .clipShape(Capsule())
            HStack(spacing: 10) {
                ForEach(items.indices, id: \.self) { index in
                    HStack(spacing: 4) {
                        Circle().fill(items[index].2).frame(width: 7, height: 7)
                        Text(items[index].0)
                    }
                }
            }
            .font(.caption2).foregroundStyle(MK8Theme.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Time split: " + items.map { "\($0.0) \(VPFormat.seconds($0.1))" }.joined(separator: ", "))
    }
}

private struct VPDeviceStats: View {
    /// Changes on every timeline tick so the body re-reads device state.
    let tick: Date
    private var thermal: (String, Color) {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: return ("Normal", MK8Theme.good)
        case .fair: return ("Warm", MK8Theme.good)
        case .serious: return ("Hot · iOS slows conversion", MK8Theme.warning)
        case .critical: return ("Critical · iOS throttles hard", MK8Theme.bad)
        @unknown default: return ("Unknown", MK8Theme.secondary)
        }
    }
    private var battery: String {
        let device = UIDevice.current
        let level = device.batteryLevel
        let percent = level >= 0 ? "\(Int((level * 100).rounded()))%" : "Unknown"
        switch device.batteryState {
        case .charging: return percent + " · charging"
        case .full: return percent + " · full"
        case .unplugged: return percent
        case .unknown: return percent
        @unknown default: return percent
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let thermalState = thermal
            VPStatRow(title: "Temperature", value: thermalState.0, color: thermalState.1)
            VPStatRow(title: "Low Power Mode", value: ProcessInfo.processInfo.isLowPowerModeEnabled ? "On · slower" : "Off",
                      color: ProcessInfo.processInfo.isLowPowerModeEnabled ? MK8Theme.warning : nil)
            VPStatRow(title: "Battery", value: battery)
            VPStatRow(title: "CPU cores", value: "\(ProcessInfo.processInfo.activeProcessorCount)")
        }
    }
}

/// Live phone traffic, last 30 seconds.
struct VPTrafficCard: View {
    @ObservedObject var host: HostModel
    private var samples: [TransferSample] {
        host.trafficHistory.filter { $0.timestamp >= host.traffic.timestamp - 29 && $0.timestamp <= host.traffic.timestamp }
    }
    private var ceiling: Double {
        max(1, (samples.map { max($0.downloadMbps, $0.uploadMbps) }.max() ?? 0) * 1.2)
    }
    var body: some View {
        HostCard {
            HStack(spacing: 18) {
                VPRate(title: "Receiving", value: host.traffic.downloadMbps, symbol: "arrow.down", color: MK8Theme.blue)
                VPRate(title: "Sending", value: host.traffic.uploadMbps, symbol: "arrow.up", color: MK8Theme.accent)
                Spacer()
                Text("Mb/s").font(.caption).foregroundStyle(MK8Theme.secondary)
            }
            Chart(samples) { sample in
                LineMark(x: .value("Time", sample.timestamp), y: .value("Speed", sample.downloadMbps))
                    .foregroundStyle(by: .value("Direction", "Receiving")).interpolationMethod(.linear)
                LineMark(x: .value("Time", sample.timestamp), y: .value("Speed", sample.uploadMbps))
                    .foregroundStyle(by: .value("Direction", "Sending")).interpolationMethod(.linear)
            }
            .chartForegroundStyleScale(["Receiving": MK8Theme.blue, "Sending": MK8Theme.accent])
            .chartLegend(.hidden).chartXAxis(.hidden)
            .chartYAxis { AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) }
            .chartYScale(domain: 0...ceiling)
            .chartXScale(domain: (host.traffic.timestamp - 29)...host.traffic.timestamp)
            .chartPlotStyle { plot in plot.clipped() }
            .frame(height: 90).accessibilityLabel("Receiving and sending traffic over the last thirty seconds")
            HStack {
                Text("↓ " + VPFormat.bytes(host.traffic.totalReceivedBytes))
                Spacer()
                Text("↑ " + VPFormat.bytes(host.traffic.totalSentBytes))
            }.font(.caption.monospacedDigit()).foregroundStyle(MK8Theme.secondary)
            Text("Video Pilot traffic only · totals since launch")
                .font(.caption).foregroundStyle(MK8Theme.secondary)
        }
    }
}
