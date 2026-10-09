import XCTest
@testable import MK8Core

final class KeepAliveTests: XCTestCase {
    private func backgroundHost() -> KeepAlivePolicy {
        var policy = KeepAlivePolicy()
        policy.enabled = true
        policy.hosting = true
        policy.foreground = false
        return policy
    }

    func testRequiresOptInAndBackgroundHosting() {
        var policy = KeepAlivePolicy()
        XCTAssertFalse(policy.shouldRun)
        policy.enabled = true
        policy.hosting = true
        XCTAssertFalse(policy.shouldRun, "Foreground hosting does not need silent audio")
        policy.foreground = false
        XCTAssertTrue(policy.shouldRun)
        policy.hosting = false
        XCTAssertFalse(policy.shouldRun, "Stopping hosting releases background audio")
        policy.hosting = true
        policy.enabled = false
        XCTAssertFalse(policy.shouldRun)
    }

    func testNativePlaybackHasExclusivePriority() {
        var policy = backgroundHost()
        policy.nativePlayback = true
        XCTAssertFalse(policy.shouldRun)
        policy.nativePlayback = false
        XCTAssertTrue(policy.shouldRun)
    }

    func testResumableInterruptionRestartsOnlyWhileStillNeeded() {
        var policy = backgroundHost()
        policy.beginInterruption()
        XCTAssertFalse(policy.shouldRun)
        policy.endInterruption(shouldResume: true)
        XCTAssertTrue(policy.shouldRun)
        policy.beginInterruption()
        policy.hosting = false
        policy.endInterruption(shouldResume: true)
        XCTAssertFalse(policy.shouldRun)
    }

    func testNonresumableInterruptionDoesNotFightOtherAudio() {
        var policy = backgroundHost()
        policy.beginInterruption()
        policy.endInterruption(shouldResume: false)
        XCTAssertFalse(policy.shouldRun)
        policy.resetInterruption()
        XCTAssertTrue(policy.shouldRun)
    }

    func testPiPEndDuringInterruptionDoesNotRestartEarly() {
        var policy = backgroundHost()
        policy.nativePlayback = true
        policy.beginInterruption()
        policy.nativePlayback = false
        XCTAssertFalse(policy.shouldRun)
        policy.endInterruption(shouldResume: true)
        XCTAssertTrue(policy.shouldRun)
        policy.foreground = true
        XCTAssertFalse(policy.shouldRun)
    }
}
