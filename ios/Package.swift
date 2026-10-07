// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MK8Core",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "MK8Core", targets: ["MK8Core"])],
    targets: [
        .target(name: "MK8Core", path: "Core"),
        .testTarget(name: "MK8CoreTests", dependencies: ["MK8Core"], path: "Tests")
    ]
)
