import Foundation
import Network

struct PhoneConnection: Sendable {
    enum State: Sendable, Equatable { case checking, online, connecting, offline }
    var state: State = .checking
    var name = "Checking connection"
    var symbol = "network"
    var lowDataMode = false

    init() {}
    init(path: NWPath) {
        lowDataMode = path.isConstrained
        switch path.status {
        case .satisfied:
            state = .online
            if path.usesInterfaceType(.wifi) { name = "Wi-Fi"; symbol = "wifi" }
            else if path.usesInterfaceType(.cellular) { name = "Cellular"; symbol = "antenna.radiowaves.left.and.right" }
            else if path.usesInterfaceType(.wiredEthernet) { name = "Ethernet"; symbol = "cable.connector" }
            else { name = "Connected"; symbol = "network" }
        case .requiresConnection: state = .connecting; name = "Connecting"; symbol = "network"
        case .unsatisfied: state = .offline; name = "No internet connection"; symbol = "wifi.slash"
        @unknown default: state = .offline; name = "Connection unavailable"; symbol = "network"
        }
    }
}

enum TunnelConnectionState: String, Equatable {
    case notConfigured, connecting, connected, reconnecting, disconnected, failed
    var title: String {
        switch self {
        case .notConfigured: return "Setup needed"
        case .connecting: return "Connecting"
        case .connected: return "Connected"
        case .reconnecting: return "Reconnecting"
        case .disconnected: return "Disconnected"
        case .failed: return "Connection failed"
        }
    }
    var symbol: String {
        switch self {
        case .connected: return "checkmark.icloud.fill"
        case .connecting, .reconnecting: return "arrow.triangle.2.circlepath"
        case .failed: return "exclamationmark.icloud.fill"
        case .notConfigured, .disconnected: return "icloud.slash"
        }
    }
    var animating: Bool { self == .connecting || self == .reconnecting }
}
