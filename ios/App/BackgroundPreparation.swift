import BackgroundTasks
import UIKit
import MK8Core

/// A finite, user-started media job. This is not permission for an always-on server.
@MainActor final class BackgroundPreparation: ObservableObject {
    static let shared = BackgroundPreparation()
    @Published private(set) var isRunning = false
    @Published private(set) var status = "Start a video to request background preparation."
    private var systemTask: BGTask?
    private var identifier: String?
    private var title = "Preparing video"
    private var onExpiration: (() -> Void)?

    func begin(title: String, enabled: Bool, onExpiration: @escaping () -> Void) {
        finish(success: false)
        self.title = title
        guard enabled else { status = "Background preparation is off."; return }
        guard #available(iOS 26.0, *) else { status = "Downloads can continue; reopen Video Pilot to convert."; return }
        guard UIApplication.shared.applicationState == .active else {
            status = "Reopen Video Pilot to enable background preparation."; return
        }
        let id = "com.mk8.iphone.host.prepare." + UUID().uuidString
        identifier = id
        self.onExpiration = onExpiration
        let registered = BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: .main) { [weak self] task in
            Task { @MainActor in
                guard let self, self.identifier == id, let task = task as? BGContinuedProcessingTask else {
                    task.setTaskCompleted(success: false); return
                }
                self.systemTask = task
                self.isRunning = true
                self.status = "Background preparation active."
                task.progress.totalUnitCount = 1_000
                task.expirationHandler = { [weak self] in
                    Task { @MainActor in
                        guard let self, self.identifier == id else { return }
                        let cancel = self.onExpiration
                        self.finish(success: false)
                        self.status = "iOS paused preparation. Your download is saved."
                        cancel?()
                    }
                }
            }
        }
        guard registered else {
            identifier = nil; status = "iOS could not register background preparation. Keep Video Pilot open."; return
        }
        let request = BGContinuedProcessingTaskRequest(identifier: id, title: "Video Pilot · Prepare video", subtitle: title)
        request.strategy = .fail
        // CPU and network only: no restricted GPU entitlement is needed for personal signing.
        do {
            try BGTaskScheduler.shared.submit(request)
            status = "Requesting background preparation…"
        } catch {
            identifier = nil; self.onExpiration = nil
            status = "iOS did not grant background preparation. Downloads can continue; keep Video Pilot open to convert."
        }
    }

    func update(_ progress: MediaPreparationProgress) {
        guard #available(iOS 26.0, *), let task = systemTask as? BGContinuedProcessingTask else { return }
        let fraction = progress.fraction ?? 0
        let units: Int64
        let subtitle: String
        switch progress.stage {
        case .resolving, .importing: units = 0; subtitle = "Finding your video"
        case .downloading: units = Int64(fraction * 550); subtitle = "Downloading · \(Int(fraction * 100))%"
        case .waitingForApp: units = 550; subtitle = "Waiting to prepare"
        case .processing: units = 550 + Int64(fraction * 440); subtitle = "Preparing · \(Int(fraction * 100))%"
        case .finalizing: units = 995; subtitle = "Saving to your library"
        }
        task.progress.completedUnitCount = max(task.progress.completedUnitCount, units)
        task.updateTitle("Video Pilot · " + String(title.prefix(60)), subtitle: subtitle)
    }

    func finish(success: Bool) {
        if #available(iOS 26.0, *), let task = systemTask as? BGContinuedProcessingTask {
            task.expirationHandler = nil
            if success { task.progress.completedUnitCount = task.progress.totalUnitCount }
            task.setTaskCompleted(success: success)
        }
        if let identifier { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier) }
        systemTask = nil; identifier = nil; onExpiration = nil; isRunning = false
        if success { status = "Last video is ready." }
    }
}
