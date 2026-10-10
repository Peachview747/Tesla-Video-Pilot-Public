# perf progress log

(none yet)
- [x] Windowed relay pulls: phone advertises `x-mk8-relay-window: 16` on connect; Worker (WINDOW=6) grants several credits per pull (`{type:"pull",id,credits:n}`), prefetches right after the response header, hello carries `window`; legacy phones/Workers keep 1 credit per pull. Files: cloudflare/phone-relay.js, cloudflare/tests/relay.test.js, ios/Core/RelayBody.swift (RelayCredits.grant(count,limit)), ios/Core/RelayProtocol.swift, ios/App/PhoneTunnel.swift, ios/Tests/RelayTests.swift
