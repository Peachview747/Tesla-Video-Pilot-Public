import UIKit

@MainActor final class AppActivity {
    static let shared = AppActivity()
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]
    private var observer: NSObjectProtocol?
    var isActive: Bool { UIApplication.shared.applicationState == .active }
    var processingAllowed: Bool { isActive || BackgroundPreparation.shared.isRunning }
    var chunkSchedulingAllowed: Bool {
        UIApplication.shared.applicationState != .background || BackgroundPreparation.shared.isRunning
    }

    private init() {
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification,
                                                          object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                let waiting = self.waiters
                self.waiters.removeAll()
                for continuation in waiting.values { continuation.resume() }
            }
        }
    }

    func waitUntilActive() async {
        guard !Task.isCancelled, !isActive else { return }
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                // Activation or cancellation may happen between the first
                // check and registration. Neither may strand a waiter.
                if isActive || Task.isCancelled { continuation.resume() }
                else { waiters[id] = continuation }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.waiters.removeValue(forKey: id)?.resume() }
        }
    }
    func waitUntilProcessingAllowed() async throws {
        while !processingAllowed {
            try Task.checkCancellation()
            try await Task.sleep(nanoseconds: 200_000_000)
        }
    }
}

final class MK8AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == MediaDownloader.backgroundIdentifier else { completionHandler(); return }
        MediaDownloader.shared.handleBackgroundEvents(completion: completionHandler)
    }
}
