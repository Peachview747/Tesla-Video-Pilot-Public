import Foundation
import MK8Core

/// Keyless channel pages and "up next" videos through YouTube's InnerTube
/// API (the same endpoints youtube.com uses). Everything here is parsed off
/// the main actor and returned as plain value types.
enum YouTubeBrowse {
    /// One video in a channel page, related list or feed row. Optional
    /// fields are omitted from the JSON when unknown.
    struct Video: Codable {
        /// YouTube video ID; for a local import in "Continue watching" it is
        /// the library UUID instead (then `youtube` is false).
        let id: String
        var title: String
        var channel: String?
        var channelId: String?
        var thumbnail: String?
        /// Display duration such as "12:34" or "1:02:03".
        var duration: String?
        /// Relative age such as "3 days ago".
        var published: String?
        var views: String?
        var youtube: Bool? = nil
        /// Set when this video is already in the phone library.
        var libraryId: String? = nil
        var libraryState: String? = nil
        /// Watch progress from the phone's history (seconds / 0...1).
        var position: Double? = nil
        var progress: Double? = nil
    }
    struct Channel: Codable {
        let id: String
        var name: String
        var handle: String?
        var avatar: String?
        var subscribers: String?
    }
    struct ChannelPage: Codable {
        /// Present on the first page; nil on continuation pages.
        var channel: Channel?
        var videos: [Video]
        var continuation: String?
    }
    /// Owner and related videos of one video (InnerTube `next`).
    struct WatchInfo {
        var channelId: String?
        var channel: String?
        var related: [Video]
    }
    enum Failure: LocalizedError {
        case channelNotFound
        var errorDescription: String? { "That channel could not be found on YouTube." }
    }

    /// `params` for a channel's Videos tab (newest first).
    private static let videosTab = "EgZ2aWRlb3PyBgQKAjoA"

    // MARK: Channel pages

    static func channel(id: String) async throws -> ChannelPage {
        var object = try await YouTubeInnerTube.post("browse", body: ["browseId": id, "params": videosTab])
        var parsed = videos(in: object)
        if parsed.videos.isEmpty {
            // Some channels (topics, music) have no Videos tab; use their home.
            if let fallback = try? await YouTubeInnerTube.post("browse", body: ["browseId": id]) {
                let other = videos(in: fallback)
                if !other.videos.isEmpty { object = fallback; parsed = other }
            }
        }
        guard let header = channelHeader(object, fallbackID: id) else { throw Failure.channelNotFound }
        let filled = parsed.videos.map { video -> Video in
            var copy = video
            if copy.channel == nil { copy.channel = header.name }
            if copy.channelId == nil { copy.channelId = header.id }
            return copy
        }
        return ChannelPage(channel: header, videos: filled, continuation: parsed.continuation)
    }

    static func channelContinuation(_ token: String) async throws -> ChannelPage {
        let object = try await YouTubeInnerTube.post("browse", body: ["continuation": token])
        let parsed = videos(in: object)
        return ChannelPage(channel: nil, videos: parsed.videos, continuation: parsed.continuation)
    }

    /// Resolves "@handle" exactly, otherwise the best channel search match.
    static func resolveChannel(name: String) async throws -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("@"), trimmed.count > 1 {
            if let object = try? await YouTubeInnerTube.post("navigation/resolve_url",
                                                             body: ["url": "https://www.youtube.com/" + trimmed]),
               let endpoint = (object as? [String: Any])?["endpoint"] as? [String: Any],
               let browse = endpoint["browseEndpoint"] as? [String: Any],
               let id = browse["browseId"] as? String, id.hasPrefix("UC") {
                return id
            }
        }
        let object = try await YouTubeInnerTube.post("search", body: ["query": trimmed, "params": "EgIQAg=="])
        var found: [[String: Any]] = []
        collect(object, key: "channelRenderer", into: &found)
        let wanted = trimmed.lowercased()
        var firstMatch: String?
        for renderer in found {
            guard let id = renderer["channelId"] as? String, id.hasPrefix("UC") else { continue }
            if firstMatch == nil { firstMatch = id }
            if let title = YouTubeInnerTube.text(renderer["title"]), title.lowercased() == wanted { return id }
        }
        guard let resolved = firstMatch else { throw Failure.channelNotFound }
        return resolved
    }

    // MARK: Watch info (owner + related)

    static func watchInfo(_ videoID: String) async throws -> WatchInfo {
        let object = try await YouTubeInnerTube.post("next", body: ["videoId": videoID])
        var owners: [[String: Any]] = []
        collect(object, key: "videoOwnerRenderer", into: &owners)
        var channelId: String?
        var channel: String?
        if let owner = owners.first {
            channelId = YouTubeInnerTube.browseID(owner["title"]) ?? firstBrowseID(owner["navigationEndpoint"])
            channel = YouTubeInnerTube.text(owner["title"])
        }
        // Prefer the sidebar so end-screen and overlay cards are not mixed in.
        var scope: Any = object
        if let contents = (object as? [String: Any])?["contents"] as? [String: Any],
           let results = contents["twoColumnWatchNextResults"] as? [String: Any],
           let secondary = results["secondaryResults"] {
            scope = secondary
        }
        var related = videos(in: scope).videos.filter { $0.id != videoID }
        if related.isEmpty { related = videos(in: object).videos.filter { $0.id != videoID } }
        return WatchInfo(channelId: channelId, channel: channel, related: related)
    }

    // MARK: Parsing

    private struct Parsed {
        var videos: [Video]
        var continuation: String?
    }

    private static let rendererKeys: Set<String> = ["lockupViewModel", "videoRenderer", "gridVideoRenderer",
                                                    "compactVideoRenderer"]

    private static func videos(in object: Any) -> Parsed {
        var renderers: [[String: Any]] = []
        var kinds: [String] = []
        var token: String?
        walk(object, renderers: &renderers, kinds: &kinds, token: &token)
        var seen = Set<String>()
        var result: [Video] = []
        for index in renderers.indices {
            let candidate = kinds[index] == "lockupViewModel" ? fromLockup(renderers[index]) : fromRenderer(renderers[index])
            guard let video = candidate, seen.insert(video.id).inserted else { continue }
            result.append(video)
        }
        return Parsed(videos: result, continuation: token)
    }

    private static func walk(_ value: Any, renderers: inout [[String: Any]], kinds: inout [String], token: inout String?) {
        if let dictionary = value as? [String: Any] {
            for key in rendererKeys {
                if let renderer = dictionary[key] as? [String: Any] {
                    renderers.append(renderer)
                    kinds.append(key)
                }
            }
            if token == nil, let item = dictionary["continuationItemRenderer"] as? [String: Any],
               let endpoint = item["continuationEndpoint"] as? [String: Any],
               let command = endpoint["continuationCommand"] as? [String: Any] {
                token = command["token"] as? String
            }
            for (key, child) in dictionary where !rendererKeys.contains(key) {
                walk(child, renderers: &renderers, kinds: &kinds, token: &token)
            }
        } else if let array = value as? [Any] {
            for child in array { walk(child, renderers: &renderers, kinds: &kinds, token: &token) }
        }
    }

    /// The 2025+ `lockupViewModel` layout used by channel grids and the
    /// watch-page sidebar.
    private static func fromLockup(_ lockup: [String: Any]) -> Video? {
        guard let id = lockup["contentId"] as? String, id.count == 11,
              (lockup["contentType"] as? String) == "LOCKUP_CONTENT_TYPE_VIDEO",
              let metadata = (lockup["metadata"] as? [String: Any])?["lockupMetadataViewModel"] as? [String: Any],
              let title = (metadata["title"] as? [String: Any])?["content"] as? String, !title.isEmpty else { return nil }
        // Live streams and premieres have no duration badge and cannot be
        // prepared as a finished file.
        var badges: [String] = []
        collectStrings(lockup["contentImage"] ?? [String: Any](), parent: "thumbnailBadgeViewModel", key: "text", into: &badges)
        guard let duration = badges.first(where: isClock) else { return nil }
        var video = Video(id: id, title: title, channel: nil, channelId: nil,
                          thumbnail: thumbnail(id), duration: duration, published: nil, views: nil)
        let content = (metadata["metadata"] as? [String: Any])?["contentMetadataViewModel"] as? [String: Any]
        let rows = content?["metadataRows"] as? [[String: Any]] ?? []
        for (rowIndex, row) in rows.enumerated() {
            let parts = row["metadataParts"] as? [[String: Any]] ?? []
            for part in parts {
                guard let text = (part["text"] as? [String: Any])?["content"] as? String else { continue }
                let label = part["accessibilityLabel"] as? String
                let lower = (label ?? text).lowercased()
                if lower.contains(" view") || lower.hasSuffix("views") || lower.contains("watching") {
                    if video.views == nil {
                        video.views = text.lowercased().contains("view") ? text : text + " views"
                    }
                } else if lower.contains(" ago") || lower.hasPrefix("streamed") || lower.hasPrefix("premiered") {
                    if video.published == nil { video.published = label ?? text }
                } else if rowIndex == 0, video.channel == nil {
                    let name = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !name.isEmpty { video.channel = name }
                }
            }
        }
        video.channelId = firstBrowseID(metadata["image"]) ?? firstBrowseID(metadata["metadata"])
        return video
    }

    /// The older `videoRenderer` family (search, grids, sidebar).
    private static func fromRenderer(_ renderer: [String: Any]) -> Video? {
        guard let id = renderer["videoId"] as? String, id.count == 11,
              let title = YouTubeInnerTube.text(renderer["title"]), !title.isEmpty else { return nil }
        var length = YouTubeInnerTube.text(renderer["lengthText"])
        if length == nil {
            var badges: [String] = []
            collectStrings(renderer["thumbnailOverlays"] ?? [String: Any](), parent: "thumbnailOverlayTimeStatusRenderer",
                           key: "simpleText", into: &badges)
            length = badges.first(where: isClock)
        }
        guard let duration = length, isClock(duration) else { return nil }
        let byline = renderer["ownerText"] ?? renderer["longBylineText"] ?? renderer["shortBylineText"]
        return Video(id: id, title: title, channel: YouTubeInnerTube.text(byline),
                     channelId: YouTubeInnerTube.browseID(byline), thumbnail: thumbnail(id), duration: duration,
                     published: YouTubeInnerTube.text(renderer["publishedTimeText"]),
                     views: YouTubeInnerTube.text(renderer["shortViewCountText"]) ?? YouTubeInnerTube.text(renderer["viewCountText"]))
    }

    private static func channelHeader(_ object: Any, fallbackID: String) -> Channel? {
        guard let root = object as? [String: Any] else { return nil }
        let metadata = (root["metadata"] as? [String: Any])?["channelMetadataRenderer"] as? [String: Any]
        let id = (metadata?["externalId"] as? String) ?? fallbackID
        var title = metadata?["title"] as? String
        var strings: [String] = []
        if let header = root["header"] { collectStrings(header, parent: nil, key: "content", into: &strings) }
        if title == nil || title?.isEmpty == true {
            if let header = root["header"] as? [String: Any],
               let page = header["pageHeaderRenderer"] as? [String: Any] {
                title = page["pageTitle"] as? String
            }
        }
        guard let name = title, !name.isEmpty else { return nil }
        var handle = strings.first(where: { $0.hasPrefix("@") && !$0.contains(" ") })
        if handle == nil, let vanity = metadata?["vanityChannelUrl"] as? String,
           let last = vanity.split(separator: "/").last, last.hasPrefix("@") {
            handle = String(last)
        }
        let subscribers = strings.first(where: { $0.lowercased().contains("subscriber") })
        var avatar: String?
        if let thumbnails = (metadata?["avatar"] as? [String: Any])?["thumbnails"] as? [[String: Any]],
           let url = thumbnails.first?["url"] as? String {
            avatar = resizedAvatar(url)
        }
        return Channel(id: id, name: name, handle: handle, avatar: avatar, subscribers: subscribers)
    }

    // MARK: Helpers

    static func thumbnail(_ id: String) -> String { "https://i.ytimg.com/vi/\(id)/mqdefault.jpg" }

    /// "12:34" / "1:02:03".
    static func isClock(_ text: String) -> Bool {
        text.range(of: #"^\d{1,3}(:\d{2}){1,2}$"#, options: .regularExpression) != nil
    }

    static func clock(_ seconds: Double?) -> String? {
        guard let seconds, seconds.isFinite, seconds >= 1 else { return nil }
        let total = Int(seconds.rounded())
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let rest = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }

    /// Approximate age in seconds of "3 days ago", "4y ago", "Streamed 2 weeks ago".
    static func ageSeconds(_ text: String?) -> Double? {
        guard let text = text?.lowercased(),
              let regex = try? NSRegularExpression(pattern: #"(\d+)\s*([a-z]+)"#),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let numberRange = Range(match.range(at: 1), in: text),
              let unitRange = Range(match.range(at: 2), in: text),
              let number = Double(text[numberRange]) else { return nil }
        let unit = String(text[unitRange])
        let scale: Double
        if unit.hasPrefix("mo") { scale = 2_592_000 }
        else if unit.hasPrefix("mi") || unit == "m" { scale = 60 }
        else if unit.hasPrefix("s") { scale = 1 }
        else if unit.hasPrefix("h") { scale = 3600 }
        else if unit.hasPrefix("d") { scale = 86400 }
        else if unit.hasPrefix("w") { scale = 604_800 }
        else if unit.hasPrefix("y") { scale = 31_536_000 }
        else { return nil }
        return number * scale
    }

    private static func resizedAvatar(_ raw: String) -> String {
        var url = raw.hasPrefix("//") ? "https:" + raw : raw
        if let range = url.range(of: #"=s\d+-"#, options: .regularExpression) {
            url.replaceSubrange(range, with: "=s176-")
        }
        return url
    }

    private static func collect(_ value: Any, key: String, into found: inout [[String: Any]]) {
        if let dictionary = value as? [String: Any] {
            if let match = dictionary[key] as? [String: Any] { found.append(match) }
            for (name, child) in dictionary where name != key { collect(child, key: key, into: &found) }
        } else if let array = value as? [Any] {
            for child in array { collect(child, key: key, into: &found) }
        }
    }

    /// Collects string values of `key`, optionally only inside dictionaries
    /// stored under `parent`.
    private static func collectStrings(_ value: Any, parent: String?, key: String, into out: inout [String],
                                       inside: Bool = false) {
        guard out.count < 200 else { return }
        if let dictionary = value as? [String: Any] {
            if inside || parent == nil, let string = dictionary[key] as? String { out.append(string) }
            for (name, child) in dictionary {
                collectStrings(child, parent: parent, key: key, into: &out, inside: inside || name == parent)
            }
        } else if let array = value as? [Any] {
            for child in array { collectStrings(child, parent: parent, key: key, into: &out, inside: inside) }
        }
    }

    private static func firstBrowseID(_ value: Any?) -> String? {
        guard let value else { return nil }
        if let dictionary = value as? [String: Any] {
            if let endpoint = dictionary["browseEndpoint"] as? [String: Any],
               let id = endpoint["browseId"] as? String, id.hasPrefix("UC") { return id }
            for child in dictionary.values {
                if let id = firstBrowseID(child) { return id }
            }
        } else if let array = value as? [Any] {
            for child in array {
                if let id = firstBrowseID(child) { return id }
            }
        }
        return nil
    }
}

// MARK: - Watch history and the "For you" feed

/// One entry of the phone's watch history (persisted as history.json next to
/// the library). `key` is the YouTube video ID, or the library UUID for a
/// local import.
struct WatchEntry: Codable {
    var key: String
    var libraryId: String?
    var youtubeID: String?
    var title: String
    var channel: String?
    var channelId: String?
    var position: Double
    var duration: Double?
    var watchedAt: Date
    var plays: Int
}

struct BrowseRow: Codable {
    let title: String
    /// "continue", "related", "channels" or "subscriptions".
    let kind: String
    var subtitle: String?
    /// For "related": the YouTube ID of the watched video this row is based on.
    var seed: String?
    var videos: [YouTubeBrowse.Video]
}

private struct BrowseCached<Value> {
    let at: Date
    let value: Value
}
private struct RemoteFeed {
    var rows: [BrowseRow]
    var errors: [String]
}
private struct FeedSeed {
    let id: String
    let title: String
    let watched: Bool
}
private struct WatchResult {
    let id: String
    let info: YouTubeBrowse.WatchInfo?
}
private struct ChannelResult {
    let id: String
    let page: YouTubeBrowse.ChannelPage?
}
private struct ChannelFillItem {
    let id: UUID
    let youtubeID: String
}
private struct HistoryItem: Encodable {
    let key: String
    let libraryId: String?
    let youtubeID: String?
    let title: String
    let channel: String?
    let channelId: String?
    let thumbnail: String?
    let position: Double
    let duration: Double?
    let progress: Double?
    let watchedAt: String
    let plays: Int
    let inLibrary: Bool
    let state: String?
}
private struct HistoryList: Encodable {
    let items: [HistoryItem]
}
private struct ForYouFeed: Encodable {
    let rows: [BrowseRow]
    let errors: [String]
    let generatedAt: String
    let signedIn: Bool
}

/// Serves `/api/channel`, `/api/history` and `/api/foryou`, records plays
/// seen on `/api/stream/`, and lazily fills `channelId` on library items.
@MainActor final class BrowseService {
    typealias Subscriptions = @MainActor @Sendable () async throws -> [SearchVideo]

    /// Called after library items gained a channelId so HostModel republishes.
    var libraryChanged: (@MainActor () -> Void)?
    private(set) var history: [WatchEntry] = []
    private let historyURL: URL
    private var saveScheduled = false
    private var channelCache: [String: BrowseCached<YouTubeBrowse.ChannelPage>] = [:]
    private var watchCache: [String: BrowseCached<YouTubeBrowse.WatchInfo>] = [:]
    private var feedCache: BrowseCached<RemoteFeed>?
    private var feedTask: Task<RemoteFeed, Never>?
    private var subscriptionCache: BrowseCached<[SearchVideo]>?
    private var subscriptionLoad: Task<Void, Never>?
    private var subscriptionError: String?
    private var channelFill: Task<Void, Never>?
    private var channelFillAttempted = Set<UUID>()
    private static let historyLimit = 300
    private static let channelTTL: TimeInterval = 600
    private static let watchTTL: TimeInterval = 1800
    private static let feedTTL: TimeInterval = 180

    init() {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                 appropriateFor: nil, create: true)) ?? FileManager.default.temporaryDirectory
        let directory = base.appendingPathComponent("MK8")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        historyURL = directory.appendingPathComponent("history.json")
        if let data = try? Data(contentsOf: historyURL),
           let decoded = try? JSONDecoder().decode([WatchEntry].self, from: data) {
            history = decoded
        }
    }

    /// Returns a response for the routes this service owns, or nil to let
    /// HostModel continue (it also observes stream and library requests).
    func respond(to request: HTTPRequest, library: Library?, subscriptions: Subscriptions?) async -> HTTPResponse? {
        let path = request.path
        if request.method == "GET", path.hasPrefix("/api/stream/") {
            observeStream(request, library: library)
            return nil
        }
        if request.method == "GET", path == "/api/library" {
            fillChannelIds(library)
            return nil
        }
        if request.method == "GET", path == "/api/channel" {
            return await channelResponse(request, library: library)
        }
        if request.method == "GET", path == "/api/history" {
            return historyResponse(request, library: library)
        }
        if request.method == "POST", path == "/api/history" {
            return recordProgress(request, library: library)
        }
        if request.method == "POST", path == "/api/history/remove" {
            guard let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any] else {
                return .json(["error": "Choose a history item to remove."], status: 400)
            }
            let key = body["key"] as? String
            let libraryId = body["id"] as? String
            guard key != nil || libraryId != nil else { return .json(["error": "Choose a history item to remove."], status: 400) }
            let before = history.count
            history.removeAll { entry in
                (key != nil && entry.key == key) || (libraryId != nil && entry.libraryId == libraryId)
            }
            feedCache = nil
            saveNow()
            return .json(["removed": before - history.count])
        }
        if request.method == "POST", path == "/api/history/clear" {
            history = []
            feedCache = nil
            saveNow()
            return .json(["cleared": true])
        }
        if request.method == "GET", path == "/api/foryou" {
            return await forYouResponse(request, library: library, subscriptions: subscriptions)
        }
        return nil
    }

    /// Stores a channel the Tesla page already knew when it queued a video.
    func adopt(channelId: String?, channel: String?, for id: UUID, library: Library?) {
        guard let channelId, Self.isChannelID(channelId) else { return }
        let name = channel.map { String($0.prefix(200)) }
        try? library?.setChannelId(id, channelId: channelId, channel: name)
        libraryChanged?()
    }

    // MARK: History

    func record(_ video: LibraryVideo, position: Double?, duration: Double?, finished: Bool = false) {
        let key = video.youtubeID ?? video.id.uuidString
        let now = Date()
        var entry = WatchEntry(key: key, libraryId: nil, youtubeID: video.youtubeID, title: video.title,
                               channel: nil, channelId: nil, position: 0, duration: nil, watchedAt: now, plays: 0)
        var newPlay = true
        if let index = history.firstIndex(where: { $0.key == key }) {
            entry = history.remove(at: index)
            newPlay = now.timeIntervalSince(entry.watchedAt) > 600
        }
        entry.libraryId = video.id.uuidString
        entry.youtubeID = video.youtubeID ?? entry.youtubeID
        entry.title = video.title
        if let channel = video.channel { entry.channel = channel }
        if let channelId = video.channelId { entry.channelId = channelId }
        if let length = duration ?? video.duration, length.isFinite, length > 0 { entry.duration = length }
        if let position, position.isFinite, position >= 0, position < 604_800 { entry.position = position }
        if finished, let length = entry.duration { entry.position = length }
        if newPlay {
            entry.plays += 1
            feedCache = nil
        }
        entry.watchedAt = now
        history.insert(entry, at: 0)
        if history.count > Self.historyLimit { history.removeLast(history.count - Self.historyLimit) }
        scheduleSave()
    }

    private func observeStream(_ request: HTTPRequest, library: Library?) {
        guard request.path.hasSuffix(".ts") else { return }
        let raw = String(request.path.dropFirst("/api/stream/".count).dropLast(3))
        guard let id = UUID(uuidString: raw),
              let video = library?.videos.first(where: { $0.id == id && $0.state == "ready" }) else { return }
        // Position comes from the page's progress reports, not from seeks.
        record(video, position: nil, duration: nil)
    }

    private func recordProgress(_ request: HTTPRequest, library: Library?) -> HTTPResponse {
        guard let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let rawID = body["id"] as? String, let id = UUID(uuidString: rawID) else {
            return .json(["error": "Choose a library item."], status: 400)
        }
        guard let video = library?.videos.first(where: { $0.id == id }) else {
            return .json(["error": "That library item no longer exists."], status: 404)
        }
        let finished = (body["finished"] as? Bool) ?? false
        record(video, position: body["position"] as? Double, duration: body["duration"] as? Double, finished: finished)
        return .json(["recorded": true])
    }

    private func historyResponse(_ request: HTTPRequest, library: Library?) -> HTTPResponse {
        let limit = min(Self.historyLimit, max(1, Int(value(request, "limit")) ?? 50))
        var byID: [String: LibraryVideo] = [:]
        for item in library?.videos ?? [] { byID[item.id.uuidString] = item }
        let formatter = ISO8601DateFormatter()
        let items = history.prefix(limit).map { entry -> HistoryItem in
            let item = entry.libraryId.flatMap { byID[$0] }
            var progress: Double?
            if let length = entry.duration, length > 0 { progress = min(1, entry.position / length) }
            return HistoryItem(key: entry.key, libraryId: item?.id.uuidString, youtubeID: entry.youtubeID,
                               title: item?.title ?? entry.title, channel: item?.channel ?? entry.channel,
                               channelId: item?.channelId ?? entry.channelId,
                               thumbnail: entry.youtubeID.map(YouTubeBrowse.thumbnail),
                               position: entry.position, duration: entry.duration, progress: progress,
                               watchedAt: formatter.string(from: entry.watchedAt), plays: entry.plays,
                               inLibrary: item != nil, state: item?.state)
        }
        return encoded(HistoryList(items: items))
    }

    private func scheduleSave() {
        guard !saveScheduled else { return }
        saveScheduled = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            self.saveScheduled = false
            self.saveNow()
        }
    }

    private func saveNow() {
        guard let data = try? JSONEncoder().encode(history) else { return }
        try? data.write(to: historyURL, options: .atomic)
        try? MediaPipeline.protect(historyURL)
    }

    // MARK: Channel pages

    private func channelResponse(_ request: HTTPRequest, library: Library?) async -> HTTPResponse {
        let continuation = value(request, "continuation")
        guard continuation.count <= 4000 else { return .json(["error": "Invalid continuation."], status: 400) }
        do {
            var page: YouTubeBrowse.ChannelPage
            if !continuation.isEmpty {
                page = try await YouTubeBrowse.channelContinuation(continuation)
            } else {
                let rawID = value(request, "id")
                let name = value(request, "name").trimmingCharacters(in: .whitespacesAndNewlines)
                let channelID: String
                if Self.isChannelID(rawID) {
                    channelID = rawID
                } else if let videoID = YouTubeID.parse(value(request, "video")) {
                    guard let info = await watchInfo(videoID), let owner = info.channelId else {
                        return .json(["error": "The channel for that video could not be found."], status: 404)
                    }
                    learn(videoID: videoID, info: info, library: library)
                    channelID = owner
                } else if !name.isEmpty, name.count <= 100 {
                    channelID = try await YouTubeBrowse.resolveChannel(name: name)
                } else {
                    return .json(["error": "Choose a channel."], status: 400)
                }
                page = try await channelPage(channelID, refresh: value(request, "refresh") == "1")
            }
            page.videos = annotate(page.videos, library: library)
            return encoded(page)
        } catch YouTubeBrowse.Failure.channelNotFound {
            return .json(["error": "That channel could not be found on YouTube."], status: 404)
        } catch {
            return .json(["error": "YouTube is unavailable right now. Try again in a moment."], status: 503)
        }
    }

    private func channelPage(_ id: String, refresh: Bool) async throws -> YouTubeBrowse.ChannelPage {
        if !refresh, let cached = channelCache[id], Date().timeIntervalSince(cached.at) < Self.channelTTL {
            return cached.value
        }
        let page = try await YouTubeBrowse.channel(id: id)
        storeChannel(id, page)
        return page
    }

    private func storeChannel(_ id: String, _ page: YouTubeBrowse.ChannelPage) {
        channelCache[id] = BrowseCached(at: Date(), value: page)
        if channelCache.count > 60, let oldest = channelCache.min(by: { $0.value.at < $1.value.at })?.key {
            channelCache.removeValue(forKey: oldest)
        }
    }

    private func cachedWatch(_ videoID: String) -> YouTubeBrowse.WatchInfo? {
        guard let cached = watchCache[videoID], Date().timeIntervalSince(cached.at) < Self.watchTTL else { return nil }
        return cached.value
    }

    private func storeWatch(_ videoID: String, _ info: YouTubeBrowse.WatchInfo) {
        watchCache[videoID] = BrowseCached(at: Date(), value: info)
        if watchCache.count > 100, let oldest = watchCache.min(by: { $0.value.at < $1.value.at })?.key {
            watchCache.removeValue(forKey: oldest)
        }
    }

    private func watchInfo(_ videoID: String) async -> YouTubeBrowse.WatchInfo? {
        if let cached = cachedWatch(videoID) { return cached }
        guard let info = try? await YouTubeBrowse.watchInfo(videoID) else { return nil }
        storeWatch(videoID, info)
        return info
    }

    /// Copies a video's owner channel onto matching history and library items.
    private func learn(videoID: String, info: YouTubeBrowse.WatchInfo, library: Library?) {
        guard let channelId = info.channelId else { return }
        var historyUpdated = false
        for index in history.indices where history[index].youtubeID == videoID && history[index].channelId == nil {
            history[index].channelId = channelId
            if history[index].channel == nil { history[index].channel = info.channel }
            historyUpdated = true
        }
        if historyUpdated { scheduleSave() }
        var libraryUpdated = false
        for item in library?.videos ?? [] where item.youtubeID == videoID && item.channelId == nil {
            try? library?.setChannelId(item.id, channelId: channelId, channel: info.channel)
            libraryUpdated = true
        }
        if libraryUpdated { libraryChanged?() }
    }

    /// Resolves missing channel IDs for older library items, a few per
    /// library load, so channel names become tappable on the Tesla page.
    private func fillChannelIds(_ library: Library?) {
        guard channelFill == nil, let library else { return }
        var items: [ChannelFillItem] = []
        for item in library.videos where item.channelId == nil && !channelFillAttempted.contains(item.id) {
            guard let youtubeID = item.youtubeID else { continue }
            items.append(ChannelFillItem(id: item.id, youtubeID: youtubeID))
            if items.count >= 12 { break }
        }
        guard !items.isEmpty else { return }
        channelFill = Task { @MainActor in
            for item in items {
                self.channelFillAttempted.insert(item.id)
                if let info = await self.watchInfo(item.youtubeID) {
                    self.learn(videoID: item.youtubeID, info: info, library: library)
                }
            }
            self.channelFill = nil
        }
    }

    // MARK: For you

    private func forYouResponse(_ request: HTTPRequest, library: Library?, subscriptions: Subscriptions?) async -> HTTPResponse {
        let refresh = value(request, "refresh") == "1"
        var rows: [BrowseRow] = []
        let continueRow = continueWatching(library)
        if !continueRow.videos.isEmpty { rows.append(continueRow) }
        let remote: RemoteFeed
        if !refresh, let cached = feedCache, Date().timeIntervalSince(cached.at) < Self.feedTTL {
            remote = cached.value
        } else if let running = feedTask {
            remote = await running.value
        } else {
            let task = Task { @MainActor () -> RemoteFeed in
                await self.buildRemote(library: library, subscriptions: subscriptions)
            }
            feedTask = task
            remote = await task.value
            feedTask = nil
            // A partial feed (some row failed or still loading) is kept only ~30 s.
            let stamp = remote.errors.isEmpty ? Date() : Date().addingTimeInterval(30 - Self.feedTTL)
            feedCache = remote.rows.isEmpty ? nil : BrowseCached(at: stamp, value: remote)
        }
        for row in remote.rows {
            var copy = row
            copy.videos = annotate(row.videos, library: library)
            if !copy.videos.isEmpty { rows.append(copy) }
        }
        return encoded(ForYouFeed(rows: rows, errors: remote.errors,
                                  generatedAt: ISO8601DateFormatter().string(from: Date()),
                                  signedIn: subscriptions != nil))
    }

    private func continueWatching(_ library: Library?) -> BrowseRow {
        var byID: [String: LibraryVideo] = [:]
        for item in library?.videos ?? [] { byID[item.id.uuidString] = item }
        var videos: [YouTubeBrowse.Video] = []
        for entry in history {
            guard let libraryId = entry.libraryId, let item = byID[libraryId], item.state == "ready",
                  entry.position >= 15 else { continue }
            let length = entry.duration ?? item.duration
            var progress: Double?
            if let length, length > 0 {
                let fraction = min(1, entry.position / length)
                if fraction >= 0.92 { continue }
                progress = fraction
            }
            videos.append(YouTubeBrowse.Video(id: item.youtubeID ?? libraryId, title: item.title, channel: item.channel,
                                              channelId: item.channelId ?? entry.channelId,
                                              thumbnail: item.youtubeID.map(YouTubeBrowse.thumbnail),
                                              duration: YouTubeBrowse.clock(length), published: nil, views: nil,
                                              youtube: item.youtubeID != nil, libraryId: libraryId,
                                              libraryState: item.state, position: entry.position, progress: progress))
            if videos.count >= 12 { break }
        }
        return BrowseRow(title: "Continue watching", kind: "continue", subtitle: nil, seed: nil, videos: videos)
    }

    private func buildRemote(library: Library?, subscriptions: Subscriptions?) async -> RemoteFeed {
        var errors: [String] = []
        let started = Date()
        // Subscriptions (Data API, many requests) load in parallel with the
        // keyless rows and are cached; the feed waits for them only briefly.
        if let fetch = subscriptions { loadSubscriptions(fetch) } else { subscriptionCache = nil }

        // Seeds: the most recently watched YouTube videos, topped up from
        // the library so a new user still gets recommendations.
        var seeds: [FeedSeed] = []
        for entry in history {
            guard seeds.count < 3, let youtubeID = entry.youtubeID else { continue }
            if !seeds.contains(where: { $0.id == youtubeID }) {
                seeds.append(FeedSeed(id: youtubeID, title: entry.title, watched: true))
            }
        }
        for item in library?.videos ?? [] where seeds.count < 2 && item.state == "ready" {
            guard let youtubeID = item.youtubeID else { continue }
            if !seeds.contains(where: { $0.id == youtubeID }) {
                seeds.append(FeedSeed(id: youtubeID, title: item.title, watched: false))
            }
        }

        var infos: [String: YouTubeBrowse.WatchInfo] = [:]
        var missing: [String] = []
        for seed in seeds {
            if let cached = cachedWatch(seed.id) { infos[seed.id] = cached } else { missing.append(seed.id) }
        }
        let fetchedInfos = await withTaskGroup(of: WatchResult.self, returning: [WatchResult].self) { group in
            for id in missing {
                group.addTask { WatchResult(id: id, info: try? await YouTubeBrowse.watchInfo(id)) }
            }
            var all: [WatchResult] = []
            for await result in group { all.append(result) }
            return all
        }
        for result in fetchedInfos {
            guard let info = result.info else { continue }
            storeWatch(result.id, info)
            infos[result.id] = info
            learn(videoID: result.id, info: info, library: library)
        }

        var used = Set<String>(history.compactMap { $0.youtubeID })
        for seed in seeds { used.insert(seed.id) }
        var relatedRows: [BrowseRow] = []
        for seed in seeds {
            guard let info = infos[seed.id] else {
                errors.append("Videos like \(seed.title) are unavailable right now.")
                continue
            }
            var picked: [YouTubeBrowse.Video] = []
            for video in info.related where !used.contains(video.id) {
                picked.append(video)
                used.insert(video.id)
                if picked.count >= 12 { break }
            }
            if !picked.isEmpty {
                let title = (seed.watched ? "Because you watched " : "Because you saved ") + seed.title
                relatedRows.append(BrowseRow(title: title, kind: "related", subtitle: info.channel, seed: seed.id, videos: picked))
            }
        }

        // New uploads from channels in the history, then the library.
        var channelIDs: [String] = []
        for entry in history {
            guard channelIDs.count < 6, let channelId = entry.channelId else { continue }
            if !channelIDs.contains(channelId) { channelIDs.append(channelId) }
        }
        for item in library?.videos ?? [] where channelIDs.count < 6 {
            guard let channelId = item.channelId else { continue }
            if !channelIDs.contains(channelId) { channelIDs.append(channelId) }
        }
        var pages: [YouTubeBrowse.ChannelPage] = []
        var toFetch: [String] = []
        for id in channelIDs {
            if let cached = channelCache[id], Date().timeIntervalSince(cached.at) < Self.channelTTL {
                pages.append(cached.value)
            } else {
                toFetch.append(id)
            }
        }
        let fetchedPages = await withTaskGroup(of: ChannelResult.self, returning: [ChannelResult].self) { group in
            for id in toFetch {
                group.addTask { ChannelResult(id: id, page: try? await YouTubeBrowse.channel(id: id)) }
            }
            var all: [ChannelResult] = []
            for await result in group { all.append(result) }
            return all
        }
        var failedChannels = 0
        for result in fetchedPages {
            if let page = result.page {
                storeChannel(result.id, page)
                pages.append(page)
            } else {
                failedChannels += 1
            }
        }
        if failedChannels > 0 { errors.append("\(failedChannels) channel(s) could not be loaded.") }
        var uploads: [YouTubeBrowse.Video] = []
        for page in pages {
            var taken = 0
            for video in page.videos where taken < 5 && !used.contains(video.id) {
                uploads.append(video)
                used.insert(video.id)
                taken += 1
            }
        }
        let never = Double.greatestFiniteMagnitude
        uploads.sort { (YouTubeBrowse.ageSeconds($0.published) ?? never) < (YouTubeBrowse.ageSeconds($1.published) ?? never) }

        var rows: [BrowseRow] = []
        if let first = relatedRows.first { rows.append(first) }
        if !uploads.isEmpty {
            rows.append(BrowseRow(title: "New from channels you watch", kind: "channels", subtitle: nil, seed: nil,
                                  videos: Array(uploads.prefix(24))))
        }
        if subscriptions != nil {
            // Stay well inside the 15 s HTTP/relay response timeout.
            let deadline = started.addingTimeInterval(9)
            while subscriptionLoad != nil, Date() < deadline {
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            if let videos = subscriptionCache?.value {
                let mapped = videos.filter { !used.contains($0.id) }.prefix(24).map { video -> YouTubeBrowse.Video in
                    YouTubeBrowse.Video(id: video.id, title: video.title, channel: video.channel, channelId: nil,
                                        thumbnail: video.thumbnail ?? YouTubeBrowse.thumbnail(video.id),
                                        duration: nil, published: nil, views: nil)
                }
                if !mapped.isEmpty {
                    rows.append(BrowseRow(title: "Subscriptions", kind: "subscriptions", subtitle: nil, seed: nil, videos: mapped))
                }
            } else if let message = subscriptionError {
                errors.append("Subscriptions: " + message)
            } else {
                errors.append("Subscriptions are still loading. Refresh in a moment.")
            }
        }
        rows.append(contentsOf: relatedRows.dropFirst())
        return RemoteFeed(rows: rows, errors: errors)
    }

    private func loadSubscriptions(_ fetch: @escaping Subscriptions) {
        guard subscriptionLoad == nil else { return }
        if let cached = subscriptionCache, Date().timeIntervalSince(cached.at) < 600 { return }
        subscriptionLoad = Task { @MainActor in
            do {
                let videos = try await fetch()
                self.subscriptionCache = BrowseCached(at: Date(), value: videos)
                self.subscriptionError = nil
            } catch {
                self.subscriptionError = error.localizedDescription
            }
            self.subscriptionLoad = nil
        }
    }

    // MARK: Helpers

    /// Marks videos already in the library and adds watch progress.
    private func annotate(_ videos: [YouTubeBrowse.Video], library: Library?) -> [YouTubeBrowse.Video] {
        var byYouTube: [String: LibraryVideo] = [:]
        for item in library?.videos ?? [] {
            if let youtubeID = item.youtubeID, byYouTube[youtubeID] == nil { byYouTube[youtubeID] = item }
        }
        var watched: [String: WatchEntry] = [:]
        for entry in history {
            if let youtubeID = entry.youtubeID, watched[youtubeID] == nil { watched[youtubeID] = entry }
        }
        return videos.map { video -> YouTubeBrowse.Video in
            var copy = video
            if copy.youtube == nil { copy.youtube = true }
            if copy.youtube == true {
                if copy.libraryId == nil, let item = byYouTube[copy.id] {
                    copy.libraryId = item.id.uuidString
                    copy.libraryState = item.state
                }
                if copy.position == nil, let entry = watched[copy.id] {
                    copy.position = entry.position
                    if let length = entry.duration, length > 0 { copy.progress = min(1, entry.position / length) }
                }
            }
            return copy
        }
    }

    private func value(_ request: HTTPRequest, _ name: String) -> String {
        request.query.first(where: { $0.name == name })?.value ?? ""
    }

    private func encoded<T: Encodable>(_ value: T) -> HTTPResponse {
        guard let data = try? JSONEncoder().encode(value) else {
            return .json(["error": "Could not encode the response."], status: 500)
        }
        return HTTPResponse(status: 200, contentType: "application/json", body: data, headers: ["Cache-Control": "no-store"])
    }

    static func isChannelID(_ value: String) -> Bool {
        value.count == 24 && value.hasPrefix("UC")
            && value.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }
}
