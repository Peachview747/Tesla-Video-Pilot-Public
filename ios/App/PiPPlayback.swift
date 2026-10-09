import AVKit
import SwiftUI
import UniformTypeIdentifiers

/// A real, user-selected movie plays through Apple's native PiP player.
/// Its lifetime belongs to the host, not the sheet or a particular navigation tab.
@MainActor final class PiPPlayback: NSObject, ObservableObject, AVPlayerViewControllerDelegate {
    @Published var presented = false
    @Published private(set) var active = false
    @Published private(set) var loading = false
    @Published private(set) var status = "Choose a movie from Files to test background playback."
    let controller = AVPlayerViewController()
    private var generation = UUID()
    private var preparation: Task<Void, Never>?
    private var file: URL?
    private var endObserver: NSObjectProtocol?
    private var statusObserver: NSKeyValueObservation?
    private var audioSessionActive = false
    private var restoreCompletion: ((Bool) -> Void)?

    override init() {
        super.init()
        controller.delegate = self
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
    }

    func open(_ source: URL) {
        guard !active else { return }
        guard AVPictureInPictureController.isPictureInPictureSupported() else {
            status = "Picture in Picture is unavailable on this device."
            return
        }
        stop()
        let token = UUID()
        generation = token
        loading = true
        status = "Opening movie…"
        preparation = Task {
            var staged: URL?
            do {
                let copy = try await Task.detached(priority: .utility) {
                    let scoped = source.startAccessingSecurityScopedResource()
                    defer { if scoped { source.stopAccessingSecurityScopedResource() } }
                    let root = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                        .appendingPathComponent("PiPPlayback", isDirectory: true)
                    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                    let target = root.appendingPathComponent(UUID().uuidString)
                        .appendingPathExtension(source.pathExtension)
                    do {
                        try FileManager.default.copyItem(at: source, to: target)
                        return target
                    } catch {
                        try? FileManager.default.removeItem(at: target)
                        throw error
                    }
                }.value
                staged = copy
                try Task.checkCancellation()
                let asset = AVURLAsset(url: copy)
                guard try await asset.load(.isPlayable) else {
                    throw NSError(domain: "PiPPlayback", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "Choose an iPhone-compatible movie, such as H.264 MP4. Tesla MPEG-1 files cannot play in native PiP."])
                }
                try Task.checkCancellation()
                guard generation == token else { throw CancellationError() }
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .moviePlayback)
                try session.setActive(true)
                audioSessionActive = true
                file = copy
                let item = AVPlayerItem(asset: asset)
                controller.player = AVPlayer(playerItem: item)
                statusObserver = item.observe(\.status, options: [.new]) { [weak self] item, _ in
                    guard item.status == .failed else { return }
                    Task { @MainActor in
                        guard let self, self.generation == token else { return }
                        self.status = "Movie playback failed. Choose another compatible file."
                        SessionDiagnostics.shared.record(component: "pip", event: "playbackFailed")
                        self.controller.player?.pause()
                    }
                }
                endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime,
                    object: item, queue: .main) { [weak self] _ in
                    Task { @MainActor in
                        guard let self, self.generation == token else { return }
                        self.status = "Movie finished. PiP no longer provides active playback."
                        SessionDiagnostics.shared.record(component: "pip", event: "ended")
                    }
                }
                loading = false
                status = "Playing. Tap the PiP icon, then switch apps to test the tunnel."
                presented = true
                controller.player?.play()
                SessionDiagnostics.shared.record(component: "pip", event: "playbackStarted")
            } catch {
                if let staged, staged != file { try? FileManager.default.removeItem(at: staged) }
                guard generation == token else { return }
                loading = false
                status = error is CancellationError ? "Playback cancelled." : error.localizedDescription
                SessionDiagnostics.shared.record(component: "pip", event: "openFailed")
            }
        }
    }

    func stop() {
        generation = UUID()
        preparation?.cancel()
        preparation = nil
        restoreCompletion?(false)
        restoreCompletion = nil
        controller.player?.pause()
        controller.player = nil
        statusObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
        if audioSessionActive {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            audioSessionActive = false
        }
        active = false
        loading = false
        status = "Playback stopped."
        SessionDiagnostics.shared.record(component: "pip", event: "stopped")
    }

    func playerViewControllerDidStartPictureInPicture(_ playerViewController: AVPlayerViewController) {
        active = true
        status = "PiP active. Tunnel survival is experimental; export diagnostics after testing."
        SessionDiagnostics.shared.record(component: "pip", event: "started")
    }

    func playerViewControllerDidStopPictureInPicture(_ playerViewController: AVPlayerViewController) {
        active = false
        status = "PiP stopped."
        SessionDiagnostics.shared.record(component: "pip", event: "stoppedBySystem")
        // The PiP close button must not leave hidden audio playing.
        if !presented { stop() }
    }

    func playerViewController(_ playerViewController: AVPlayerViewController,
                              failedToStartPictureInPictureWithError error: Error) {
        active = false
        status = "PiP could not start: \(error.localizedDescription)"
        SessionDiagnostics.shared.record(component: "pip", event: "startFailed")
    }

    func playerViewController(_ playerViewController: AVPlayerViewController,
        restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        if presented { completionHandler(true); return }
        restoreCompletion = completionHandler
        presented = true
    }

    func didPresentPlayer() {
        restoreCompletion?(true)
        restoreCompletion = nil
    }
}

private struct NativePiPPlayer: UIViewControllerRepresentable {
    let playback: PiPPlayback
    func makeUIViewController(context: Context) -> AVPlayerViewController { playback.controller }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {}
}

struct PiPExperimentView: View {
    @ObservedObject var playback: PiPPlayback
    @State private var importing = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Picture in Picture test", systemImage: "pip").font(.headline)
            Text("Plays a real movie from Files while you test hosting in another app. This does not guarantee background hosting and does not mirror the Tesla video.")
                .font(.footnote).foregroundStyle(.secondary)
            Text(playback.status).font(.footnote)
            HStack {
                Button("Choose movie", systemImage: "folder") { importing = true }
                    .disabled(playback.loading || playback.active)
                if playback.controller.player != nil {
                    Button("Open player") { playback.presented = true }
                    Button("Stop", role: .destructive) { playback.stop() }
                }
            }.buttonStyle(.bordered)
            if playback.loading { ProgressView() }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.movie]) { result in
            if case .success(let url) = result { playback.open(url) }
        }
    }
}

struct PiPPlayerPresentation: ViewModifier {
    @ObservedObject var playback: PiPPlayback
    func body(content: Content) -> some View {
        content.sheet(isPresented: $playback.presented, onDismiss: {
            if !playback.active { playback.stop() }
        }) {
            NavigationStack {
                NativePiPPlayer(playback: playback)
                    .onAppear { playback.didPresentPlayer() }
                    .navigationTitle("PiP test")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { playback.presented = false }
                        }
                    }
            }
        }
    }
}
