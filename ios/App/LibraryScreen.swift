import SwiftUI
import UIKit
import UniformTypeIdentifiers
import MK8Core

private enum VPLibraryFilter: String, CaseIterable, Identifiable {
    case all, ready, preparing, attention
    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: return "All"
        case .ready: return "Ready"
        case .preparing: return "Preparing"
        case .attention: return "Issues"
        }
    }
}

private struct VPChannelGroup: Identifiable {
    let id: String
    let name: String
    let channelId: String?
    let videos: [LibraryVideo]
}

/// Library tab: add videos, browse by channel, delete, retry and inspect.
struct VPLibraryScreen: View {
    @ObservedObject var host: HostModel
    @AppStorage("libraryGroupByChannel") private var groupByChannel = true
    @State private var filter: VPLibraryFilter = .all
    @State private var search = ""
    @State private var youtubeURL = ""
    @State private var importing = false
    @State private var sizes: [UUID: Int64] = [:]
    @State private var librarySize: Int64 = 0
    @State private var confirmRemoveFailed = false
    @Environment(\.openURL) private var openURL

    private var failedCount: Int { host.videos.filter { $0.state == "failed" }.count }
    private var sizeKey: String {
        "\(host.videos.count)-\(host.videos.filter { $0.state == "ready" }.count)"
    }

    private func matches(_ video: LibraryVideo) -> Bool {
        switch filter {
        case .all: break
        case .ready: if video.state != "ready" { return false }
        case .preparing: if video.state != "preparing" && video.state != "importing" { return false }
        case .attention: if !video.vpNeedsAttention { return false }
        }
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if query.isEmpty { return true }
        return video.title.lowercased().contains(query) || (video.channel ?? "").lowercased().contains(query)
    }

    private var groups: [VPChannelGroup] {
        let videos = host.videos.filter { matches($0) }
        if videos.isEmpty { return [] }
        guard groupByChannel else {
            return [VPChannelGroup(id: "recent", name: "Most recent", channelId: nil, videos: videos)]
        }
        var order: [String] = []
        var buckets: [String: [LibraryVideo]] = [:]
        for video in videos {
            let trimmed = (video.channel ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let name = trimmed.isEmpty ? (video.youtubeID == nil ? "Imported files" : "Other videos") : trimmed
            if buckets[name] == nil { order.append(name) }
            buckets[name, default: []].append(video)
        }
        return order.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }.map { name in
            let items = buckets[name] ?? []
            return VPChannelGroup(id: name, name: name, channelId: items.first(where: { $0.channelId != nil })?.channelId, videos: items)
        }
    }

    var body: some View {
        List {
            Section {
                HStack(spacing: 8) {
                    TextField("Paste a YouTube link or ID", text: $youtubeURL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        .submitLabel(.go)
                        .onSubmit { add() }
                    PasteButton(payloadType: String.self) { values in
                        if let value = values.first { youtubeURL = value }
                    }
                    .labelStyle(.iconOnly).buttonBorderShape(.capsule)
                }
                Picker("Quality", selection: $host.mediaQuality) {
                    ForEach(MediaQuality.allCases) { quality in Text(quality.title).tag(quality) }
                }
                .disabled(host.busy)
                Button { add() } label: {
                    Label(host.busy ? "Add to queue" : "Download & prepare", systemImage: "arrow.down.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(youtubeURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button { importing = true } label: {
                    Label("Import from Files", systemImage: "folder").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(host.busy)
            } header: {
                Text("Add a video")
            } footer: {
                Text("Videos you add in the Tesla browser show up here too.")
            }
            .listRowBackground(MK8Theme.card)

            Section {
                Picker("Show", selection: $filter) {
                    ForEach(VPLibraryFilter.allCases) { item in Text(item.title).tag(item) }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            } footer: {
                Text(summary)
            }

            if host.videos.isEmpty {
                ContentUnavailableView("Your library starts here", systemImage: "play.rectangle",
                                       description: Text("Add a YouTube link above or import a video from Files."))
                    .listRowBackground(Color.clear)
            } else if groups.isEmpty {
                ContentUnavailableView("No matching videos", systemImage: "magnifyingglass",
                                       description: Text("Try another filter or search."))
                    .listRowBackground(Color.clear)
            }

            ForEach(groups) { group in
                Section {
                    ForEach(group.videos) { video in
                        row(video)
                    }
                } header: {
                    if groupByChannel {
                        HStack {
                            Text(group.name)
                            Spacer()
                            if let channelId = group.channelId,
                               let url = URL(string: "https://www.youtube.com/channel/" + channelId) {
                                Button { openURL(url) } label: { Image(systemName: "arrow.up.right.square") }
                                    .accessibilityLabel("Open \(group.name) on YouTube")
                            }
                            Text("\(group.videos.count)").monospacedDigit()
                        }
                    }
                }
                .listRowBackground(MK8Theme.card)
            }
        }
        .listStyle(.insetGrouped)
        .vpFormBackground()
        .searchable(text: $search, prompt: "Search titles or channels")
        .navigationTitle("Library")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Group", selection: $groupByChannel) {
                        Label("By channel", systemImage: "person.2").tag(true)
                        Label("Most recent", systemImage: "clock").tag(false)
                    }
                    if failedCount > 0 {
                        Button("Remove \(failedCount) failed", systemImage: "trash", role: .destructive) {
                            confirmRemoveFailed = true
                        }
                    }
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                }
                .accessibilityLabel("Library options")
            }
        }
        .confirmationDialog("Remove \(failedCount) failed \(failedCount == 1 ? "video" : "videos")?",
                            isPresented: $confirmRemoveFailed, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                for video in host.videos where video.state == "failed" { host.remove(video.id) }
            }
        } message: {
            Text("Saved partial downloads for these videos are deleted too.")
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.movie, UTType(filenameExtension: "ts") ?? .data]) { result in
            switch result {
            case .success(let url): host.importVideo(url)
            case .failure(let error): host.message = error.localizedDescription
            }
        }
        .task(id: sizeKey) { await refreshSizes() }
    }

    private var summary: String {
        let ready = host.videos.filter { $0.state == "ready" }.count
        var parts = ["\(ready) ready"]
        if host.queuedCount > 0 || host.busy { parts.append("\(host.queuedCount + (host.busy ? 1 : 0)) preparing") }
        if failedCount > 0 { parts.append("\(failedCount) failed") }
        if librarySize > 0 { parts.append(VPFormat.bytes(librarySize) + " on iPhone") }
        return parts.joined(separator: " · ")
    }

    private func add() {
        let value = youtubeURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        host.addYouTube(value)
        youtubeURL = ""
    }

    private func refreshSizes() async {
        let report = await VPStorage.measure()
        sizes = report.videoSizes
        librarySize = report.library
    }

    private func row(_ video: LibraryVideo) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            VPVideoRow(video: video, size: sizes[video.id],
                       preparing: host.preparingID == video.id ? host.preparation : nil,
                       showChannel: !groupByChannel)
            if video.vpNeedsAttention { recoveryButtons(video) }
        }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button(role: .destructive) { host.remove(video.id) } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
            .swipeActions(edge: .leading) {
                if video.vpNeedsAttention {
                    Button { host.retry(video.id) } label: {
                        Label(video.state == "paused" ? "Resume" : "Retry", systemImage: "arrow.clockwise")
                    }
                    .tint(MK8Theme.accent)
                }
            }
            .contextMenu {
                if let id = video.youtubeID {
                    Button("Copy YouTube link", systemImage: "link") { UIPasteboard.general.string = "https://youtu.be/" + id }
                    if let url = URL(string: "https://www.youtube.com/watch?v=" + id) {
                        Button("Open on YouTube", systemImage: "play.rectangle") { openURL(url) }
                    }
                }
                if video.vpNeedsAttention {
                    Button(video.state == "paused" ? "Resume" : "Retry", systemImage: "arrow.clockwise") { host.retry(video.id) }
                        .disabled(host.busy)
                    if let file = host.diagnostics(for: video.id) {
                        ShareLink(item: file) { Label("Share error details", systemImage: "square.and.arrow.up") }
                    }
                }
                Divider()
                Button(host.preparingID == video.id ? "Cancel and delete" : "Delete video", systemImage: "trash", role: .destructive) {
                    host.remove(video.id)
                }
            }
    }

    private func recoveryButtons(_ video: LibraryVideo) -> some View {
            HStack(spacing: 10) {
                Button(video.state == "paused" ? "Resume" : "Retry", systemImage: "arrow.clockwise") { host.retry(video.id) }
                    .buttonStyle(.borderedProminent).disabled(host.busy)
                if let file = host.diagnostics(for: video.id) {
                    ShareLink(item: file) { Label("Details", systemImage: "square.and.arrow.up") }
                        .buttonStyle(.bordered)
                }
                Spacer(minLength: 0)
                if host.busy {
                    Text("Available when the current video finishes").font(.caption2).foregroundStyle(MK8Theme.secondary)
                }
            }
            .font(.caption)
    }
}

private struct VPVideoRow: View {
    let video: LibraryVideo
    let size: Int64?
    let preparing: MediaPreparationProgress?
    let showChannel: Bool
    private var subtitle: String {
        var parts: [String] = []
        if showChannel, let channel = video.channel, !channel.isEmpty { parts.append(channel) }
        if let duration = video.duration { parts.append(VPFormat.clock(duration)) }
        if let date = VPFormat.releaseDate(video.publishedAt) { parts.append(date) }
        if video.state == "ready", let size, size > 0 { parts.append(VPFormat.bytes(size)) }
        return parts.joined(separator: " · ")
    }
    private var status: String {
        if let preparing {
            return preparing.stage.vpTitle + (preparing.fraction.map { " · \(Int($0 * 100))%" } ?? "")
        }
        switch video.state {
        case "ready": return "Ready to play"
        case "preparing": return "Queued"
        case "importing": return "Importing…"
        default: return video.message ?? video.state.capitalized
        }
    }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VPThumbnail(youtubeID: video.youtubeID, symbol: video.vpStateSymbol, color: video.vpStateColor, width: 92)
            VStack(alignment: .leading, spacing: 3) {
                Text(video.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                if !subtitle.isEmpty {
                    Text(subtitle).font(.caption).foregroundStyle(MK8Theme.secondary).lineLimit(1)
                }
                Label(status, systemImage: video.vpStateSymbol)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(video.vpStateColor)
                    .lineLimit(video.vpNeedsAttention ? 3 : 1)
                if let fraction = preparing?.fraction {
                    ProgressView(value: fraction).tint(MK8Theme.accent)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}
