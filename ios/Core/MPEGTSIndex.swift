import Foundation

/// A small, sidecar-friendly index for the MPEG-TS files produced by Video
/// Pilot.  A byte/total-duration ratio is not a valid seek calculation for
/// MPEG-TS because the video bitrate is deliberately variable.  The index
/// records presentation timestamps from video PES headers and points back to
/// the most recent PAT packet so a new decoder sees the transport metadata it
/// needs before the selected video data.
public struct MPEGTSIndex: Codable, Sendable, Equatable {
    public struct Point: Codable, Sendable, Equatable {
        public let time: Double
        public let offset: Int64

        public init(time: Double, offset: Int64) {
            self.time = time
            self.offset = offset
        }
    }

    public let version: Int
    public let duration: Double?
    public let points: [Point]

    public init(duration: Double?, points: [Point], version: Int = 1) {
        self.version = version
        self.duration = duration
        self.points = points
    }

    /// Returns the closest indexed packet at or before the requested time.
    /// The first point is always a safe fallback when a caller asks for zero.
    public func point(for time: Double) -> Point? {
        guard !points.isEmpty else { return nil }
        let target = time.isFinite ? max(0, time) : 0
        var low = 0
        var high = points.count
        while low < high {
            let middle = (low + high) / 2
            if points[middle].time <= target { low = middle + 1 }
            else { high = middle }
        }
        return points[max(0, low - 1)]
    }

    /// Scans a packet-aligned MPEG-TS file. The scan is intentionally
    /// bounded to one packet at a time, so large videos do not get loaded into
    /// memory just to make seeking accurate.
    public static func build(file url: URL, pointInterval: Double = 0.25) throws -> Self {
        guard pointInterval.isFinite, pointInterval > 0 else { throw Failure.invalidInterval }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }

        var pending = Data()
        pending.reserveCapacity(188 * 4096)
        var fileOffset: Int64 = 0
        var sawPacket = false
        var lastPATOffset: Int64 = 0
        var contextFirstVideoTime: Double?
        var firstPTS: Int64?
        var previousPTS: Int64?
        var lastVideoTime = 0.0
        var lastPointTime = -Double.infinity
        var previousVideoTime: Double?
        var frameDelta = 1.0 / 30.0
        var points = [Point]()

        func addVideoPTS(_ raw: UInt64, packetOffset: Int64) {
            let unwrapped: Int64
            if let previousPTS {
                let wrap = Int64(1) << 33
                let half = wrap / 2
                var candidate = Int64(raw)
                let delta = candidate - previousPTS
                if delta < -half { candidate += wrap }
                else if delta > half { candidate -= wrap }
                unwrapped = candidate
            } else { unwrapped = Int64(raw) }
            previousPTS = unwrapped
            if firstPTS == nil { firstPTS = unwrapped }
            guard let firstPTS else { return }
            let time = max(0, Double(unwrapped - firstPTS) / 90_000.0)
            if let previousVideoTime {
                let delta = time - previousVideoTime
                if delta > 0.001, delta < 2 { frameDelta = min(1, max(1.0 / 120.0, delta)) }
            }
            previousVideoTime = time
            lastVideoTime = max(lastVideoTime, time)
            // The response starts at the PAT context, not at this PES packet.
            // Report the timestamp of the first video PES after that PAT so
            // the browser's relative JSMpeg clock is not offset by the
            // decoder pre-roll packets we intentionally include.
            if contextFirstVideoTime == nil { contextFirstVideoTime = time }
            if let contextFirstVideoTime,
               points.isEmpty || contextFirstVideoTime - lastPointTime >= pointInterval {
                points.append(Point(time: contextFirstVideoTime, offset: lastPATOffset))
                lastPointTime = contextFirstVideoTime
            }
            _ = packetOffset // Retained in the closure signature for clarity.
        }

        while let chunk = try handle.read(upToCount: 188 * 4096), !chunk.isEmpty {
            pending.append(chunk)
            var consumed = 0
            while pending.count - consumed >= 188 {
                guard pending[pending.startIndex + consumed] == 0x47 else { throw Failure.notTransportStream }
                let packet = Array(pending[(pending.startIndex + consumed)..<(pending.startIndex + consumed + 188)])
                let packetOffset = fileOffset + Int64(consumed)
                sawPacket = true
                let pid = (Int(packet[1] & 0x1f) << 8) | Int(packet[2])
                let payloadUnitStart = (packet[1] & 0x40) != 0
                let adaptationControl = (packet[3] >> 4) & 0x03
                var payloadStart = 4
                if adaptationControl == 0 { throw Failure.notTransportStream }
                if adaptationControl == 2 { payloadStart = 188 }
                else if adaptationControl == 3 {
                    let length = Int(packet[4])
                    payloadStart = 5 + length
                    guard payloadStart <= 188 else { throw Failure.notTransportStream }
                }
                if pid == 0, payloadUnitStart {
                    lastPATOffset = packetOffset
                    contextFirstVideoTime = nil
                }
                if payloadUnitStart, payloadStart < 188 {
                    let payload = Array(packet[payloadStart..<188])
                    // PES video stream IDs are E0-EF. The first packet of a
                    // PES contains the complete 14-byte timestamp header in
                    // all streams emitted by FFmpeg; malformed/short packets
                    // are simply skipped and the next indexed frame remains a
                    // safe fallback.
                    if payload.count >= 14,
                       payload[0] == 0, payload[1] == 0, payload[2] == 1,
                       payload[3] >= 0xe0, payload[3] <= 0xef {
                        let flags = (payload[7] >> 6) & 0x03
                        let headerLength = Int(payload[8])
                        if flags >= 2, headerLength >= 5, payload.count >= 14 {
                            let timestamp = decodePTS(payload, start: 9)
                            addVideoPTS(timestamp, packetOffset: packetOffset)
                        }
                    }
                }
                consumed += 188
            }
            if consumed > 0 {
                pending.removeSubrange(0..<consumed)
                fileOffset += Int64(consumed)
            }
        }
        guard pending.isEmpty, sawPacket else { throw Failure.notTransportStream }
        if points.isEmpty { return Self(duration: nil, points: []) }
        if lastVideoTime > points.last!.time {
            points.append(Point(time: lastVideoTime, offset: lastPATOffset))
        }
        let duration = max(points.last?.time ?? 0, lastVideoTime) + frameDelta
        return Self(duration: duration > 0 ? duration : nil, points: points)
    }

    public enum Failure: Error, Equatable {
        case invalidInterval
        case notTransportStream
    }

    private static func decodePTS(_ bytes: [UInt8], start: Int) -> UInt64 {
        guard start >= 0, start + 4 < bytes.count else { return 0 }
        return (UInt64(bytes[start] & 0x0e) << 29)
            | (UInt64(bytes[start + 1]) << 22)
            | (UInt64(bytes[start + 2] & 0xfe) << 14)
            | (UInt64(bytes[start + 3]) << 7)
            | UInt64((bytes[start + 4] & 0xfe) >> 1)
    }
}
