import Foundation

/// A failed availability probe is not necessarily a configuration failure.
/// Cloudflare and captive networks can return HTML while the existing relay
/// is temporarily unavailable; keep reconnecting through those responses.
public enum RelayWorkerCheck {
    public enum Failure: Error, Equatable {
        case keyRejected
        case setupRequired
        case unavailable(Int)
    }

    public static func validate(status: Int, data: Data) throws {
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if status == 401 || status == 403 { throw Failure.keyRejected }
        if status == 404 || status == 405 || status == 426 ||
            object?["error"] as? String == "Deploy the iPhone Worker update" {
            throw Failure.setupRequired
        }
        guard status == 200 else { throw Failure.unavailable(status) }
        guard let object, let name = object["protocol"] as? String,
              let configured = object["configured"] as? Bool else {
            throw Failure.unavailable(status)
        }
        guard name == RelayProtocol.name else { throw Failure.setupRequired }
        guard configured else { throw Failure.keyRejected }
    }
}
