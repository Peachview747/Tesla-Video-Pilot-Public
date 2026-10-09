/// Decides when an experimental hosting audio engine may run. Native movie
/// playback owns the shared audio session exclusively while it is in use.
public struct KeepAlivePolicy {
    public var enabled = false
    public var hosting = false
    public var foreground = true
    public var nativePlayback = false
    public private(set) var interrupted = false

    public init() {}
    public var shouldRun: Bool {
        enabled && hosting && !foreground && !nativePlayback && !interrupted
    }
    public mutating func beginInterruption() { interrupted = true }
    public mutating func endInterruption(shouldResume: Bool) {
        interrupted = !shouldResume
    }
    public mutating func resetInterruption() { interrupted = false }
}
