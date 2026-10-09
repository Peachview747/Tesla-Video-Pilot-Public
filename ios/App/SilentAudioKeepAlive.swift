import AVFoundation
import Combine
import MK8Core

/// Experimental sideloaded-app workaround, not a promise of background hosting.
/// Owns audio only when requested and yields completely to native/PiP playback.
@MainActor final class SilentAudioKeepAlive: ObservableObject {
    static let shared = SilentAudioKeepAlive()
    @Published private(set) var status = "Experimental keepalive is off."
    @Published private(set) var isActive = false
    private var policy = KeepAlivePolicy()
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var ownsSession = false
    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification,
            object: nil, queue: .main) { [weak self] notification in
            let raw = (notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? NSNumber)?.uintValue
            let options = (notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? NSNumber)?.uintValue ?? 0
            Task { @MainActor in self?.interruption(raw: raw, options: options) }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange,
            object: nil, queue: .main) { [weak self] notification in
            let changed = notification.object as? AVAudioEngine
            Task { @MainActor in
                guard let self, let changed, self.engine === changed else { return }
                self.record("engineConfigurationChanged")
                self.tearDown()
                self.reconcile()
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.record("mediaServicesReset")
                self.ownsSession = false
                self.tearDown()
                self.reconcile()
            }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification,
            object: nil, queue: .main) { [weak self] notification in
            let reason = (notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? NSNumber)?.uintValue ?? 0
            Task { @MainActor in
                guard let self, self.policy.enabled, self.policy.hosting else { return }
                self.record("routeChanged", fields: ["reason": "\(reason)"])
                // Engine configuration notifications rebuild changed hardware.
                // Retry a stopped engine on a real device change, not our own
                // category changes (which would cause a restart loop).
                if reason != AVAudioSession.RouteChangeReason.categoryChange.rawValue,
                   self.engine?.isRunning == false {
                    self.tearDown()
                    self.reconcile()
                }
            }
        })
    }

    func update(enabled: Bool, hosting: Bool, foreground: Bool) {
        policy.enabled = enabled
        policy.hosting = hosting
        policy.foreground = foreground
        if foreground || !enabled || !hosting { policy.resetInterruption() }
        reconcile()
    }

    func setNativePlayback(_ inUse: Bool) {
        policy.nativePlayback = inUse
        reconcile()
    }

    private func interruption(raw: UInt?, options: UInt) {
        guard let raw, let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            policy.beginInterruption()
            record("interruptionBegan")
            // The system has already deactivated the audio session.
            ownsSession = false
            tearDown()
        } else {
            let resume = AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume)
            policy.endInterruption(shouldResume: resume)
            record("interruptionEnded", fields: ["shouldResume": "\(resume)"])
        }
        reconcile()
    }

    private func reconcile() {
        guard policy.shouldRun else {
            tearDown()
            status = policy.nativePlayback ? "Keepalive yields to the native video player." :
                (policy.interrupted ? "Audio interrupted; keepalive is paused." : "Keepalive idle or disabled.")
            return
        }
        guard engine?.isRunning != true || player?.isPlaying != true else { return }
        tearDown()
        do {
            // Construct everything first so activation/allocation failures have
            // one cleanup path and cannot leave a phantom active session.
            guard let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1),
                  let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 11_025),
                  let samples = buffer.floatChannelData else {
                throw NSError(domain: "KeepAlive", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Could not allocate the audio buffer."])
            }
            buffer.frameLength = 11_025
            samples[0].initialize(repeating: 0, count: Int(buffer.frameLength))
            let nextEngine = AVAudioEngine()
            let nextPlayer = AVAudioPlayerNode()
            engine = nextEngine
            player = nextPlayer
            nextEngine.attach(nextPlayer)
            nextEngine.connect(nextPlayer, to: nextEngine.mainMixerNode, format: format)
            nextEngine.mainMixerNode.outputVolume = 0
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
            ownsSession = true
            nextPlayer.scheduleBuffer(buffer, at: nil, options: [.loops], completionHandler: nil)
            try nextEngine.start()
            nextPlayer.play()
            isActive = true
            status = "Silent audio running. Tunnel survival is still experimental."
            record("started")
        } catch {
            tearDown()
            status = "Keepalive could not start: \(error.localizedDescription)"
            record("startFailed", fields: ["error": error.localizedDescription])
        }
    }

    private func tearDown() {
        let wasActive = isActive
        player?.stop()
        engine?.stop()
        player = nil
        engine = nil
        isActive = false
        if ownsSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            ownsSession = false
        }
        if wasActive { record("stopped") }
    }

    private func record(_ event: String, fields: [String: String] = [:]) {
        SessionDiagnostics.shared.record(component: "keepalive", event: event, fields: fields)
    }
}
