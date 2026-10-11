import SwiftUI
import UIKit
import MK8Core

@main struct MK8App: App {
    @UIApplicationDelegateAdaptor(MK8AppDelegate.self) private var appDelegate
    @StateObject private var host = HostModel()
    @Environment(\.scenePhase) private var phase
    @AppStorage("appearanceMode") private var appearanceMode = "system"
    var body: some Scene {
        WindowGroup {
            AppRootView(host: host)
            .tint(MK8Theme.accent)
            .preferredColorScheme(appearanceMode == "dark" ? .dark : appearanceMode == "light" ? .light : nil)
            .onChange(of: phase) { _, value in
                if value == .inactive { host.preparingToBackground() }
                if value == .background { host.backgrounded() }
                if value == .active { host.foregrounded() }
            }
        }
    }
}

/// The four top-level areas of the app, shown as a tab bar.
enum VPTab: String, Hashable {
    case home, library, diagnostics, settings
}

private struct AppRootView: View {
    @ObservedObject var host: HostModel
    @SceneStorage("selectedTab") private var tabValue = VPTab.home.rawValue
    private var selection: Binding<VPTab> {
        Binding(get: { VPTab(rawValue: tabValue) ?? .home }, set: { tabValue = $0.rawValue })
    }
    private var libraryBadge: Int {
        host.videos.filter { $0.state == "preparing" || $0.state == "failed" }.count
    }
    var body: some View {
        TabView(selection: selection) {
            NavigationStack { VPDashboardScreen(host: host, selection: selection) }
                .tabItem { Label("Home", systemImage: "house.fill") }
                .tag(VPTab.home)
            NavigationStack { VPLibraryScreen(host: host) }
                .tabItem { Label("Library", systemImage: "rectangle.stack.fill") }
                .badge(libraryBadge)
                .tag(VPTab.library)
            NavigationStack { VPDiagnosticsScreen(host: host) }
                .tabItem { Label("Diagnostics", systemImage: "waveform.path.ecg") }
                .tag(VPTab.diagnostics)
            NavigationStack { VPSettingsScreen(host: host) }
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(VPTab.settings)
        }
        .modifier(PiPPlayerPresentation(playback: host.pipPlayback))
    }
}

// MARK: - Theme

enum MK8Theme {
    private static func adaptive(_ light: UIColor, _ dark: UIColor) -> Color {
        Color(uiColor: UIColor { traits in traits.userInterfaceStyle == .dark ? dark : light })
    }
    // Softened palette (Build 48): no pure white surfaces in light mode and no
    // near-black background or near-white accent in dark mode, so text and
    // buttons read clearly without glare.
    static let background = adaptive(UIColor(red: 0.895, green: 0.91, blue: 0.92, alpha: 1), UIColor(red: 0.085, green: 0.10, blue: 0.115, alpha: 1))
    static let card = adaptive(UIColor(red: 0.95, green: 0.955, blue: 0.96, alpha: 1), UIColor(red: 0.13, green: 0.15, blue: 0.17, alpha: 1))
    static let cardRaised = adaptive(UIColor(red: 0.965, green: 0.97, blue: 0.975, alpha: 1), UIColor(red: 0.155, green: 0.175, blue: 0.195, alpha: 1))
    static let accent = adaptive(UIColor(red: 0.27, green: 0.36, blue: 0.43, alpha: 1), UIColor(red: 0.60, green: 0.70, blue: 0.78, alpha: 1))
    static let accentDeep = adaptive(UIColor(red: 0.19, green: 0.26, blue: 0.32, alpha: 1), UIColor(red: 0.21, green: 0.27, blue: 0.32, alpha: 1))
    static let secondary = adaptive(UIColor(red: 0.40, green: 0.45, blue: 0.50, alpha: 1), UIColor(red: 0.60, green: 0.66, blue: 0.70, alpha: 1))
    static let steel = adaptive(UIColor(red: 0.66, green: 0.72, blue: 0.76, alpha: 1), UIColor(red: 0.32, green: 0.40, blue: 0.46, alpha: 1))
    static let blue = adaptive(UIColor(red: 0.45, green: 0.61, blue: 0.75, alpha: 1), UIColor(red: 0.52, green: 0.68, blue: 0.81, alpha: 1))
    // Muted status colours that match the soft palette.
    static let good = adaptive(UIColor(red: 0.20, green: 0.55, blue: 0.36, alpha: 1), UIColor(red: 0.45, green: 0.78, blue: 0.56, alpha: 1))
    static let warning = adaptive(UIColor(red: 0.72, green: 0.47, blue: 0.12, alpha: 1), UIColor(red: 0.92, green: 0.70, blue: 0.38, alpha: 1))
    static let bad = adaptive(UIColor(red: 0.72, green: 0.24, blue: 0.24, alpha: 1), UIColor(red: 0.93, green: 0.48, blue: 0.46, alpha: 1))
}

extension View {
    /// Form/List screens: soft themed background instead of the stock grey.
    func vpFormBackground() -> some View {
        scrollContentBackground(.hidden)
            .background(MK8Theme.background.ignoresSafeArea())
    }
}

// MARK: - Shared building blocks

struct HostScreen<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) { content }
                .padding(.horizontal, 16).padding(.vertical, 12)
        }
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .background(
            LinearGradient(colors: [MK8Theme.cardRaised, MK8Theme.background], startPoint: .topLeading, endPoint: .bottomTrailing)
                .ignoresSafeArea()
        )
    }
}

struct HostCard<Content: View>: View {
    let content: Content
    init(@ViewBuilder content: () -> Content) { self.content = content() }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(18)
            .background(
                LinearGradient(colors: [MK8Theme.cardRaised, MK8Theme.card], startPoint: .topLeading, endPoint: .bottomTrailing),
                in: RoundedRectangle(cornerRadius: 20)
            )
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(Color.black.opacity(0.07), lineWidth: 1))
            .shadow(color: .black.opacity(0.08), radius: 10, y: 6)
    }
}

/// Small uppercase heading used above groups of cards.
struct VPSectionHeader: View {
    let title: String
    var trailing: String? = nil
    var body: some View {
        HStack {
            Text(title.uppercased()).font(.caption.weight(.semibold)).tracking(1)
            Spacer()
            if let trailing { Text(trailing).font(.caption.monospacedDigit()) }
        }
        .foregroundStyle(MK8Theme.secondary)
        .padding(.horizontal, 4)
        .padding(.top, 4)
    }
}

struct StatusPill: View {
    let title: String
    let color: Color
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(title).font(.caption.weight(.semibold))
        }.foregroundStyle(color).padding(.horizontal, 10).padding(.vertical, 6)
            .background(color.opacity(0.13), in: Capsule())
    }
}

/// One labelled value in a diagnostics list: title on the left, value right.
struct VPStatRow: View {
    let title: String
    let value: String
    var color: Color? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(title).font(.subheadline).foregroundStyle(MK8Theme.secondary)
            Spacer(minLength: 8)
            Text(value).font(.subheadline.weight(.medium).monospacedDigit())
                .foregroundStyle(color ?? Color.primary)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}

struct VPMark: View {
    var size: CGFloat = 56
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22)
                .fill(LinearGradient(colors: [MK8Theme.accent, MK8Theme.accentDeep], startPoint: .topLeading, endPoint: .bottomTrailing))
            RoundedRectangle(cornerRadius: size * 0.22)
                .stroke(MK8Theme.steel.opacity(0.65), lineWidth: 1)
            VStack(spacing: size * 0.06) {
                RoundedRectangle(cornerRadius: size * 0.07)
                    .fill(Color.white.opacity(0.13))
                    .overlay {
                        Image(systemName: "play.fill")
                            .font(.system(size: size * 0.22, weight: .bold))
                            .foregroundStyle(.white)
                    }
                    .frame(width: size * 0.68, height: size * 0.43)
                Capsule().fill(MK8Theme.steel.opacity(0.9)).frame(width: size * 0.44, height: 2)
            }
        }
        .frame(width: size, height: size)
        .shadow(color: MK8Theme.accent.opacity(0.18), radius: 10, y: 5)
    }
}

struct CopyButton: View {
    let value: String
    @State private var copied = false
    var body: some View {
        Button {
            UIPasteboard.general.string = value
            copied = true
            Task { try? await Task.sleep(nanoseconds: 2_000_000_000); copied = false }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc").frame(width: 30, height: 30)
        }.buttonStyle(.bordered).accessibilityLabel(copied ? "Copied" : "Copy " + value)
    }
}

/// YouTube thumbnail, or a state symbol for imports and while loading.
struct VPThumbnail: View {
    let youtubeID: String?
    let symbol: String
    let color: Color
    var width: CGFloat = 96
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 9).fill(MK8Theme.background)
            if let id = youtubeID, let url = URL(string: "https://i.ytimg.com/vi/\(id)/mqdefault.jpg") {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Image(systemName: symbol).font(.title3).foregroundStyle(color)
                }
            } else {
                Image(systemName: symbol).font(.title3).foregroundStyle(color)
            }
        }
        .frame(width: width, height: width * 9 / 16)
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .accessibilityHidden(true)
    }
}

// MARK: - Formatting

enum VPFormat {
    static func bytes(_ value: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: value, countStyle: .file)
    }

    /// 1:05 or 1:02:03.
    static func clock(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "–" }
        let total = Int(seconds.rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let rest = total % 60
        if hours > 0 { return String(format: "%d:%02d:%02d", hours, minutes, rest) }
        return String(format: "%d:%02d", minutes, rest)
    }

    /// A stage time such as "4.2 s" or "1:05".
    static func seconds(_ value: Double?) -> String {
        guard let value, value.isFinite, value >= 0 else { return "–" }
        if value < 10 { return String(format: "%.1f s", value) }
        if value < 90 { return String(format: "%.0f s", value) }
        return clock(value)
    }

    static func eta(_ seconds: Double?) -> String? {
        guard let seconds, seconds.isFinite, seconds > 0 else { return nil }
        if seconds < 60 { return "\(max(1, Int(seconds))) s left" }
        if seconds < 3600 { return "\(Int((seconds / 60).rounded(.up))) min left" }
        return String(format: "%.1f h left", seconds / 3600)
    }

    static func mbps(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "–" }
        return String(format: value < 10 ? "%.2f Mb/s" : "%.1f Mb/s", value)
    }

    static func milliseconds(_ value: Double?) -> String {
        guard let value, value.isFinite else { return "–" }
        return String(format: "%.0f ms", value)
    }

    /// "Mar 4" style date for an ISO 8601 YouTube release date, if parseable.
    static func releaseDate(_ iso: String?) -> String? {
        guard let iso, !iso.isEmpty else { return nil }
        let formatter = ISO8601DateFormatter()
        var date = formatter.date(from: iso)
        if date == nil {
            formatter.formatOptions = [.withFullDate]
            date = formatter.date(from: String(iso.prefix(10)))
        }
        guard let date else { return nil }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

// MARK: - Shared state helpers

extension MediaPreparationProgress.Stage {
    var vpTitle: String {
        switch self {
        case .resolving: return "Finding video"
        case .importing: return "Importing"
        case .downloading: return "Downloading"
        case .waitingForApp: return "Waiting for iOS"
        case .processing: return "Converting"
        case .finalizing: return "Adding to library"
        }
    }
    var vpSymbol: String {
        switch self {
        case .resolving: return "magnifyingglass"
        case .importing: return "square.and.arrow.down"
        case .downloading: return "arrow.down.circle"
        case .waitingForApp: return "pause.circle"
        case .processing: return "gearshape.2"
        case .finalizing: return "checkmark.circle"
        }
    }
}

extension LibraryVideo {
    var vpStateColor: Color {
        switch state {
        case "ready": return MK8Theme.good
        case "failed": return MK8Theme.bad
        case "paused": return MK8Theme.warning
        default: return MK8Theme.accent
        }
    }
    var vpStateSymbol: String {
        switch state {
        case "ready": return "play.circle.fill"
        case "failed": return "exclamationmark.triangle.fill"
        case "paused": return "pause.circle.fill"
        default: return "clock"
        }
    }
    var vpNeedsAttention: Bool { state == "failed" || state == "paused" }
}

extension TunnelConnectionState {
    var vpColor: Color {
        switch self {
        case .connected: return MK8Theme.good
        case .failed: return MK8Theme.bad
        case .connecting, .reconnecting: return MK8Theme.warning
        case .notConfigured, .disconnected: return MK8Theme.secondary
        }
    }
}
