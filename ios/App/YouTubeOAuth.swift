import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

/// Provider-specific Google OAuth for the YouTube account features.  Tokens
/// stay in the iPhone Keychain; the Tesla browser only receives filtered API
/// results from HostModel.
@MainActor
final class YouTubeOAuth: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    struct Tokens: Codable {
        var accessToken: String
        var refreshToken: String
        var expiresAt: Date
    }

    static let clientID = "916235441326-50bg31an4jfc9ocnjci4ns0vj1b7m3bf.apps.googleusercontent.com"
    static let callbackScheme = "com.googleusercontent.apps.916235441326-50bg31an4jfc9ocnjci4ns0vj1b7m3bf"
    private static let redirectURI = callbackScheme + ":/oauthredirect"
    private static let account = "youtube-oauth"

    @Published private(set) var signedIn = false
    @Published private(set) var accountName = ""
    @Published private(set) var isSigningIn = false
    private var session: ASWebAuthenticationSession?
    private var generation = UUID()
    private var refreshTask: Task<Tokens, Error>?

    override init() {
        super.init()
        signedIn = Self.loadTokens() != nil
    }

    func signIn() async throws {
        guard !isSigningIn else { throw Failure.couldNotStart }
        isSigningIn = true
        defer { isSigningIn = false }
        generation = UUID()
        refreshTask?.cancel(); refreshTask = nil
        let attempt = generation
        let verifier = Self.randomString(length: 64)
        let state = Self.randomString(length: 32)
        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: Self.clientID),
            URLQueryItem(name: "redirect_uri", value: Self.redirectURI),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "https://www.googleapis.com/auth/youtube.readonly"),
            URLQueryItem(name: "access_type", value: "offline"),
            URLQueryItem(name: "prompt", value: "consent"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: Self.challenge(verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256")
        ]
        guard let url = components.url else { throw Failure.invalidAuthorizationURL }
        let callback = try await authenticate(url: url, state: state)
        let exchanged = try await exchange(code: callback, verifier: verifier)
        guard generation == attempt else { throw CancellationError() }
        try Self.saveTokens(exchanged)
        // Refresh work begun against the previous account during the browser
        // exchange cannot overwrite the newly selected account's tokens.
        generation = UUID()
        refreshTask?.cancel(); refreshTask = nil
        signedIn = true
        accountName = "Google account connected"
    }

    func signOut() {
        generation = UUID()
        session?.cancel(); session = nil
        refreshTask?.cancel(); refreshTask = nil
        try? Keychain.write("", account: Self.account)
        signedIn = false
        accountName = ""
    }

    func accessToken(forceRefresh: Bool = false) async throws -> String {
        let attempt = generation
        guard var tokens = Self.loadTokens() else { throw Failure.notSignedIn }
        if forceRefresh || tokens.expiresAt.timeIntervalSinceNow < 60 {
            let task: Task<Tokens, Error>
            if let existing = refreshTask { task = existing }
            else {
                let original = tokens
                task = Task { try await self.refresh(original) }
                refreshTask = task
            }
            do { tokens = try await task.value }
            catch {
                if generation == attempt { refreshTask = nil }
                throw error
            }
            guard generation == attempt else { throw CancellationError() }
            refreshTask = nil
            try Self.saveTokens(tokens)
        }
        guard generation == attempt else { throw CancellationError() }
        signedIn = true
        return tokens.accessToken
    }

    func retryUnauthorized<T>(_ operation: (String) async throws -> T) async throws -> T {
        let token = try await accessToken()
        do { return try await operation(token) }
        catch let error as NSError where error.domain == "MK8.YouTube" && error.code == 401 {
            let refreshed = try await accessToken(forceRefresh: true)
            return try await operation(refreshed)
        }
    }

    func request(_ url: URL, method: String = "GET") async throws -> Data {
        let token = try await accessToken()
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.invalidResponse }
        guard (200..<300).contains(http.statusCode) else { throw Failure.requestFailed(http.statusCode) }
        return data
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first { $0.isKeyWindow } ?? UIWindow(frame: UIScreen.main.bounds)
    }

    private func authenticate(url: URL, state: String) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let auth = ASWebAuthenticationSession(url: url, callbackURLScheme: Self.callbackScheme) { [weak self] callback, error in
                self?.session = nil
                if let error { continuation.resume(throwing: error); return }
                guard let callback,
                      let values = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
                      values.first(where: { $0.name == "state" })?.value == state,
                      let code = values.first(where: { $0.name == "code" })?.value else {
                    continuation.resume(throwing: Failure.invalidCallback); return
                }
                continuation.resume(returning: code)
            }
            auth.presentationContextProvider = self
            auth.prefersEphemeralWebBrowserSession = false
            session = auth
            guard auth.start() else {
                session = nil
                continuation.resume(throwing: Failure.couldNotStart)
                return
            }
        }
    }

    private func exchange(code: String, verifier: String) async throws -> Tokens {
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.form([
            "client_id": Self.clientID, "code": code, "code_verifier": verifier,
            "grant_type": "authorization_code", "redirect_uri": Self.redirectURI
        ]).data(using: .utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw Failure.tokenExchangeFailed }
        struct Result: Decodable { let access_token: String; let expires_in: Int; let refresh_token: String? }
        let result = try JSONDecoder().decode(Result.self, from: data)
        return Tokens(accessToken: result.access_token, refreshToken: result.refresh_token ?? "", expiresAt: Date().addingTimeInterval(TimeInterval(result.expires_in)))
    }

    private func refresh(_ tokens: Tokens) async throws -> Tokens {
        guard !tokens.refreshToken.isEmpty else { throw Failure.notSignedIn }
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.form(["client_id": Self.clientID, "refresh_token": tokens.refreshToken, "grant_type": "refresh_token"]).data(using: .utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure.invalidResponse }
        if http.statusCode == 400, let detail = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           detail["error"] as? String == "invalid_grant" {
            // Only clear the credentials that actually failed, not a newer
            // sign-in that completed while this refresh was in flight.
            if Self.loadTokens()?.refreshToken == tokens.refreshToken { signOut() }
            throw Failure.notSignedIn
        }
        guard (200..<300).contains(http.statusCode) else { throw Failure.refreshFailed }
        struct Result: Decodable { let access_token: String; let expires_in: Int }
        let result = try JSONDecoder().decode(Result.self, from: data)
        return Tokens(accessToken: result.access_token, refreshToken: tokens.refreshToken, expiresAt: Date().addingTimeInterval(TimeInterval(result.expires_in)))
    }

    private static func loadTokens() -> Tokens? {
        guard let data = Keychain.read(account).data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Tokens.self, from: data)
    }
    private static func saveTokens(_ tokens: Tokens) throws {
        try Keychain.write(String(data: try JSONEncoder().encode(tokens), encoding: .utf8)!, account: account)
    }
    private static func randomString(length: Int) -> String {
        let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-._~")
        return String((0..<length).compactMap { _ in alphabet.randomElement() })
    }
    private static func challenge(_ verifier: String) -> String {
        Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func form(_ values: [String: String]) -> String {
        values.map { key, value in "\(key.urlEncoded)=\(value.urlEncoded)" }.sorted().joined(separator: "&")
    }

    enum Failure: LocalizedError {
        case invalidAuthorizationURL, invalidCallback, couldNotStart, tokenExchangeFailed, refreshFailed, notSignedIn, invalidResponse
        case requestFailed(Int)
        var errorDescription: String? {
            switch self {
            case .notSignedIn: return "Sign in with Google on the iPhone first."
            case .requestFailed(let code): return "YouTube account request failed (\(code))."
            default: return "Google sign-in could not be completed."
            }
        }
    }
}

private extension String {
    var urlEncoded: String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return addingPercentEncoding(withAllowedCharacters: allowed) ?? self
    }
}
