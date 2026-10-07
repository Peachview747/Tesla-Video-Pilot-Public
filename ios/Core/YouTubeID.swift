import Foundation

public enum YouTubeID {
    public static func parse(_ input: String) -> String? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if valid(text) { return text }
        guard let url = URL(string: text), url.scheme == "https",
              let host = url.host?.lowercased() else { return nil }
        if host == "youtu.be" { return checked(String(url.path.dropFirst())) }
        guard ["youtube.com", "www.youtube.com", "m.youtube.com"].contains(host) else { return nil }
        if url.path == "/watch" {
            return checked(URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "v" })?.value)
        }
        let parts = url.path.split(separator: "/")
        if parts.count == 2, ["shorts", "live", "embed"].contains(String(parts[0])) {
            return checked(String(parts[1]))
        }
        return nil
    }

    private static func checked(_ value: String?) -> String? {
        guard let value, valid(value) else { return nil }
        return value
    }
    private static func valid(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil
    }
}
